import { randomUUID } from "node:crypto";

import { type ChildProcess, spawn } from "child_process";
import express, { type RequestHandler } from "express";

interface ExecRequest {
    command: string;
    args?: string[];
    cwd?: string;
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

function runExecCommand(
    request: ExecRequest,
    jobId: string,
    onUpdate?: (job: ExecJob) => void
): Promise<ExecResponse> {
    const { command, args, cwd } = request;

    return new Promise((resolve, reject) => {
        const child =
            args && Array.isArray(args)
                ? spawn(command, args, {
                      cwd: cwd || process.cwd(),
                      env: process.env,
                      detached: true,
                  })
                : spawn(command, {
                      shell: true,
                      cwd: cwd || process.cwd(),
                      env: process.env,
                      detached: true,
                  });

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
        const payload = req.body as ExecRequest;

        try {
            const tempId = randomUUID();
            const result = await runExecCommand(payload, tempId);
            res.json({
                code: result.code,
                stdout: result.stdout.slice(-10_000),
                stderr: result.stderr.slice(-10_000),
            } satisfies ExecResponse);
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.post("/api/exec/start", express.json(), (async (req, res) => {
        const payload = req.body as ExecRequest;

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

        void runExecCommand(payload, jobId, (update) => {
            const current = jobs.get(jobId);
            if (!current) {
                return;
            }

            current.stdout = update.stdout;
            current.stderr = update.stderr;
        })
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
