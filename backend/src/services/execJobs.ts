import fs from "node:fs";
import path from "node:path";

import { errorMessage } from "../lib/errors.ts";
import {
    type BunProcess,
    killProcessGroup,
    pipeProcessOutput,
    spawnProcess,
} from "../lib/processes.ts";

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
    code: number | null;
    stderr: string;
    stdout: string;
}

export interface ExecStartResponse {
    jobId: string;
}

export interface ExecJobResponse {
    code: number | null;
    endedAt: number | null;
    jobId: string;
    startedAt: number;
    status: "running" | "signaled" | "done";
    stderr: string;
    stdout: string;
}

class ExecValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ExecValidationError";
    }
}

interface ExecJob {
    closePending?: boolean;
    code: number | null;
    endedAt: number | null;
    id: string;
    process?: BunProcess;
    startedAt: number;
    status: "running" | "signaled" | "done";
    stderr: string;
    stdout: string;
}

const MAX_COMMAND_LENGTH = 4096;
const SHELL_METACHARACTERS_RE = /[\n\r\0]/u;
const EXECUTABLE_RE = /^(?:[\w./-]+)$/u;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_JOBS = 100;
const EXEC_ONCE_TIMEOUT_MS = 60_000;
const ALLOWED_DIRECT_EXECUTABLES = new Set(["docker", "git", "openclaw"]);
const jobs = new Map<string, ExecJob>();

function trimOutput(text: string): string {
    return text.length <= MAX_OUTPUT_CHARS ? text : text.slice(-MAX_OUTPUT_CHARS);
}

function validateExecRequest(payload: unknown): ExecRequest {
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
    if (args !== undefined && !ALLOWED_DIRECT_EXECUTABLES.has(path.basename(command))) {
        throw new ExecValidationError("command executable is not approved");
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
    if (cwd !== undefined && typeof cwd !== "string") {
        throw new ExecValidationError("cwd must be a string");
    }
    return { args, command, cwd, shell };
}

function resolveCwd(cwd: string | undefined): string {
    if (!cwd) return process.cwd();
    if (cwd.includes("\0") || !path.isAbsolute(cwd)) {
        throw new ExecValidationError("cwd must be an absolute path");
    }
    try {
        return fs.realpathSync(cwd);
    } catch (error) {
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
    if (error != null) {
        const statusCode = Number((error as { statusCode?: unknown }).statusCode);
        if (Number.isSafeInteger(statusCode) && statusCode >= 400 && statusCode < 600) {
            return { error: errorMessage(error, "request failed"), status: statusCode };
        }
    }
    const message =
        error instanceof Error
            ? error.message
            : error == null
              ? "Unknown error"
              : String(error);
    console.error("[Exec] Route error:", message);
    return { error: "internal server error", status: 500 };
}

function runExecCommand(
    request: ExecRequest,
    jobId: string,
    onUpdate?: (job: ExecJob) => void,
    timeoutMs?: number
): Promise<ExecResponse> {
    const { args, command, cwd, shell } = request;
    const cwdOption = { cwd: resolveCwd(cwd), detached: true, env: process.env };
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
        const job = jobs.get(jobId);
        if (job) job.process = child;
        let timeout: Timer | undefined;
        let forceKillTimeout: Timer | undefined;
        if (timeoutMs !== undefined) {
            timeout = setTimeout(() => {
                killProcessGroup(child, "SIGTERM");
                forceKillTimeout = setTimeout(() => {
                    killProcessGroup(child, "SIGKILL");
                }, 3000);
                forceKillTimeout.unref();
            }, timeoutMs);
            timeout.unref();
        }

        let stdout = "";
        let stderr = "";
        const stdoutDone = pipeProcessOutput(
            child.stdout as ReadableStream<Uint8Array> | undefined,
            (data) => {
                stdout = trimOutput(stdout + String(data));
                onUpdate?.({
                    code: null,
                    endedAt: null,
                    id: "",
                    startedAt: 0,
                    status: "running",
                    stderr,
                    stdout,
                });
            }
        );
        const stderrDone = pipeProcessOutput(
            child.stderr as ReadableStream<Uint8Array> | undefined,
            (data) => {
                stderr = trimOutput(stderr + String(data));
                onUpdate?.({
                    code: null,
                    endedAt: null,
                    id: "",
                    startedAt: 0,
                    status: "running",
                    stderr,
                    stdout,
                });
            }
        );
        void (async () => {
            const code = await child.exited;
            await Promise.all([stdoutDone, stderrDone]);
            return code;
        })()
            .then((code) => {
                if (timeout) clearTimeout(timeout);
                if (forceKillTimeout) clearTimeout(forceKillTimeout);
                resolve({ code, stderr, stdout });
            })
            .catch((error: unknown) => {
                if (timeout) clearTimeout(timeout);
                if (forceKillTimeout) clearTimeout(forceKillTimeout);
                reject(error);
            });
    });
}

function cleanupJobs(): void {
    if (jobs.size < MAX_JOBS) return;
    const entries = jobs
        .values()
        .toArray()
        .sort((a, b) => a.startedAt - b.startedAt);
    let overflow = entries.length - (MAX_JOBS - 1);
    for (const job of entries) {
        if (overflow <= 0) break;
        if (
            job.closePending ||
            ((job.status === "running" || job.status === "signaled") && job.process)
        ) {
            continue;
        }
        jobs.delete(job.id);
        overflow -= 1;
    }
    if (overflow > 0) {
        console.warn("[Exec] Job cleanup skipped active jobs while enforcing cap");
    }
}

function updateExecJobOutput(jobId: string, update: ExecJob): void {
    const current = jobs.get(jobId);
    if (!current) return;
    current.stdout = update.stdout;
    current.stderr = update.stderr;
}

function completeExecJob(jobId: string, result: ExecResponse): void {
    const current = jobs.get(jobId);
    if (!current) return;
    current.status = "done";
    if (!current.closePending) current.code = result.code;
    current.stdout = result.stdout;
    current.stderr = result.stderr;
    current.endedAt = Date.now();
    current.closePending = false;
    current.process = undefined;
    cleanupJobs();
}

function markExecJobForcedKilled(job: ExecJob): void {
    job.closePending = true;
    job.status = "done";
    job.code = 137;
    job.endedAt = Date.now();
    cleanupJobs();
}

function failExecJob(jobId: string, error: unknown): void {
    const current = jobs.get(jobId);
    if (!current) return;
    current.status = "done";
    current.code = 1;
    const message = error instanceof Error ? error.message : String(error);
    current.stderr = trimOutput(`${current.stderr}\n${message}`.trim());
    current.endedAt = Date.now();
    current.closePending = false;
    current.process = undefined;
    cleanupJobs();
}

export async function runExecOnce(payload: unknown): Promise<ExecResponse> {
    const request = validateExecRequest(payload);
    const result = await runExecCommand(
        request,
        Bun.randomUUIDv7(),
        undefined,
        EXEC_ONCE_TIMEOUT_MS
    );
    return {
        code: result.code,
        stderr: result.stderr.slice(-10_000),
        stdout: result.stdout.slice(-10_000),
    };
}

export function startExecJob(payload: unknown): ExecStartResponse {
    const request = validateExecRequest(payload);
    cleanupJobs();
    if (jobs.size >= MAX_JOBS) {
        throw Object.assign(new Error("Too many exec jobs"), { statusCode: 429 });
    }

    const jobId = Bun.randomUUIDv7();
    jobs.set(jobId, {
        closePending: false,
        code: null,
        endedAt: null,
        id: jobId,
        startedAt: Date.now(),
        status: "running",
        stderr: "",
        stdout: "",
    });

    let runPromise: Promise<ExecResponse>;
    try {
        runPromise = runExecCommand(request, jobId, (update) =>
            updateExecJobOutput(jobId, update)
        );
    } catch (error) {
        jobs.delete(jobId);
        throw error;
    }

    void (async () => {
        try {
            completeExecJob(jobId, await runPromise);
        } catch (error) {
            failExecJob(jobId, error);
        }
    })();

    return { jobId };
}

export function stopExecJob(jobId: string): { isSuccess: boolean; message: string } {
    const job = jobs.get(jobId);
    if (!job) {
        throw Object.assign(new Error("Exec job not found"), { statusCode: 404 });
    }
    if (job.status !== "running") {
        throw Object.assign(new Error("Job is not running"), { statusCode: 400 });
    }

    if (!job.process) {
        throw Object.assign(new Error("Process not available"), { statusCode: 400 });
    }

    killProcessGroup(job.process, "SIGTERM");
    job.status = "signaled";

    const forceKillTimer = setTimeout(() => {
        if (!job.process || job.status !== "signaled") return;
        killProcessGroup(job.process, "SIGKILL");
        markExecJobForcedKilled(job);
    }, 3000);
    forceKillTimer.unref();

    return { isSuccess: true, message: "Stop signal sent" };
}

export function getExecJob(jobId: string): ExecJobResponse {
    const job = jobs.get(jobId);
    if (!job) {
        throw Object.assign(new Error("Exec job not found"), { statusCode: 404 });
    }
    return {
        code: job.code,
        endedAt: job.endedAt,
        jobId: job.id,
        startedAt: job.startedAt,
        status: job.status,
        stderr: job.stderr,
        stdout: job.stdout,
    };
}
