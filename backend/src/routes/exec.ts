import { randomUUID } from "node:crypto";

import { type ChildProcess } from "child_process";
import express, { type RequestHandler } from "express";
import fs from "fs";
import path from "path";
import { parse as parseShellCommand } from "shell-quote";

import { spawnGuarded } from "../lib/guardedOps.js";

const OPS_SHELL_COMMANDS = new Set([
    "__mira_dashboard_shell_smoke_test__",
    "sudo reboot",
    "sudo apt-get autoremove -y && sudo apt-get autoclean -y && sudo journalctl --vacuum-time=14d && sudo docker system prune -af",
    "bash -lc 'sudo DEBIAN_FRONTEND=noninteractive apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y; apt_status=$?; sudo DEBIAN_FRONTEND=noninteractive dpkg --configure -a; dpkg_status=$?; if [ $apt_status -ne 0 ]; then exit $apt_status; fi; exit $dpkg_status'",
    "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}; export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}; $HOME/.local/bin/openclaw gateway restart",
    "find $HOME/.openclaw/agents -type f -path '*/sessions/*' -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/agents -type d -path '*/sessions/*' -empty -delete 2>/dev/null || true; find $HOME/.openclaw/media -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/workspace/images -type f -mtime +30 -delete 2>/dev/null || true; find $HOME/.openclaw/tmp -type f -mtime +7 -delete 2>/dev/null || true; find $HOME/.openclaw/delivery-queue/failed -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/completions -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/cron/runs -type f -mtime +30 -delete 2>/dev/null || true; find $HOME/.openclaw/logs -type f -mtime +14 -delete 2>/dev/null || true",
    "$HOME/.local/bin/openclaw update --yes",
]);

interface ExecRequest {
    command: string;
    args?: string[];
    cwd?: string;
    shell?: boolean;
}

class ExecValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ExecValidationError";
    }
}

// Validate and sanitize exec request payload
const MAX_COMMAND_LENGTH = 4096;
const SHELL_METACHARACTERS_RE = /[\n\r\0]/u;
const EXECUTABLE_RE = /^(?:[\w./-]+)$/u;

function validateExecRequest(payload: unknown): ExecRequest {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new ExecValidationError("request body must be a JSON object");
    }

    const { command, args, cwd, shell } = payload as ExecRequest;

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

    if (args !== undefined && shell) {
        throw new ExecValidationError("args cannot be combined with shell mode");
    }

    if (shell && !OPS_SHELL_COMMANDS.has(command)) {
        throw new ExecValidationError(
            "shell mode is only available for approved ops commands"
        );
    }

    if (args !== undefined && !EXECUTABLE_RE.test(command)) {
        throw new ExecValidationError(
            "command must be an executable path when args are provided"
        );
    }

    if (args !== undefined && !Array.isArray(args)) {
        throw new ExecValidationError("args must be an array");
    }

    if (args) {
        for (const arg of args) {
            if (typeof arg !== "string") {
                throw new ExecValidationError("all args must be strings");
            }
        }
    }

    if (cwd !== undefined && typeof cwd !== "string") {
        throw new ExecValidationError("cwd must be a string");
    }

    return { command, args, cwd, shell };
}

interface ExecResponse {
    code: number | null;
    stdout: string;
    stderr: string;
}

interface ExecJob {
    id: string;
    status: "running" | "done";
    code: number | null;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | null;
    process?: ChildProcess;
}

interface ExecStartResponse {
    jobId: string;
}

interface ExecJobResponse {
    jobId: string;
    status: "running" | "done";
    code: number | null;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | null;
}

const MAX_OUTPUT_CHARS = 100_000;
const MAX_JOBS = 100;
const jobs = new Map<string, ExecJob>();

function trimOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) {
        return text;
    }

    return text.slice(-MAX_OUTPUT_CHARS);
}

function parseCommand(command: string): { executable: string; args: string[] } {
    const parsed = parseShellCommand(command);
    const parts: string[] = [];

    for (const part of parsed) {
        if (typeof part !== "string") {
            throw new ExecValidationError(
                "shell operators, redirects, and substitutions are not supported"
            );
        }
        parts.push(part);
    }

    const [executable, ...parsedArgs] = parts;
    if (!executable || !EXECUTABLE_RE.test(executable)) {
        throw new ExecValidationError("command must start with an executable path");
    }

    return { executable, args: parsedArgs };
}

function resolveCwd(cwd: string | undefined): string {
    if (!cwd) {
        return process.cwd();
    }

    if (cwd.includes("\0") || !path.isAbsolute(cwd)) {
        throw new ExecValidationError("cwd must be an absolute path");
    }

    // codeql[js/path-injection]: cwd must be an absolute path without null bytes; it is canonicalized before use as child_process cwd.
    return fs.realpathSync(cwd);
}

function getApprovedShellCommand(command: string): string {
    switch (command) {
        case "__mira_dashboard_shell_smoke_test__": {
            return "__mira_dashboard_shell_smoke_test__";
        }
        case "sudo reboot": {
            return "sudo reboot";
        }
        case "sudo apt-get autoremove -y && sudo apt-get autoclean -y && sudo journalctl --vacuum-time=14d && sudo docker system prune -af": {
            return "sudo apt-get autoremove -y && sudo apt-get autoclean -y && sudo journalctl --vacuum-time=14d && sudo docker system prune -af";
        }
        case "bash -lc 'sudo DEBIAN_FRONTEND=noninteractive apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y; apt_status=$?; sudo DEBIAN_FRONTEND=noninteractive dpkg --configure -a; dpkg_status=$?; if [ $apt_status -ne 0 ]; then exit $apt_status; fi; exit $dpkg_status'": {
            return "bash -lc 'sudo DEBIAN_FRONTEND=noninteractive apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y; apt_status=$?; sudo DEBIAN_FRONTEND=noninteractive dpkg --configure -a; dpkg_status=$?; if [ $apt_status -ne 0 ]; then exit $apt_status; fi; exit $dpkg_status'";
        }
        case "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}; export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}; $HOME/.local/bin/openclaw gateway restart": {
            return "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}; export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}; $HOME/.local/bin/openclaw gateway restart";
        }
        case "find $HOME/.openclaw/agents -type f -path '*/sessions/*' -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/agents -type d -path '*/sessions/*' -empty -delete 2>/dev/null || true; find $HOME/.openclaw/media -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/workspace/images -type f -mtime +30 -delete 2>/dev/null || true; find $HOME/.openclaw/tmp -type f -mtime +7 -delete 2>/dev/null || true; find $HOME/.openclaw/delivery-queue/failed -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/completions -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/cron/runs -type f -mtime +30 -delete 2>/dev/null || true; find $HOME/.openclaw/logs -type f -mtime +14 -delete 2>/dev/null || true": {
            return "find $HOME/.openclaw/agents -type f -path '*/sessions/*' -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/agents -type d -path '*/sessions/*' -empty -delete 2>/dev/null || true; find $HOME/.openclaw/media -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/workspace/images -type f -mtime +30 -delete 2>/dev/null || true; find $HOME/.openclaw/tmp -type f -mtime +7 -delete 2>/dev/null || true; find $HOME/.openclaw/delivery-queue/failed -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/completions -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/cron/runs -type f -mtime +30 -delete 2>/dev/null || true; find $HOME/.openclaw/logs -type f -mtime +14 -delete 2>/dev/null || true";
        }
        case "$HOME/.local/bin/openclaw update --yes": {
            return "$HOME/.local/bin/openclaw update --yes";
        }
        default: {
            throw new ExecValidationError(
                "shell mode is only available for approved ops commands"
            );
        }
    }
}

function spawnExec(
    executable: string,
    args: string[],
    cwdOption: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }
): ChildProcess {
    return spawnGuarded(executable, args, { ...cwdOption, shell: false });
}

function spawnApprovedShell(
    command: string,
    cwdOption: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }
): ChildProcess {
    return spawnGuarded("/bin/sh", ["-c", command], { ...cwdOption, shell: false });
}

function runExecCommand(
    request: ExecRequest,
    jobId: string,
    onUpdate?: (job: ExecJob) => void
): Promise<ExecResponse> {
    const { command, args, cwd, shell } = request;
    const safeCwd = resolveCwd(cwd);
    const cwdOption = { cwd: safeCwd, env: process.env, detached: true };
    let childFactory: () => ChildProcess;
    if (shell) {
        const approvedCommand = getApprovedShellCommand(command);
        childFactory = () => spawnApprovedShell(approvedCommand, cwdOption);
    } else {
        const commandParts = Array.isArray(args)
            ? { executable: command, args }
            : parseCommand(command);
        childFactory = () =>
            spawnExec(commandParts.executable, commandParts.args, cwdOption);
    }

    return new Promise((resolve, reject) => {
        const child = childFactory();

        // Store process reference for kill
        const job = jobs.get(jobId);
        if (job) {
            job.process = child;
        }

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (data) => {
            stdout = trimOutput(stdout + String(data));
            onUpdate?.({
                id: "",
                status: "running",
                code: null,
                stdout,
                stderr,
                startedAt: 0,
                endedAt: null,
            });
        });

        child.stderr?.on("data", (data) => {
            stderr = trimOutput(stderr + String(data));
            onUpdate?.({
                id: "",
                status: "running",
                code: null,
                stdout,
                stderr,
                startedAt: 0,
                endedAt: null,
            });
        });

        child.on("close", (code, signal) => {
            // If killed manually, signal will be set
            const finalCode = signal ? 130 : code;
            resolve({
                code: finalCode,
                stdout,
                stderr,
            });
        });

        child.on("error", (error) => {
            reject(error);
        });
    });
}

function cleanupJobs(): void {
    if (jobs.size <= MAX_JOBS) {
        return;
    }

    const entries = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
    const overflow = entries.length - MAX_JOBS;

    for (let index = 0; index < overflow; index += 1) {
        const job = entries[index];
        if (job.process && !job.process.killed) {
            job.process.kill("SIGTERM");
        }
        jobs.delete(job.id);
    }
}

export default function execRoutes(
    app: express.Application,
    _express: typeof express
): void {
    app.post("/api/exec", express.json(), (async (req, res) => {
        try {
            const payload = validateExecRequest(req.body as ExecRequest);
            const tempId = randomUUID();
            const result = await runExecCommand(payload, tempId);
            res.json({
                code: result.code,
                stdout: result.stdout.slice(-10_000),
                stderr: result.stderr.slice(-10_000),
            } satisfies ExecResponse);
        } catch (error) {
            res.status(error instanceof ExecValidationError ? 400 : 500).json({
                error: (error as Error).message,
            });
        }
    }) as RequestHandler);

    app.post("/api/exec/start", express.json(), (async (req, res) => {
        let payload: ExecRequest;
        try {
            payload = validateExecRequest(req.body as ExecRequest);
        } catch (error) {
            res.status(error instanceof ExecValidationError ? 400 : 500).json({
                error: (error as Error).message,
            });
            return;
        }

        const jobId = randomUUID();
        const startedAt = Date.now();
        jobs.set(jobId, {
            id: jobId,
            status: "running",
            code: null,
            stdout: "",
            stderr: "",
            startedAt,
            endedAt: null,
        });

        let runPromise: Promise<ExecResponse>;
        try {
            runPromise = runExecCommand(payload, jobId, (update) => {
                const current = jobs.get(jobId);
                if (!current) {
                    return;
                }

                current.stdout = update.stdout;
                current.stderr = update.stderr;
            });
        } catch (error) {
            jobs.delete(jobId);
            res.status(error instanceof ExecValidationError ? 400 : 500).json({
                error: (error as Error).message,
            });
            return;
        }

        void runPromise
            .then((result) => {
                const current = jobs.get(jobId);
                if (!current) {
                    return;
                }

                current.status = "done";
                current.code = result.code;
                current.stdout = result.stdout;
                current.stderr = result.stderr;
                current.endedAt = Date.now();
                cleanupJobs();
            })
            .catch((error) => {
                const current = jobs.get(jobId);
                if (!current) {
                    return;
                }

                current.status = "done";
                current.code = 1;
                current.stderr = trimOutput(
                    `${current.stderr}\n${(error as Error).message}`.trim()
                );
                current.endedAt = Date.now();
                cleanupJobs();
            });

        res.json({ jobId } satisfies ExecStartResponse);
    }) as RequestHandler);

    app.post("/api/exec/:jobId/stop", ((req, res) => {
        const jobId = String(req.params.jobId || "");
        const job = jobs.get(jobId);

        if (!job) {
            res.status(404).json({ error: "Exec job not found" });
            return;
        }

        if (job.status !== "running") {
            res.status(400).json({ error: "Job is not running" });
            return;
        }

        if (job.process && !job.process.killed) {
            try {
                // Kill the entire process group (negative PID)
                process.kill(-job.process.pid!, "SIGTERM");
            } catch {
                // Fallback to killing just the process if process group fails
                job.process.kill("SIGTERM");
            }

            // Force kill after 3 seconds if still running
            setTimeout(() => {
                try {
                    if (job.process && !job.process.killed) {
                        process.kill(-job.process.pid!, "SIGKILL");
                    }
                } catch {
                    // Ignore errors - process might already be gone
                }
            }, 3000);

            res.json({ success: true, message: "Stop signal sent" });
        } else {
            res.status(400).json({ error: "Process not available" });
        }
    }) as RequestHandler);

    app.get("/api/exec/:jobId", ((req, res) => {
        const jobId = String(req.params.jobId || "");
        const job = jobs.get(jobId);

        if (!job) {
            res.status(404).json({ error: "Exec job not found" });
            return;
        }

        res.json({
            jobId: job.id,
            status: job.status,
            code: job.code,
            stdout: job.stdout,
            stderr: job.stderr,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
        } satisfies ExecJobResponse);
    }) as RequestHandler);
}
