import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import express, { type RequestHandler } from "express";

import { asyncRoute, errorMessage } from "../lib/errors.js";
import { nonEmptyEnvFallback } from "../lib/values.js";
import { refreshCacheProducer } from "../services/cacheRefresh.js";
const MAX_OUTPUT_CHARS = 100_000;
let spawnBackupProcess = spawn;
let refreshBackupCache = refreshCacheProducer;
let backupRefreshTimeoutMs = 30_000;

function getBackupShell(): string {
    return nonEmptyEnvFallback("MIRA_BACKUP_SHELL", "bash");
}

function getDockerBin(): string {
    return nonEmptyEnvFallback("MIRA_DOCKER_BIN", "docker");
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

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
    refreshPending?: boolean;
    process?: ChildProcess;
}

/** Represents the backup job API response. */
interface BackupJobResponse {
    job: ReturnType<typeof mapJob>;
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

/** Refreshes backup status cache with a bounded best-effort timeout. */
function refreshBackupCacheWithTimeout(key: string, timeoutMs = 30_000) {
    let timeout: NodeJS.Timeout | null = null;
    const refresh = refreshBackupCache(key);
    const timed = Promise.race([
        refresh,
        new Promise((_, reject) => {
            timeout = setTimeout(
                () => reject(new Error("Status refresh timed out")),
                timeoutMs
            );
            timeout.unref();
        }),
    ]).finally(() => {
        if (timeout) {
            clearTimeout(timeout);
        }
    });
    return { refresh, timed };
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

    if (job.status === "done" && !job.refreshPending) {
        clear();
        backupJobs.delete(job.id);
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
        refreshPending: job.refreshPending === true,
    };
}

function clearActiveBackupJob(type: BackupJob["type"], jobId: string): void {
    backupJobs.delete(jobId);
    if (type === "kopia" && activeKopiaJobId === jobId) {
        activeKopiaJobId = null;
    }
    if (type === "walg" && activeWalgJobId === jobId) {
        activeWalgJobId = null;
    }
}

function waitForChildSpawn(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
        const onSpawn = () => {
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        function cleanup() {
            child.off("spawn", onSpawn);
            child.off("error", onError);
        }
        child.once("spawn", onSpawn);
        child.once("error", onError);
    });
}

/** Performs start backup job. */
async function startBackupJob(type: BackupJob["type"], command: string) {
    const existingJob = type === "kopia" ? getCurrentKopiaJob() : getCurrentWalgJob();
    if (existingJob?.status === "running") {
        return existingJob;
    }
    if (existingJob?.refreshPending) {
        return existingJob;
    }
    if (existingJob) {
        clearActiveBackupJob(type, existingJob.id);
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

    let child: ReturnType<typeof spawn>;
    try {
        child = spawnBackupProcess(getBackupShell(), ["-lc", command], {
            cwd: process.cwd(),
            env: process.env,
        });
    } catch (error) {
        clearActiveBackupJob(type, jobId);
        throw error;
    }

    job.process = child;

    child.stdout?.on("data", (data) => {
        job.stdout = trimOutput(job.stdout + String(data));
    });

    child.stderr?.on("data", (data) => {
        job.stderr = trimOutput(job.stderr + String(data));
    });

    child.on("close", (code, signal) => {
        if (!signal && code === 0) {
            const cacheKey =
                type === "kopia" ? "backup.kopia.status" : "backup.walg.status";
            job.refreshPending = true;
            job.status = "done";
            job.code = code;
            job.endedAt = Date.now();
            const refresh = refreshBackupCacheWithTimeout(
                cacheKey,
                backupRefreshTimeoutMs
            );
            void refresh.timed.catch(() => {});
            void refresh.refresh
                .catch((error: unknown) => {
                    const refreshMessage = errorMessage(error, "Unknown error");
                    job.stderr = trimOutput(
                        `${job.stderr}\nStatus refresh failed: ${refreshMessage}`.trim()
                    );
                })
                .finally(() => {
                    job.refreshPending = false;
                });
            return;
        }
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

    try {
        await waitForChildSpawn(child);
    } catch (error) {
        clearActiveBackupJob(type, jobId);
        throw error;
    }

    return job;
}

/** Performs start kopia backup job. */
function startKopiaBackupJob() {
    return startBackupJob("kopia", "/opt/docker/apps/kopia/backup.sh");
}

/** Performs start walg backup job. */
function startWalgBackupJob() {
    return startBackupJob(
        "walg",
        `${shellQuote(getDockerBin())} exec walg /bin/sh /usr/local/bin/backup-push.sh`
    );
}

export const __testing = {
    trimOutput,
    getCurrentJob,
    startBackupJob,
    mapJob,
    getBackupShell,
    getDockerBin,
    shellQuote,
    clearJobsForTest(): void {
        backupJobs.clear();
        activeKopiaJobId = null;
        activeWalgJobId = null;
    },
    setActiveJobForTest(type: BackupJob["type"], job: BackupJob): void {
        backupJobs.set(job.id, job);
        if (type === "kopia") {
            activeKopiaJobId = job.id;
        } else {
            activeWalgJobId = job.id;
        }
    },
    setSpawnBackupProcessForTest(nextSpawn?: typeof spawn): void {
        spawnBackupProcess = nextSpawn ?? spawn;
    },
    setRefreshBackupCacheForTest(nextRefresh?: typeof refreshCacheProducer): void {
        refreshBackupCache = nextRefresh ?? refreshCacheProducer;
    },
    setBackupRefreshTimeoutMsForTest(nextTimeoutMs = 30_000): void {
        backupRefreshTimeoutMs = nextTimeoutMs;
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
                const job = await startKopiaBackupJob();
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
                const job = await startWalgBackupJob();
                res.json({ ok: true, job: mapJob(job) });
            },
            { fallback: "Failed to start WAL-G backup" }
        )
    );
}
