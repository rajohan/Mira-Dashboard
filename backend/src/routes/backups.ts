import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import express, { type RequestHandler } from "express";

import { asyncRoute } from "../lib/errors.js";
import {
    refreshCacheProducer,
    seedMissingLocalCacheEntry,
} from "../services/cacheRefresh.js";
import {
    getScheduledJob,
    registerScheduledJobAction,
    upsertScheduledJob,
} from "../services/scheduledJobs.js";
const MAX_OUTPUT_CHARS = 100_000;
const SCHEDULED_BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
let spawnBackupProcess = spawn;

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
    completed: Promise<BackupJob>;
    process?: ChildProcess;
}

/** Represents the backup job API response. */
interface BackupJobResponse {
    job: {
        id: string;
        type: BackupJob["type"];
        status: BackupJob["status"];
        code: number | null;
        stdout: string;
        stderr: string;
        startedAt: number;
        endedAt: number | null;
    } | null;
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

/** Returns backup type from scheduled job payload. */
function getScheduledBackupType(payload: unknown) {
    if (typeof payload !== "object" || payload === null) {
        return;
    }

    return (payload as { type?: unknown }).type;
}

function backupStatusCacheKey(type: BackupJob["type"]) {
    return type === "kopia" ? "backup.kopia.status" : "backup.walg.status";
}

/** Performs start backup job. */
function startBackupJob(type: BackupJob["type"], command: string) {
    const existingJob = type === "kopia" ? getCurrentKopiaJob() : getCurrentWalgJob();
    if (existingJob?.status === "running") {
        return existingJob;
    }

    const jobId = randomUUID();
    let resolveCompleted!: (job: BackupJob) => void;
    const job: BackupJob = {
        id: jobId,
        type,
        status: "running",
        code: null,
        stdout: "",
        stderr: "",
        startedAt: Date.now(),
        endedAt: null,
        completed: new Promise<BackupJob>((resolve) => {
            resolveCompleted = resolve;
        }),
    };

    backupJobs.set(jobId, job);
    if (type === "kopia") {
        activeKopiaJobId = jobId;
    } else {
        activeWalgJobId = jobId;
    }

    let child: ReturnType<typeof spawn>;
    try {
        child = spawnBackupProcess("bash", ["-lc", command], {
            env: process.env,
        });
    } catch (error) {
        backupJobs.delete(jobId);
        if (activeKopiaJobId === jobId) {
            activeKopiaJobId = null;
        }
        if (activeWalgJobId === jobId) {
            activeWalgJobId = null;
        }
        throw error;
    }

    job.process = child;
    let finalized = false;
    let finalizing = false;

    child.stdout?.on("data", (data) => {
        job.stdout = trimOutput(job.stdout + String(data));
    });

    child.stderr?.on("data", (data) => {
        job.stderr = trimOutput(job.stderr + String(data));
    });

    child.on("close", async (code, signal) => {
        if (finalized || finalizing) {
            return;
        }
        finalizing = true;
        job.status = "done";
        job.code = signal ? 130 : code;
        job.endedAt = Date.now();
        finalized = true;
        if (!signal && code === 0) {
            await refreshBackupStatus(type, job);
        }
        resolveCompleted(job);
    });

    child.on("error", (error) => {
        if (finalized || finalizing) {
            return;
        }
        finalizing = true;
        finalized = true;
        job.status = "done";
        job.code = 1;
        job.stderr = trimOutput(`${job.stderr}\n${error.message}`.trim());
        job.endedAt = Date.now();
        resolveCompleted(job);
    });

    return job;
}

async function refreshBackupStatus(
    type: BackupJob["type"],
    job: BackupJob
): Promise<void> {
    const cacheKey = backupStatusCacheKey(type);
    await refreshCacheProducer(cacheKey).catch((error: unknown) => {
        job.stderr = trimOutput(
            `${job.stderr}\nStatus refresh failed: ${String(error)}`.trim()
        );
    });
}

/** Performs start kopia backup job. */
function startKopiaBackupJob() {
    return startBackupJob("kopia", "/opt/docker/apps/kopia/backup.sh");
}

/** Performs start walg backup job. */
function startWalgBackupJob() {
    return startBackupJob(
        "walg",
        "docker exec walg /bin/sh /usr/local/bin/backup-push.sh"
    );
}

async function startScheduledBackup(type: BackupJob["type"]) {
    const job = type === "kopia" ? startKopiaBackupJob() : startWalgBackupJob();
    const completedJob = await job.completed;
    if (completedJob.code !== 0) {
        await refreshBackupStatus(type, completedJob);
        const details = completedJob.stderr || completedJob.stdout;
        throw new Error(
            `${type.toUpperCase()} backup failed with code ${completedJob.code}${
                details ? `: ${details}` : ""
            }`
        );
    }
    return { backup: mapJob(completedJob) };
}

const backupScheduledJobs = [
    {
        id: "backup.walg",
        name: "WAL-G nightly backup",
        description: "Run the nightly WAL-G PostgreSQL base backup.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "03:20",
        actionKey: "backup.run",
        actionPayload: { type: "walg" },
    },
    {
        id: "backup.kopia",
        name: "Kopia nightly backup",
        description: "Run the nightly Kopia filesystem backup.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "03:50",
        actionKey: "backup.run",
        actionPayload: { type: "kopia" },
    },
] as const;

export function registerBackupScheduledJobs(): void {
    registerScheduledJobAction(
        "backup.run",
        (job) => {
            const type = getScheduledBackupType(job.actionPayload);
            if (type !== "kopia" && type !== "walg") {
                throw Object.assign(
                    new Error(`Scheduled backup job ${job.id} has invalid backup type`),
                    { statusCode: 400 }
                );
            }
            return startScheduledBackup(type);
        },
        { timeoutMs: SCHEDULED_BACKUP_TIMEOUT_MS }
    );

    for (const job of backupScheduledJobs) {
        const existing = getScheduledJob(job.id);
        upsertScheduledJob({
            ...job,
            enabled: existing?.enabled ?? true,
            scheduleType: existing?.scheduleType ?? job.scheduleType,
            intervalSeconds: existing?.intervalSeconds ?? job.intervalSeconds,
            timeOfDay: existing ? existing.timeOfDay : job.timeOfDay,
            cronExpression: existing?.cronExpression ?? null,
        });
        if (existing?.enabled ?? true) {
            seedMissingLocalCacheEntry(backupStatusCacheKey(job.actionPayload.type));
        }
    }
}

export const __testing = {
    trimOutput,
    getCurrentJob,
    mapJob,
    getScheduledBackupType,
    startScheduledBackup,
    setSpawnBackupProcessForTest(nextSpawn?: typeof spawn): void {
        spawnBackupProcess = nextSpawn ?? spawn;
    },
};

/** Registers backup API routes. */
export default function backupRoutes(
    app: express.Application,
    _express: typeof express
): void {
    app.get("/api/backups/kopia", ((_req, res) => {
        res.json({ job: mapJob(getCurrentKopiaJob()) } satisfies BackupJobResponse);
    }) as RequestHandler);

    app.post(
        "/api/backups/kopia/run",
        asyncRoute(
            async (_req, res) => {
                const job = startKopiaBackupJob();
                res.json({ ok: true, job: mapJob(job) });
            },
            { fallback: "Failed to start Kopia backup" }
        )
    );

    app.get("/api/backups/walg", ((_req, res) => {
        res.json({ job: mapJob(getCurrentWalgJob()) } satisfies BackupJobResponse);
    }) as RequestHandler);

    app.post(
        "/api/backups/walg/run",
        asyncRoute(
            async (_req, res) => {
                const job = startWalgBackupJob();
                res.json({ ok: true, job: mapJob(job) });
            },
            { fallback: "Failed to start WAL-G backup" }
        )
    );
}
