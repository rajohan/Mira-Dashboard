import type { ScheduledJob } from "../../../../contracts/jobs.ts";
import { database } from "../../database.ts";
import { invalidateCacheEntry } from "../../lib/cacheStore.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import {
    enqueueScheduledJob,
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    upsertScheduledJob,
} from "../scheduledJobs.ts";
import { cacheRefreshScopeKey } from "./cacheProducerRegistry.ts";
import { refreshCacheProducer } from "./cacheRefreshRuntime.ts";
import { DATABASE_SUMMARY_KEY } from "./databaseSummaryCacheProducer.ts";
import { DOCKER_SUMMARY_KEY } from "./dockerSummaryCacheProducer.ts";
import { MOLTBOOK_CACHE_KEY_LIST } from "./moltbookCacheProducer.ts";
import { SerialOperationQueue } from "./serialOperationQueue.ts";

const logger = createStructuredLogger("cache-refresh");
const DATABASE_SUMMARY_JOB_ID = "cache.database.summary";

function isConflictError(error: unknown): boolean {
    return (
        error instanceof Error &&
        "statusCode" in error &&
        (error as { statusCode?: unknown }).statusCode === 409
    );
}

const cacheRefreshScheduledJobs = [
    {
        id: "cache.weather",
        name: "Weather cache",
        description: "Refresh Spydeberg weather cache.",
        scheduleType: "interval",
        intervalSeconds: 60 * 60,
        actionKey: "cache.refresh",
        actionPayload: { key: "weather.spydeberg" },
        resourceClass: "network",
    },
    {
        id: "cache.quotas",
        name: "Quota cache",
        description: "Refresh provider quota summaries.",
        scheduleType: "interval",
        intervalSeconds: 30 * 60,
        actionKey: "cache.refresh",
        actionPayload: { key: "quotas.summary" },
        resourceClass: "network",
    },
    {
        id: "cache.system",
        name: "System cache",
        description: "Refresh host and OpenClaw system checks.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "02:50",
        actionKey: "cache.refresh",
        actionPayload: { key: "system.host" },
        resourceClass: "host-heavy",
    },
    {
        id: "cache.git",
        name: "Git cache",
        description: "Refresh workspace git status cache.",
        scheduleType: "interval",
        intervalSeconds: 60 * 60,
        actionKey: "cache.refresh",
        actionPayload: { key: "git.workspace" },
        resourceClass: "host-heavy",
    },
    {
        id: "cache.moltbook",
        name: "Moltbook cache",
        description: "Refresh Moltbook home, feeds, profile, and own content caches.",
        scheduleType: "interval",
        intervalSeconds: 30 * 60,
        actionKey: "cache.refresh",
        actionPayload: { key: "moltbook" },
        resourceClass: "network",
    },
    {
        id: "cache.backup.kopia",
        name: "Kopia backup status cache",
        description: "Refresh Kopia backup status cache.",
        scheduleType: "interval",
        intervalSeconds: 60 * 60,
        actionKey: "cache.refresh",
        actionPayload: { key: "backup.kopia.status" },
        resourceClass: "host-heavy",
    },
    {
        id: "cache.backup.walg",
        name: "WAL-G backup status cache",
        description: "Refresh WAL-G backup status cache.",
        scheduleType: "interval",
        intervalSeconds: 60 * 60,
        actionKey: "cache.refresh",
        actionPayload: { key: "backup.walg.status" },
        resourceClass: "host-heavy",
    },
    {
        id: "cache.docker.summary",
        name: "Docker summary cache",
        description: "Refresh Docker overview cache.",
        scheduleType: "interval",
        intervalSeconds: 30 * 60,
        actionKey: "cache.refresh",
        actionPayload: { key: DOCKER_SUMMARY_KEY },
        resourceClass: "host-heavy",
    },
    {
        id: DATABASE_SUMMARY_JOB_ID,
        name: "Database summary cache",
        description: "Refresh database overview cache.",
        scheduleType: "interval",
        intervalSeconds: 60 * 60,
        actionKey: "cache.refresh",
        actionPayload: { key: DATABASE_SUMMARY_KEY },
        resourceClass: "host-heavy",
    },
] as const;

export function cacheRefreshScheduledJobId(key: string): string | undefined {
    const scheduledKey = cacheRefreshScopeKey(key);
    return cacheRefreshScheduledJobs.find((job) => job.actionPayload.key === scheduledKey)
        ?.id;
}

/** Invalidates and queues the database summary after SQLite lifecycle changes. */
export function enqueueDatabaseSummaryRefresh(): void {
    invalidateCacheEntry(DATABASE_SUMMARY_KEY);
    try {
        enqueueScheduledJob(DATABASE_SUMMARY_JOB_ID, "system");
    } catch (error) {
        if (!isConflictError(error)) {
            throw error;
        }
    }
}

function getScheduledCacheKey(job: ScheduledJob): string {
    const key = job.actionPayload.key;
    if (typeof key !== "string" || key.trim() === "") {
        throw Object.assign(
            new Error(`Scheduled cache job ${job.id} is missing actionPayload.key`),
            { statusCode: 400 }
        );
    }
    return key;
}

function isCacheEntryFresh(key: string): boolean {
    let keys: readonly string[] = [key];
    if (key === "system.host" || key === "system.openclaw") {
        keys = ["system.openclaw", "system.host"];
    }
    if (key === "moltbook") {
        keys = MOLTBOOK_CACHE_KEY_LIST;
    }
    const statement = database.prepare(
        "SELECT status, expires_at FROM cache_entries WHERE key = ? LIMIT 1"
    );
    return keys.every((cacheKey) => {
        const row = statement.get(cacheKey) as
            | undefined
            | { status: string; expires_at: string };
        if (!row || row.status !== "fresh") {
            return false;
        }
        const expiresAtMs =
            row.expires_at === "" ? Number.NaN : Date.parse(row.expires_at);
        return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
    });
}

const localCacheSeedQueue = new SerialOperationQueue();
const localCacheSeedPromises = new Map<string, Promise<void>>();

type CacheSeedStrategy = "local" | "none" | "queue";

interface CacheRefreshScheduledJobOptions {
    allowedKeys?: readonly string[];
    refreshDatabaseOnStartup?: boolean;
    seedStrategy?: CacheSeedStrategy;
}

export function waitForLocalCacheSeed(key: string): Promise<void> {
    return localCacheSeedPromises.get(key) ?? Promise.resolve();
}

export function seedMissingLocalCacheEntry(key: string): void {
    if (isCacheEntryFresh(key) || localCacheSeedPromises.has(key)) {
        return;
    }
    const seedPromise = localCacheSeedQueue.run(async () => {
        try {
            await refreshCacheProducer(key);
        } catch (error) {
            logger.warn("cache_refresh.seed_failed", { cacheKey: key, error });
            throw error;
        }
    });
    localCacheSeedPromises.set(key, seedPromise);
    void (async () => {
        try {
            await seedPromise;
        } catch {
            // Cache seeding is best-effort for callers that do not await it.
        } finally {
            if (localCacheSeedPromises.get(key) === seedPromise) {
                localCacheSeedPromises.delete(key);
            }
        }
    })();
}

function queueMissingCacheSeeds(
    seedJobs: Array<{ id: string; key: string }>,
    firstKey?: string
): void {
    const startedAt = Date.now();
    const missingSeeds = seedJobs.filter((seedJob) => !isCacheEntryFresh(seedJob.key));
    const firstSeed = firstKey
        ? missingSeeds.find((seedJob) => seedJob.key === firstKey)
        : undefined;
    const orderedSeeds = firstSeed
        ? [firstSeed, ...missingSeeds.filter((seedJob) => seedJob !== firstSeed)]
        : missingSeeds;
    for (const [index, seedJob] of orderedSeeds.entries()) {
        const scheduledJob = getScheduledJob(seedJob.id);
        if (scheduledJob?.nextRunAt && Date.parse(scheduledJob.nextRunAt) <= startedAt) {
            continue;
        }
        const staggerMs = index * 5000 + Math.floor(Math.random() * 2500);
        try {
            enqueueScheduledJob(seedJob.id, "startup", {
                availableAt: new Date(startedAt + staggerMs).toISOString(),
            });
        } catch (error) {
            if (!isConflictError(error)) {
                logger.warn("cache_refresh.startup_seed_queue_failed", {
                    cacheKey: seedJob.key,
                    error,
                });
            }
        }
    }
}

export function registerCacheRefreshScheduledJobs(
    options: CacheRefreshScheduledJobOptions = {}
): void {
    const allowedKeys = options.allowedKeys ? new Set(options.allowedKeys) : undefined;
    const registeredJobs = cacheRefreshScheduledJobs;
    registerScheduledJobAction("cache.refresh", async (job, signal) => {
        const key = getScheduledCacheKey(job);
        if (allowedKeys && !allowedKeys.has(key)) {
            throw Object.assign(
                new Error(`Cache refresh is not allowed in this job profile: ${key}`),
                { statusCode: 403 }
            );
        }
        const result = await refreshCacheProducer(key, signal);
        return { key, ...result };
    });
    const seedJobs: Array<{ id: string; key: string }> = [];
    database.run("BEGIN IMMEDIATE");
    try {
        removeScheduledJobsNotInAction(
            "cache.refresh",
            registeredJobs.map((job) => job.id)
        );

        for (const job of registeredJobs) {
            const existing = getScheduledJob(job.id);
            const isAllowed = !allowedKeys || allowedKeys.has(job.actionPayload.key);
            let timeOfDay: string | undefined =
                "timeOfDay" in job && typeof job.timeOfDay === "string"
                    ? job.timeOfDay
                    : undefined;
            if (existing) {
                timeOfDay = existing.timeOfDay;
            }
            let cronExpression: string | undefined;
            if (existing) {
                cronExpression = existing.cronExpression;
            } else if (
                "cronExpression" in job &&
                typeof job.cronExpression === "string"
            ) {
                cronExpression = job.cronExpression;
            }
            upsertScheduledJob({
                ...job,
                enabled: isAllowed ? (existing?.enabled ?? true) : false,
                scheduleType: existing?.scheduleType ?? job.scheduleType,
                intervalSeconds: existing?.intervalSeconds ?? job.intervalSeconds,
                timeOfDay,
                cronExpression,
            });
            if (isAllowed && (existing?.enabled ?? true)) {
                seedJobs.push({ id: job.id, key: job.actionPayload.key });
            }
        }
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the original transaction failure.
        }
        throw error;
    }
    if (
        options.refreshDatabaseOnStartup &&
        seedJobs.some((seedJob) => seedJob.key === DATABASE_SUMMARY_KEY)
    ) {
        invalidateCacheEntry(DATABASE_SUMMARY_KEY);
    }
    if (options.seedStrategy === "queue") {
        queueMissingCacheSeeds(
            seedJobs,
            options.refreshDatabaseOnStartup ? DATABASE_SUMMARY_KEY : undefined
        );
    } else if (options.seedStrategy === "local") {
        for (const seedJob of seedJobs) {
            seedMissingLocalCacheEntry(seedJob.key);
        }
    }
}
