import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import express, { type RequestHandler } from "express";

const N8N_ROOT = process.env.MIRA_N8N_ROOT || "/home/ubuntu/projects/n8n";
const N8N_DATABASE = "n8n";
const DOPPLER_BIN = process.env.DOPPLER_BIN || "/usr/local/bin/doppler";
const MAX_OUTPUT_CHARS = 100_000;

/** Represents backup job. */
interface BackupJob {
    id: string;
    type: "kopia" | "walg";
    status: "running" | "done";
    code: number | null;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | null;
    process?: ChildProcess;
}

/** Represents the backup job API response. */
interface BackupJobResponse {
    job: BackupJob | null;
}

const backupJobs = new Map<string, BackupJob>();
let activeKopiaJobId: string | null = null;
let activeWalgJobId: string | null = null;

/** Performs trim output. */
function trimOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) {
        return text;
    }

    return text.slice(-MAX_OUTPUT_CHARS);
}

/** Returns current job. */
function getCurrentJob(activeJobId: string | null, clear: () => void) {
    if (!activeJobId) {
        return null;
    }

    const job = backupJobs.get(activeJobId) ?? null;
    if (!job) {
        clear();
        return null;
    }

    if (job.status === "done") {
        clear();
    }

    return job;
}

/** Returns current kopia job. */
function getCurrentKopiaJob() {
    return getCurrentJob(activeKopiaJobId, () => {
        activeKopiaJobId = null;
    });
}

/** Returns current walg job. */
function getCurrentWalgJob() {
    return getCurrentJob(activeWalgJobId, () => {
        activeWalgJobId = null;
    });
}

/** Performs map job. */
function mapJob(job: BackupJob | null) {
    if (!job) {
        return null;
    }

    return {
        id: job.id,
        type: job.type,
        status: job.status,
        code: job.code,
        stdout: job.stdout,
        stderr: job.stderr,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
    };
}

/** Creates backup env. */
function createBackupEnv() {
    return {
        ...process.env,
        DB_POSTGRESDB_HOST: "127.0.0.1",
        DB_POSTGRESDB_PORT: "6432",
        DB_POSTGRESDB_DATABASE: N8N_DATABASE,
        DB_POSTGRESDB_USER: process.env.DATABASE_USERNAME || "",
        DB_POSTGRESDB_PASSWORD: process.env.DATABASE_PASSWORD || "",
    };
}

/** Performs start backup job. */
function startBackupJob(type: BackupJob["type"], command: string) {
    const existingJob = type === "kopia" ? getCurrentKopiaJob() : getCurrentWalgJob();
    if (existingJob?.status === "running") {
        return existingJob;
    }

    const jobId = randomUUID();
    const job: BackupJob = {
        id: jobId,
        type,
        status: "running",
        code: null,
        stdout: "",
        stderr: "",
        startedAt: Date.now(),
        endedAt: null,
    };

    backupJobs.set(jobId, job);
    if (type === "kopia") {
        activeKopiaJobId = jobId;
    } else {
        activeWalgJobId = jobId;
    }

    const child = spawn(
        DOPPLER_BIN,
        ["run", "--project", "rajohan", "--config", "prd", "--", "bash", "-lc", command],
        {
            cwd: N8N_ROOT,
            env: createBackupEnv(),
        }
    );

    job.process = child;

    child.stdout?.on("data", (data) => {
        job.stdout = trimOutput(job.stdout + String(data));
    });

    child.stderr?.on("data", (data) => {
        job.stderr = trimOutput(job.stderr + String(data));
    });

    child.on("close", (code, signal) => {
        job.status = "done";
        job.code = signal ? 130 : code;
        job.endedAt = Date.now();
    });

    child.on("error", (error) => {
        job.status = "done";
        job.code = 1;
        job.stderr = trimOutput(`${job.stderr}\n${error.message}`.trim());
        job.endedAt = Date.now();
    });

    return job;
}

/** Performs start kopia backup job. */
function startKopiaBackupJob() {
    return startBackupJob(
        "kopia",
        "/opt/docker/apps/kopia/backup.sh && node /home/ubuntu/projects/n8n/scripts/backup-kopia-status.mjs"
    );
}

/** Performs start walg backup job. */
function startWalgBackupJob() {
    return startBackupJob(
        "walg",
        "docker exec walg /bin/sh /usr/local/bin/backup-push.sh && node /home/ubuntu/projects/n8n/scripts/backup-walg-status.mjs"
    );
}

/** Registers backup API routes. */
export default function backupRoutes(
    app: express.Application,
    _express: typeof express
): void {
    app.get("/api/backups/kopia", ((_req, res) => {
        res.json({ job: mapJob(getCurrentKopiaJob()) } satisfies BackupJobResponse);
    }) as RequestHandler);

    app.post("/api/backups/kopia/run", (async (_req, res) => {
        try {
            const job = startKopiaBackupJob();
            res.json({ ok: true, job: mapJob(job) });
        } catch (error) {
            res.status(500).json({
                error:
                    error instanceof Error
                        ? error.message
                        : "Failed to start Kopia backup",
            });
        }
    }) as RequestHandler);

    app.get("/api/backups/walg", ((_req, res) => {
        res.json({ job: mapJob(getCurrentWalgJob()) } satisfies BackupJobResponse);
    }) as RequestHandler);

    app.post("/api/backups/walg/run", (async (_req, res) => {
        try {
            const job = startWalgBackupJob();
            res.json({ ok: true, job: mapJob(job) });
        } catch (error) {
            res.status(500).json({
                error:
                    error instanceof Error
                        ? error.message
                        : "Failed to start WAL-G backup",
            });
        }
    }) as RequestHandler);
}
