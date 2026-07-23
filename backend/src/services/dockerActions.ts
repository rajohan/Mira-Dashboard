import { errorMessage } from "../lib/errors.ts";
import {
    type BunProcess,
    killProcessGroup,
    pipeProcessOutput,
    runProcess,
    spawnProcess,
} from "../lib/processes.ts";
import { nonEmptyEnvironmentFallback } from "../lib/values.ts";
import {
    registerScheduledJobAction,
    type ScheduledJobActionContext,
    ScheduledJobActionError,
} from "./scheduledJobs.ts";

const MAX_OUTPUT_CHARS = 100_000;
const MAX_EXEC_COMMAND_CHARS = 16_384;
const DOCKER_REQUEST_TIMEOUT_MS = 30_000;
const DOCKER_EXEC_TIMEOUT_MS = 7 * 60 * 60 * 1000;
const STREAM_UPDATE_INTERVAL_MS = 250;

function dockerBin(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_BIN", "docker");
}

function dockerRoot(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_ROOT", "/opt/docker");
}

function dockerComposeWrapper(): string {
    return nonEmptyEnvironmentFallback(
        "MIRA_DOCKER_COMPOSE_WRAPPER",
        `${dockerRoot()}/bin/docker-compose-doppler`
    );
}

function trimOutput(text: string): string {
    return text.length <= MAX_OUTPUT_CHARS ? text : text.slice(-MAX_OUTPUT_CHARS);
}

function requiredIdentifier(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
        throw Object.assign(new Error(`Invalid ${label}`), { statusCode: 400 });
    }
    return value;
}

function requiredImageIdentifier(value: unknown): string {
    if (typeof value === "string" && /^sha256:[a-f0-9]{64}$/iu.test(value)) {
        return value;
    }
    return requiredIdentifier(value, "imageId");
}

export async function runDockerCommand(
    arguments_: string[],
    signal?: AbortSignal
): Promise<string> {
    const { code, stderr, stdout } = await runProcess(dockerBin(), arguments_, {
        cwd: dockerRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
        signal,
        timeoutMs: DOCKER_REQUEST_TIMEOUT_MS,
    });
    if (code !== 0) {
        throw new Error(
            `docker ${arguments_.join(" ")} failed with exit code ${code}: ${
                stderr.trim() || stdout.trim()
            }`
        );
    }
    return String(stdout);
}

export async function runDockerComposeCommand(
    arguments_: string[],
    signal?: AbortSignal
): Promise<{ stderr: string; stdout: string }> {
    const result = await runProcess(dockerComposeWrapper(), arguments_, {
        cwd: dockerRoot(),
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
        signal,
        timeoutMs: DOCKER_REQUEST_TIMEOUT_MS,
    });
    if (result.code !== 0) {
        throw new Error(
            `docker compose ${arguments_.join(" ")} failed with exit code ${
                result.code
            }: ${result.stderr.trim() || result.stdout.trim()}`
        );
    }
    return { stderr: result.stderr, stdout: result.stdout };
}

async function terminateContainerProcess(
    containerId: string,
    containerPid: number | undefined
): Promise<void> {
    if (!containerPid) return;
    try {
        await runDockerCommand([
            "exec",
            containerId,
            "kill",
            "-TERM",
            `-${containerPid}`,
        ]);
    } catch (groupError) {
        try {
            await runDockerCommand([
                "exec",
                containerId,
                "kill",
                "-TERM",
                String(containerPid),
            ]);
        } catch (processError) {
            console.warn(
                "[Docker] In-container cancellation failed:",
                errorMessage(groupError, "process group kill failed"),
                errorMessage(processError, "process kill failed")
            );
        }
    }
}

async function executeDockerCommand(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
    context: ScheduledJobActionContext
): Promise<Record<string, unknown>> {
    const containerId = requiredIdentifier(payload.containerId, "containerId");
    const command = payload.command;
    if (
        typeof command !== "string" ||
        command.trim() === "" ||
        command.length > MAX_EXEC_COMMAND_CHARS ||
        command.includes("\0")
    ) {
        throw Object.assign(new Error("Invalid Docker exec command"), {
            statusCode: 400,
        });
    }

    const startedAt = Date.now();
    const pidMarker = `__MIRA_DOCKER_EXEC_PID_${context.executionId}:`;
    let containerPid: number | undefined;
    let stdout = "";
    let stderr = "";
    let stdoutPrefix = "";
    let lastPublishedAt = 0;
    const publish = (isForced = false) => {
        const timestamp = Date.now();
        if (!isForced && timestamp - lastPublishedAt < STREAM_UPDATE_INTERVAL_MS) return;
        lastPublishedAt = timestamp;
        context.updateOutput({
            containerId,
            containerPid,
            endedAt: undefined,
            startedAt,
            status: "running",
            stderr,
            stdout,
        });
    };
    publish(true);

    let child: BunProcess;
    try {
        child = spawnProcess(
            dockerBin(),
            [
                "exec",
                "-e",
                `MIRA_DASHBOARD_EXEC_COMMAND=${command}`,
                containerId,
                "sh",
                "-lc",
                String.raw`if command -v setsid >/dev/null 2>&1; then exec setsid sh -lc 'printf '\''${pidMarker}%s\n'\'' "$$"; exec sh -lc "$MIRA_DASHBOARD_EXEC_COMMAND"'; fi; printf '${pidMarker}%s\n' "$$"; exec sh -lc "$MIRA_DASHBOARD_EXEC_COMMAND"`,
            ],
            {
                cwd: dockerRoot(),
                env: process.env,
                signal,
            }
        );
    } catch (error) {
        throw new ScheduledJobActionError("Docker exec failed", {
            code: 1,
            containerId,
            endedAt: Date.now(),
            startedAt,
            status: "done",
            stderr: errorMessage(error, "Docker exec failed"),
            stdout,
        });
    }
    const abort = () => {
        void terminateContainerProcess(containerId, containerPid);
        try {
            killProcessGroup(child, "SIGTERM");
        } catch {
            // The Docker CLI may already have exited.
        }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    const stdoutDone = pipeProcessOutput(
        child.stdout as ReadableStream<Uint8Array> | undefined,
        (data) => {
            const output = stdoutPrefix + String(data);
            const newlineIndex = output.indexOf("\n");
            if (newlineIndex === -1 && containerPid === undefined) {
                stdoutPrefix = output;
                return;
            }
            let userOutput = output;
            if (containerPid === undefined) {
                const firstLine = output.slice(0, newlineIndex).trim();
                if (firstLine.startsWith(pidMarker)) {
                    const pid = Number(firstLine.slice(pidMarker.length));
                    if (Number.isSafeInteger(pid) && pid > 0) containerPid = pid;
                    userOutput = output.slice(newlineIndex + 1);
                }
                stdoutPrefix = "";
            }
            stdout = trimOutput(stdout + userOutput);
            publish();
        }
    );
    const stderrDone = pipeProcessOutput(
        child.stderr as ReadableStream<Uint8Array> | undefined,
        (data) => {
            stderr = trimOutput(stderr + String(data));
            publish();
        }
    );

    let code: number;
    try {
        code = await child.exited;
        await Promise.all([stdoutDone, stderrDone]);
    } catch (error) {
        stderr = trimOutput(
            `${stderr}\n${errorMessage(error, "Docker exec failed")}`.trim()
        );
        throw new ScheduledJobActionError("Docker exec failed", {
            code: 1,
            containerId,
            containerPid,
            endedAt: Date.now(),
            startedAt,
            status: "done",
            stderr,
            stdout,
        });
    } finally {
        signal?.removeEventListener("abort", abort);
    }
    const output = {
        code,
        containerId,
        containerPid,
        endedAt: Date.now(),
        startedAt,
        status: "done",
        stderr,
        stdout,
    };
    if (code !== 0) {
        throw new ScheduledJobActionError("Docker exec exited non-zero", output);
    }
    return output;
}

export function registerDockerExecutionActions(): void {
    registerScheduledJobAction("docker.stack.action", async (job, signal, context) => {
        const action = job.actionPayload.action;
        if (action !== "restart" && action !== "start" && action !== "stop") {
            throw Object.assign(new Error("Invalid stack action"), { statusCode: 400 });
        }
        const service = job.actionPayload.service;
        const arguments_: string[] = [action];
        if (service !== undefined) {
            arguments_.push(requiredIdentifier(service, "service name"));
        }
        context.protectFromCancellation();
        const result = await runDockerComposeCommand(arguments_, signal);
        return {
            ...result,
            output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
        };
    });
    registerScheduledJobAction(
        "docker.container.action",
        async (job, signal, context) => {
            const action = job.actionPayload.action;
            if (action !== "restart" && action !== "start" && action !== "stop") {
                throw Object.assign(new Error("Invalid container action"), {
                    statusCode: 400,
                });
            }
            const containerId = requiredIdentifier(
                job.actionPayload.containerId,
                "containerId"
            );
            context.protectFromCancellation();
            return { output: await runDockerCommand([action, containerId], signal) };
        }
    );
    registerScheduledJobAction("docker.image.delete", async (job, signal, context) => {
        const imageId = requiredImageIdentifier(job.actionPayload.imageId);
        context.protectFromCancellation();
        return {
            output: await runDockerCommand(["image", "rm", imageId], signal),
        };
    });
    registerScheduledJobAction("docker.prune.images", async (_job, signal, context) => {
        context.protectFromCancellation();
        return {
            output: await runDockerCommand(["image", "prune", "-a", "-f"], signal),
        };
    });
    registerScheduledJobAction("docker.prune.volumes", async (_job, signal, context) => {
        context.protectFromCancellation();
        return {
            output: await runDockerCommand(["volume", "prune", "-f"], signal),
        };
    });
    registerScheduledJobAction("docker.volume.delete", async (job, signal, context) => {
        const volumeName = requiredIdentifier(job.actionPayload.volumeName, "volumeName");
        context.protectFromCancellation();
        return {
            output: await runDockerCommand(["volume", "rm", volumeName], signal),
        };
    });
    registerScheduledJobAction(
        "docker.exec",
        (job, signal, context) =>
            executeDockerCommand(job.actionPayload, signal, context),
        { timeoutMs: DOCKER_EXEC_TIMEOUT_MS }
    );
}
