import fs from "node:fs";
import path from "node:path";

import { database } from "../database.ts";
import { errorMessage } from "../lib/errors.ts";
import {
    type BunProcess,
    killProcessGroup,
    pipeProcessOutput,
    spawnProcess,
} from "../lib/processes.ts";
import {
    cancelJobExecution,
    enqueueJobExecution,
    getJobExecution,
    type JobExecution,
} from "./jobExecutionQueue.ts";
import {
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "./queuedJobExecution.ts";
import { registerScheduledJobAction, ScheduledJobActionError } from "./scheduledJobs.ts";

const OPS_SHELL_COMMANDS = new Set([
    "__mira_dashboard_shell_smoke_test__",
    "sudo reboot",
    "sudo apt-get autoremove -y && sudo apt-get autoclean -y && sudo journalctl --vacuum-time=14d && sudo docker system prune -af",
    "bash -lc 'sudo DEBIAN_FRONTEND=noninteractive apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y; apt_status=$?; sudo DEBIAN_FRONTEND=noninteractive dpkg --configure -a; dpkg_status=$?; if [ $apt_status -ne 0 ]; then exit $apt_status; fi; exit $dpkg_status'",
    "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}; export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}; $HOME/.local/bin/openclaw gateway restart",
    "find $HOME/.openclaw/agents -type f -path '*/sessions/*' -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/agents -type d -path '*/sessions/*' -empty -delete 2>/dev/null || true; find $HOME/.openclaw/media -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/workspace/images -type f -mtime +30 -delete 2>/dev/null || true; find $HOME/.openclaw/tmp -type f -mtime +7 -delete 2>/dev/null || true; find $HOME/.openclaw/delivery-queue/failed -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/completions -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/cron/runs -type f -mtime +30 -delete 2>/dev/null || true; find $HOME/.openclaw/logs -type f -mtime +14 -delete 2>/dev/null || true",
    "$HOME/.local/bin/openclaw update --yes",
]);

export interface ExecRequest {
    args?: string[];
    command: string;
    cwd?: string;
    shell?: boolean;
}

export interface ExecResponse {
    code: number | undefined;
    stderr: string;
    stdout: string;
}

export interface ExecStartResponse {
    jobId: string;
}

type ExecRequestMode = "once" | "start";

export interface ExecJobResponse {
    code: number | undefined;
    endedAt: number | undefined;
    jobId: string;
    startedAt: number;
    status: "running" | "signaled" | "done";
    stderr: string;
    stdout: string;
}

class ExecValidationError extends Error {
    readonly statusCode = 400;

    constructor(message: string) {
        super(message);
        this.name = "ExecValidationError";
    }
}

const MAX_COMMAND_LENGTH = 4096;
const SHELL_METACHARACTERS_RE = /[\n\r\0]/u;
const EXECUTABLE_RE = /^(?:[\w./-]+)$/u;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_JOBS = 100;
const EXEC_ONCE_TIMEOUT_MS = 60_000;
const ALLOWED_DIRECT_EXECUTABLES = new Set<string>(["bash"]);
const BASH_LOGIN_COMMAND_ARGUMENTS = 2;
const TRACKED_EXEC_TIMEOUT_MS = 7 * 60 * 60 * 1000;
const STREAM_UPDATE_INTERVAL_MS = 250;

function trimOutput(text: string): string {
    return text.length <= MAX_OUTPUT_CHARS ? text : text.slice(-MAX_OUTPUT_CHARS);
}

function validateBashArguments(arguments_: string[]): void {
    if (
        arguments_.length !== BASH_LOGIN_COMMAND_ARGUMENTS ||
        arguments_[0] !== "-lc" ||
        typeof arguments_[1] !== "string" ||
        arguments_[1].length === 0
    ) {
        throw new ExecValidationError("bash args must be exactly: -lc <command>");
    }
    if (arguments_[1].length > MAX_COMMAND_LENGTH) {
        throw new ExecValidationError(
            `command exceeds maximum length of ${MAX_COMMAND_LENGTH}`
        );
    }
    if (SHELL_METACHARACTERS_RE.test(arguments_[1])) {
        throw new ExecValidationError("command contains disallowed control characters");
    }
}

function validateExecRequest(payload: unknown, mode: ExecRequestMode): ExecRequest {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new ExecValidationError("request body must be a JSON object");
    }

    const { args, command, cwd, shell } = payload as ExecRequest;
    if (!command || typeof command !== "string") {
        throw new ExecValidationError("command must be a non-empty string");
    }
    if (command.length > MAX_COMMAND_LENGTH) {
        throw new ExecValidationError(
            `command exceeds maximum length of ${MAX_COMMAND_LENGTH}`
        );
    }
    if (SHELL_METACHARACTERS_RE.test(command)) {
        throw new ExecValidationError("command contains disallowed control characters");
    }
    if (shell !== undefined && typeof shell !== "boolean") {
        throw new ExecValidationError("shell must be a boolean");
    }
    if (args !== undefined && shell) {
        throw new ExecValidationError("args cannot be combined with shell mode");
    }
    if (shell && !OPS_SHELL_COMMANDS.has(command)) {
        throw new ExecValidationError(
            "shell mode is only available for approved ops commands"
        );
    }
    if (!shell && args === undefined) {
        throw new ExecValidationError("args are required unless shell mode is enabled");
    }
    if (args !== undefined && !EXECUTABLE_RE.test(command)) {
        throw new ExecValidationError(
            "command must be an executable name when args are provided"
        );
    }
    if (args !== undefined && path.basename(command) !== command) {
        throw new ExecValidationError("command must be an approved executable name");
    }
    if (args !== undefined && !Array.isArray(args)) {
        throw new ExecValidationError("args must be an array");
    }
    if (args) {
        for (const argument of args) {
            if (typeof argument !== "string") {
                throw new ExecValidationError("all args must be strings");
            }
            if (argument.includes("\0")) {
                throw new ExecValidationError("args cannot contain null bytes");
            }
        }
    }
    const executable = path.basename(command);
    if (args !== undefined && !ALLOWED_DIRECT_EXECUTABLES.has(executable)) {
        throw new ExecValidationError("command executable is not approved");
    }
    if (args !== undefined && executable === "bash") {
        if (mode !== "start") {
            throw new ExecValidationError("bash argv execution requires job tracking");
        }
        validateBashArguments(args);
    }
    if (cwd !== undefined && typeof cwd !== "string") {
        throw new ExecValidationError("cwd must be a string");
    }
    return { args, command, cwd: resolveCwd(cwd), shell };
}

function resolveCwd(cwd: string | undefined): string {
    if (!cwd) return process.cwd();
    if (cwd.includes("\0") || !path.isAbsolute(cwd)) {
        throw new ExecValidationError("cwd must be an absolute path");
    }
    try {
        const resolvedCwd = fs.realpathSync(cwd);
        if (!fs.statSync(resolvedCwd).isDirectory()) {
            throw new ExecValidationError("cwd must be a directory");
        }
        return resolvedCwd;
    } catch (error) {
        if (error instanceof ExecValidationError) {
            throw error;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            throw new ExecValidationError("cwd does not exist");
        }
        throw error;
    }
}

function getApprovedShellCommand(command: string): string {
    if (!OPS_SHELL_COMMANDS.has(command)) {
        throw new ExecValidationError(
            "shell mode is only available for approved ops commands"
        );
    }
    return command;
}

export function execErrorResponse(error: unknown): { error: string; status: number } {
    if (error instanceof ExecValidationError) {
        return { error: error.message, status: 400 };
    }
    if (error !== undefined && error !== null) {
        const statusCode = Number((error as { statusCode?: unknown }).statusCode);
        if (Number.isSafeInteger(statusCode) && statusCode >= 400 && statusCode < 600) {
            return { error: errorMessage(error, "request failed"), status: statusCode };
        }
    }
    const message =
        error instanceof Error
            ? error.message
            : error === undefined || error === null
              ? "Unknown error"
              : String(error);
    console.error("[Exec] Route error:", message);
    return { error: "internal server error", status: 500 };
}

function runExecCommand(
    request: ExecRequest,
    onUpdate?: (update: Pick<ExecResponse, "stderr" | "stdout">) => void,
    timeoutMs?: number,
    signal?: AbortSignal
): Promise<ExecResponse> {
    const { args, command, cwd, shell } = request;
    const cwdOption = {
        cwd: resolveCwd(cwd),
        detached: true,
        env: process.env,
        signal,
    };
    let childFactory: () => BunProcess;
    if (shell) {
        childFactory = () =>
            spawnProcess("/bin/sh", ["-c", getApprovedShellCommand(command)], cwdOption);
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
            console.error("[Exec] Process group kill failed:", message);
            stderr = trimOutput(`${stderr}\n${message}`.trim());
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
                stdout = trimOutput(stdout + String(data));
                outputUpdate();
            }
        );
        const stderrDone = pipeProcessOutput(
            child.stderr as ReadableStream<Uint8Array> | undefined,
            (data) => {
                stderr = trimOutput(stderr + String(data));
                outputUpdate();
            }
        );
        void (async () => {
            const code = await child.exited;
            await Promise.all([stdoutDone, stderrDone]);
            return code;
        })()
            .then((code) => {
                signal?.removeEventListener("abort", abortFromSignal);
                if (timeout) clearTimeout(timeout);
                if (forceKillTimeout) clearTimeout(forceKillTimeout);
                resolve({
                    code: didTimeout && code === 0 ? 1 : code,
                    stderr,
                    stdout,
                });
            })
            .catch((error: unknown) => {
                signal?.removeEventListener("abort", abortFromSignal);
                if (timeout) clearTimeout(timeout);
                if (forceKillTimeout) clearTimeout(forceKillTimeout);
                reject(error);
            });
    });
}

function outputString(output: Record<string, unknown>, key: string): string {
    return typeof output[key] === "string" ? output[key] : "";
}

function outputNumber(output: Record<string, unknown>, key: string): number | undefined {
    return typeof output[key] === "number" && Number.isFinite(output[key])
        ? output[key]
        : undefined;
}

function execResponseFromExecution(execution: JobExecution): ExecResponse {
    const output = execution.output;
    if (typeof output.stdout !== "string" || typeof output.stderr !== "string") {
        successfulJobExecutionOutput(execution);
    }
    return {
        code: outputNumber(output, "code"),
        stderr: outputString(output, "stderr").slice(-10_000),
        stdout: outputString(output, "stdout").slice(-10_000),
    };
}

async function executeCommandInWorker(
    payload: Record<string, unknown>,
    mode: ExecRequestMode,
    signal: AbortSignal | undefined,
    updateOutput: (output: Record<string, unknown>) => void
): Promise<Record<string, unknown>> {
    const request = validateExecRequest(payload.request, mode);
    const startedAt = Date.now();
    let lastPublishedAt = 0;
    let latestOutput = { stderr: "", stdout: "" };
    const publish = (
        update: Pick<ExecResponse, "stderr" | "stdout">,
        isForced = false
    ) => {
        const timestamp = Date.now();
        if (!isForced && timestamp - lastPublishedAt < STREAM_UPDATE_INTERVAL_MS) return;
        lastPublishedAt = timestamp;
        updateOutput({
            endedAt: undefined,
            startedAt,
            status: "running",
            stderr: update.stderr,
            stdout: update.stdout,
        });
    };
    publish(latestOutput, true);
    let result: ExecResponse;
    try {
        result = await runExecCommand(
            request,
            (update) => {
                latestOutput = update;
                publish(update);
            },
            mode === "once" ? EXEC_ONCE_TIMEOUT_MS : undefined,
            signal
        );
    } catch (error) {
        const output = {
            code: 1,
            endedAt: Date.now(),
            startedAt,
            status: "done",
            stderr: trimOutput(
                `${latestOutput.stderr}\n${errorMessage(error, "Tracked command failed")}`.trim()
            ),
            stdout: latestOutput.stdout,
        };
        throw new ScheduledJobActionError("Tracked command failed", output);
    }
    const output = {
        code: result.code,
        endedAt: Date.now(),
        startedAt,
        status: "done",
        stderr: result.stderr,
        stdout: result.stdout,
    };
    publish(result, true);
    if (result.code !== 0) {
        throw new ScheduledJobActionError("Tracked command exited non-zero", output);
    }
    return output;
}

export function registerExecExecutionActions(): void {
    registerScheduledJobAction(
        "exec.once",
        (job, signal, context) =>
            executeCommandInWorker(
                job.actionPayload,
                "once",
                signal,
                context.updateOutput
            ),
        { timeoutMs: EXEC_ONCE_TIMEOUT_MS }
    );
    registerScheduledJobAction(
        "exec.tracked",
        (job, signal, context) =>
            executeCommandInWorker(
                job.actionPayload,
                "start",
                signal,
                context.updateOutput
            ),
        { timeoutMs: TRACKED_EXEC_TIMEOUT_MS }
    );
}

export async function runExecOnce(payload: unknown): Promise<ExecResponse> {
    const request = validateExecRequest(payload, "once");
    const execution = enqueueJobExecution({
        actionKey: "exec.once",
        displayName: "Tracked ops command",
        payload: { request },
        resourceClass: "exclusive",
        timeoutMs: EXEC_ONCE_TIMEOUT_MS,
    });
    return execResponseFromExecution(
        await waitForJobExecution(execution.id, {
            timeoutMs: EXEC_ONCE_TIMEOUT_MS + 30 * 60 * 1000,
        })
    );
}

function activeTrackedExecCount(): number {
    const row = database
        .prepare(
            `SELECT COUNT(*) AS count
             FROM job_executions
             WHERE action_key = 'exec.tracked'
               AND status IN ('queued', 'running')`
        )
        .get() as { count: number };
    return row.count;
}

export function startExecJob(payload: unknown): ExecStartResponse {
    if (activeTrackedExecCount() >= MAX_JOBS) {
        throw Object.assign(new Error("Too many exec jobs"), { statusCode: 429 });
    }
    const request = validateExecRequest(payload, "start");
    const execution = enqueueJobExecution({
        actionKey: "exec.tracked",
        displayName: "Tracked shell job",
        payload: { request },
        resourceClass: "exclusive",
        timeoutMs: TRACKED_EXEC_TIMEOUT_MS,
    });
    return { jobId: execution.id };
}

function trackedExecExecution(jobId: string): JobExecution {
    const execution = getJobExecution(jobId);
    if (!execution || execution.actionKey !== "exec.tracked") {
        throw Object.assign(new Error("Exec job not found"), { statusCode: 404 });
    }
    return execution;
}

export function stopExecJob(jobId: string): { isSuccess: boolean; message: string } {
    const execution = trackedExecExecution(jobId);
    if (execution.status !== "queued" && execution.status !== "running") {
        throw Object.assign(new Error("Job is not running"), { statusCode: 400 });
    }
    cancelJobExecution(jobId);
    return { isSuccess: true, message: "Stop signal sent" };
}

export function getExecJob(jobId: string): ExecJobResponse {
    const execution = trackedExecExecution(jobId);
    const output = execution.output;
    const isTerminal = ["success", "failed", "cancelled"].includes(execution.status);
    return {
        code: outputNumber(output, "code"),
        endedAt: isTerminal
            ? (outputNumber(output, "endedAt") ??
              (execution.finishedAt ? Date.parse(execution.finishedAt) : undefined))
            : undefined,
        jobId: execution.id,
        startedAt:
            outputNumber(output, "startedAt") ??
            Date.parse(execution.startedAt ?? execution.queuedAt),
        status: isTerminal
            ? "done"
            : execution.cancelRequestedAt
              ? "signaled"
              : "running",
        stderr: outputString(output, "stderr"),
        stdout: outputString(output, "stdout"),
    };
}
