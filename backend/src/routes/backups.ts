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
    removeScheduledJobsNotInAction,
    upsertScheduledJob,
} from "../services/scheduledJobs.js";
const MAX_OUTPUT_CHARS = 100_000;
const SCHEDULED_BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const BACKUP_ABORT_SIGKILL_GRACE_MS = 10_000;
const WALG_BACKUP_SCRIPT_PATTERN = "/usr/local/bin/backup-push.sh";
let spawnBackupProcess = spawn;
let backupAbortContainerWaitMs = 30_000;
let backupAbortContainerPollMs = 1_000;
let backupAbortDockerExecTimeoutMs = 5_000;

interface BackupAbortConfig {
    container: string;
    processPattern: string;
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
    completed: Promise<BackupJob>;
    process?: ChildProcess;
    statusRefreshed?: boolean;
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
function startBackupJob(
    type: BackupJob["type"],
    command: string,
    signal?: AbortSignal,
    abortConfig?: BackupAbortConfig
) {
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
            detached: true,
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
    let abortKillTimer: NodeJS.Timeout | null = null;

    const finalizeJob = async (code: number, signalName: NodeJS.Signals | null) => {
        if (finalized || finalizing) {
            return;
        }
        finalizing = true;
        if (signalName && abortConfig) {
            await waitForContainerProcessExit(abortConfig).catch((error: unknown) => {
                job.stderr = trimOutput(
                    `${job.stderr}\nFailed to confirm backup process termination: ${String(error)}`.trim()
                );
            });
        }
        job.status = "done";
        job.code = signalName ? 130 : code;
        job.endedAt = Date.now();
        finalized = true;
        if (abortKillTimer) {
            clearTimeout(abortKillTimer);
            abortKillTimer = null;
        }
        signal?.removeEventListener("abort", abortBackup);
        if (!signalName) {
            await refreshBackupStatus(type, job);
        }
        resolveCompleted(job);
    };

    const abortBackup = () => {
        job.stderr = trimOutput(`${job.stderr}\nBackup aborted by scheduler`.trim());
        if (abortConfig) {
            terminateContainerProcess(abortConfig, "TERM").catch((error: unknown) => {
                job.stderr = trimOutput(
                    `${job.stderr}\nFailed to terminate container backup process: ${String(error)}`.trim()
                );
            });
        }
        try {
            if (typeof child.pid === "number") {
                const processGroupId = -child.pid;
                process.kill(processGroupId, "SIGTERM");
                abortKillTimer = setTimeout(() => {
                    if (abortConfig) {
                        terminateContainerProcess(abortConfig, "KILL").catch(
                            (error: unknown) => {
                                job.stderr = trimOutput(
                                    `${job.stderr}\nFailed to force terminate container backup process: ${String(error)}`.trim()
                                );
                            }
                        );
                    }
                    try {
                        process.kill(processGroupId, "SIGKILL");
                    } catch (error) {
                        job.stderr = trimOutput(
                            `${job.stderr}\nFailed to force terminate backup process group: ${String(error)}`.trim()
                        );
                    }
                }, BACKUP_ABORT_SIGKILL_GRACE_MS);
                abortKillTimer.unref();
            } else if (!child.kill("SIGTERM")) {
                job.stderr = trimOutput(
                    `${job.stderr}\nFailed to terminate backup process`.trim()
                );
                void finalizeJob(130, "SIGTERM");
            }
        } catch (error) {
            job.stderr = trimOutput(
                `${job.stderr}\nFailed to terminate backup process: ${String(error)}`.trim()
            );
            void finalizeJob(130, "SIGTERM");
        }
    };

    if (signal?.aborted) {
        abortBackup();
    } else {
        signal?.addEventListener("abort", abortBackup, { once: true });
    }

    child.stdout?.on("data", (data) => {
        job.stdout = trimOutput(job.stdout + String(data));
    });

    child.stderr?.on("data", (data) => {
        job.stderr = trimOutput(job.stderr + String(data));
    });

    child.on("close", async (code, signal) => {
        await finalizeJob(signal ? 130 : (code ?? 1), signal);
    });

    child.on("error", async (error) => {
        if (finalized || finalizing) {
            return;
        }
        finalizing = true;
        finalized = true;
        job.status = "done";
        job.code = 1;
        job.stderr = trimOutput(`${job.stderr}\n${error.message}`.trim());
        job.endedAt = Date.now();
        signal?.removeEventListener("abort", abortBackup);
        await refreshBackupStatus(type, job);
        resolveCompleted(job);
    });

    return job;
}

function runDockerExec(
    container: string,
    args: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawnBackupProcess("docker", ["exec", container, ...args], {
            detached: true,
            env: process.env,
        });
        const timeout = setTimeout(() => {
            try {
                if (typeof child.pid === "number") {
                    process.kill(-child.pid, "SIGKILL");
                } else {
                    child.kill("SIGKILL");
                }
            } catch {
                child.kill("SIGKILL");
            }
            reject(new Error(`Timed out waiting for docker exec ${args[0]}`));
        }, backupAbortDockerExecTimeoutMs);
        timeout.unref();
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (data) => {
            stdout = trimOutput(stdout + String(data));
        });
        child.stderr?.on("data", (data) => {
            stderr = trimOutput(stderr + String(data));
        });
        child.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timeout);
            resolve({ code: code ?? 1, stdout, stderr });
        });
    });
}

async function terminateContainerProcess(
    config: BackupAbortConfig,
    signalName: "TERM" | "KILL"
): Promise<void> {
    const result = await runDockerExec(config.container, [
        "pkill",
        `-${signalName}`,
        "-f",
        config.processPattern,
    ]);
    if (result.code > 1) {
        throw new Error(result.stderr || `docker exec pkill exited ${result.code}`);
    }
}

async function waitForContainerProcessExit(config: BackupAbortConfig): Promise<void> {
    const deadline = Date.now() + backupAbortContainerWaitMs;
    while (Date.now() < deadline) {
        const result = await runDockerExec(config.container, [
            "pgrep",
            "-f",
            config.processPattern,
        ]);
        if (result.code === 1) {
            return;
        }
        if (result.code > 1) {
            throw new Error(result.stderr || `docker exec pgrep exited ${result.code}`);
        }
        await new Promise((resolve) => setTimeout(resolve, backupAbortContainerPollMs));
    }
    throw new Error(`Timed out waiting for ${config.processPattern} to exit`);
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
    job.statusRefreshed = true;
}

/** Performs start kopia backup job. */
function startKopiaBackupJob(signal?: AbortSignal) {
    return startBackupJob("kopia", "/opt/docker/apps/kopia/backup.sh", signal);
}

/** Performs start walg backup job. */
function startWalgBackupJob(signal?: AbortSignal) {
    return startBackupJob(
        "walg",
        "docker exec walg /bin/sh /usr/local/bin/backup-push.sh",
        signal,
        { container: "walg", processPattern: WALG_BACKUP_SCRIPT_PATTERN }
    );
}

async function startScheduledBackup(type: BackupJob["type"], signal?: AbortSignal) {
    if (
        (type === "kopia" ? getCurrentKopiaJob() : getCurrentWalgJob())?.status ===
        "running"
    ) {
        throw Object.assign(
            new Error(`${type.toUpperCase()} backup is already running`),
            {
                statusCode: 409,
            }
        );
    }
    const job =
        type === "kopia" ? startKopiaBackupJob(signal) : startWalgBackupJob(signal);
    const completedJob = await job.completed;
    if (completedJob.code !== 0) {
        if (!completedJob.statusRefreshed) {
            await refreshBackupStatus(type, completedJob);
        }
        const details = completedJob.stderr || completedJob.stdout;
        throw new Error(
            `${type.toUpperCase()} backup failed with code ${completedJob.code}${
                details ? `: ${details}` : ""
            }`
        );
    }
    return { backup: mapJob(completedJob) };
}

async function refreshScheduledBackupStatus(type: BackupJob["type"]) {
    const cacheKey = backupStatusCacheKey(type);
    const result = await refreshCacheProducer(cacheKey);
    return { key: cacheKey, ...result };
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

const backupStatusScheduledJobs = [
    {
        id: "backup.status.walg",
        name: "WAL-G backup status refresh",
        description: "Refresh WAL-G backup status without starting a backup.",
        scheduleType: "interval",
        intervalSeconds: 60 * 60,
        actionKey: "backup.status.refresh",
        actionPayload: { type: "walg" },
    },
    {
        id: "backup.status.kopia",
        name: "Kopia backup status refresh",
        description: "Refresh Kopia backup status without starting a backup.",
        scheduleType: "interval",
        intervalSeconds: 60 * 60,
        actionKey: "backup.status.refresh",
        actionPayload: { type: "kopia" },
    },
] as const;

export function registerBackupScheduledJobs(): void {
    registerScheduledJobAction(
        "backup.run",
        (job, signal) => {
            const type = getScheduledBackupType(job.actionPayload);
            if (type !== "kopia" && type !== "walg") {
                throw Object.assign(
                    new Error(`Scheduled backup job ${job.id} has invalid backup type`),
                    { statusCode: 400 }
                );
            }
            return startScheduledBackup(type, signal);
        },
        { timeoutMs: SCHEDULED_BACKUP_TIMEOUT_MS }
    );
    removeScheduledJobsNotInAction(
        "backup.run",
        backupScheduledJobs.map((job) => job.id)
    );
    registerScheduledJobAction("backup.status.refresh", (job) => {
        const type = getScheduledBackupType(job.actionPayload);
        if (type !== "kopia" && type !== "walg") {
            throw Object.assign(
                new Error(
                    `Scheduled backup status job ${job.id} has invalid backup type`
                ),
                { statusCode: 400 }
            );
        }
        return refreshScheduledBackupStatus(type);
    });
    removeScheduledJobsNotInAction(
        "backup.status.refresh",
        backupStatusScheduledJobs.map((job) => job.id)
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

    for (const job of backupStatusScheduledJobs) {
        const legacy = getScheduledJob(`cache.backup.${job.actionPayload.type}`);
        const existing = getScheduledJob(job.id) ?? legacy;
        upsertScheduledJob({
            ...job,
            enabled: existing?.enabled ?? true,
            scheduleType: existing?.scheduleType ?? job.scheduleType,
            intervalSeconds: existing?.intervalSeconds ?? job.intervalSeconds,
            timeOfDay: existing ? existing.timeOfDay : null,
            cronExpression: existing?.cronExpression ?? null,
        });
    }
}

export const __testing = {
    trimOutput,
    getCurrentJob,
    mapJob,
    getScheduledBackupType,
    startScheduledBackup,
    refreshScheduledBackupStatus,
    setSpawnBackupProcessForTest(nextSpawn?: typeof spawn): void {
        spawnBackupProcess = nextSpawn ?? spawn;
    },
    setBackupAbortContainerTimeoutsForTest(waitMs: number, pollMs: number): void {
        backupAbortContainerWaitMs = waitMs;
        backupAbortContainerPollMs = pollMs;
    },
    setBackupAbortDockerExecTimeoutForTest(timeoutMs: number): void {
        backupAbortDockerExecTimeoutMs = timeoutMs;
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
