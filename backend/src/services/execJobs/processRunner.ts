import type { ExecRequest, ExecResponse } from "../../../../contracts/exec.ts";
import { errorMessage } from "../../lib/errors.ts";
import {
    type BunProcess,
    killProcessGroup,
    pipeProcessOutput,
    spawnProcess,
} from "../../lib/processes.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import {
    ExecValidationError,
    requireApprovedShellCommand,
    resolveExecCwd,
} from "./requestPolicy.ts";

const logger = createStructuredLogger("exec-jobs");
const MAX_OUTPUT_CHARS = 100_000;

export function trimExecOutput(text: string): string {
    return text.length <= MAX_OUTPUT_CHARS ? text : text.slice(-MAX_OUTPUT_CHARS);
}

export function runExecCommand(
    request: ExecRequest,
    onUpdate?: (update: Pick<ExecResponse, "stderr" | "stdout">) => void,
    timeoutMs?: number,
    signal?: AbortSignal
): Promise<ExecResponse> {
    const { args, command, cwd, shell } = request;
    const cwdOption = {
        cwd: resolveExecCwd(cwd),
        detached: true,
        env: process.env,
        signal,
    };
    let childFactory: () => BunProcess;
    if (shell) {
        childFactory = () =>
            spawnProcess(
                "/bin/sh",
                ["-c", requireApprovedShellCommand(command)],
                cwdOption
            );
    } else if (Array.isArray(args)) {
        const commandParts = { args, executable: command };
        childFactory = () =>
            spawnProcess(commandParts.executable, commandParts.args, cwdOption);
    } else {
        childFactory = () => {
            throw new ExecValidationError("invalid exec request state");
        };
    }

    return new Promise((resolve, reject) => {
        const child = childFactory();
        let stdout = "";
        let stderr = "";
        const recordKillError = (signal: NodeJS.Signals, error: unknown) => {
            const message = errorMessage(error, `Failed to send ${signal}`);
            logger.error("exec.process_group_kill_failed", {
                error,
                signal,
            });
            stderr = trimExecOutput(`${stderr}\n${message}`.trim());
            onUpdate?.({ stderr, stdout });
        };
        let timeout: Timer | undefined;
        let forceKillTimeout: Timer | undefined;
        let didTimeout = false;
        const terminate = () => {
            try {
                killProcessGroup(child, "SIGTERM");
            } catch (error) {
                recordKillError("SIGTERM", error);
            }
            if (!forceKillTimeout) {
                forceKillTimeout = setTimeout(() => {
                    try {
                        killProcessGroup(child, "SIGKILL");
                    } catch (error) {
                        recordKillError("SIGKILL", error);
                    }
                }, 3000);
                forceKillTimeout.unref();
            }
        };
        const abortFromSignal = () => terminate();
        signal?.addEventListener("abort", abortFromSignal, { once: true });
        if (timeoutMs !== undefined) {
            timeout = setTimeout(() => {
                didTimeout = true;
                terminate();
            }, timeoutMs);
            timeout.unref();
        }
        const outputUpdate = () => onUpdate?.({ stderr, stdout });
        const stdoutDone = pipeProcessOutput(
            child.stdout as ReadableStream<Uint8Array> | undefined,
            (data) => {
                stdout = trimExecOutput(stdout + String(data));
                outputUpdate();
            }
        );
        const stderrDone = pipeProcessOutput(
            child.stderr as ReadableStream<Uint8Array> | undefined,
            (data) => {
                stderr = trimExecOutput(stderr + String(data));
                outputUpdate();
            }
        );
        void (async () => {
            try {
                const code = await child.exited;
                await Promise.all([stdoutDone, stderrDone]);
                signal?.removeEventListener("abort", abortFromSignal);
                if (timeout) clearTimeout(timeout);
                if (forceKillTimeout) clearTimeout(forceKillTimeout);
                resolve({
                    code: didTimeout && code === 0 ? 1 : code,
                    stderr,
                    stdout,
                });
            } catch (error) {
                signal?.removeEventListener("abort", abortFromSignal);
                if (timeout) clearTimeout(timeout);
                if (forceKillTimeout) clearTimeout(forceKillTimeout);
                reject(
                    error instanceof Error
                        ? error
                        : new Error("Exec process failed", { cause: error })
                );
            }
        })();
    });
}
