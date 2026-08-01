import type { JobResourceClass, ScheduledJob } from "../../../contracts/jobs.ts";
import { database } from "../database.ts";
import {
    getCacheEntry,
    invalidateCacheEntry,
    parseJsonField,
} from "../lib/cacheStore.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import {
    getContainers,
    getDockerUpdaterEvents,
    getDockerUpdaterServices,
    getDockerUpdaterSummary,
    getImages,
    getVolumes,
} from "../routes/dockerRoutes.ts";
import { writeCacheSuccess } from "./cacheEntryWriter.ts";
import {
    refreshKopiaBackupCache,
    refreshWalgBackupCache,
} from "./cacheRefresh/backupCacheProducers.ts";
import { writeCacheFailure } from "./cacheRefresh/cacheEntryFailure.ts";
import { nowIso } from "./cacheRefresh/cacheProducerSupport.ts";
import { refreshGitCache } from "./cacheRefresh/gitCacheProducer.ts";
import {
    getMoltbookFailureKeys,
    MOLTBOOK_CACHE_KEY_LIST,
    MOLTBOOK_CACHE_KEYS,
    type MoltbookCacheKey,
    refreshMoltbookCache,
} from "./cacheRefresh/moltbookCacheProducer.ts";
import { refreshQuotasCache } from "./cacheRefresh/quotaCacheProducer.ts";
import { refreshSystemCache } from "./cacheRefresh/systemCacheProducer.ts";
import { refreshWeatherCache } from "./cacheRefresh/weatherCacheProducer.ts";
import {
    recordCacheRefreshCoalesced,
    recordCacheRefreshFinished,
    recordCacheRefreshRequest,
    recordCacheRefreshStarted,
} from "./cacheRefreshMetrics.ts";
import { getDatabaseOverview, getIsolatedDatabaseOverview } from "./databaseOverview.ts";
import {
    enqueueScheduledJob,
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    upsertScheduledJob,
} from "./scheduledJobs.ts";

const logger = createStructuredLogger("cache-refresh");

const LOG_ROTATION_STATE_KEY = "log_rotation.state";
const DOCKER_SUMMARY_KEY = "docker.summary";
export const DATABASE_SUMMARY_KEY = "database.summary";
const DATABASE_SUMMARY_JOB_ID = "cache.database.summary";

export { writeCacheSuccess } from "./cacheEntryWriter.ts";
export { writeCacheFailure } from "./cacheRefresh/cacheEntryFailure.ts";
export { refreshGitCache } from "./cacheRefresh/gitCacheProducer.ts";
export { refreshMoltbookCache } from "./cacheRefresh/moltbookCacheProducer.ts";
export { refreshWeatherCache } from "./cacheRefresh/weatherCacheProducer.ts";

function refreshLogRotationStateCache() {
    const row = database
        .prepare("SELECT data_json FROM cache_entries WHERE key = ? LIMIT 1")
        .get(LOG_ROTATION_STATE_KEY) as undefined | { data_json?: string | undefined };
    let data: unknown = { version: 1, files: {} };
    let isPreserveExistingData = false;
    if (row?.data_json) {
        try {
            data = JSON.parse(row.data_json) as unknown;
            isPreserveExistingData = true;
        } catch {
            data = { version: 1, files: {} };
        }
    } else {
        isPreserveExistingData = true;
    }
    writeCacheSuccess({
        key: LOG_ROTATION_STATE_KEY,
        data,
        source: "backend",
        ttl: 90 * 24,
        ttlUnit: "hours",
        metadata: {
            producer: "refreshCacheProducer",
            workflow: "Log Rotation - Foundation",
        },
        preserveExistingData: isPreserveExistingData,
    });
    return { refreshed: [LOG_ROTATION_STATE_KEY] };
}

async function refreshDockerSummaryCache() {
    const containers = await getContainers();
    const [images, volumes] = await Promise.all([
        getImages(containers),
        getVolumes(containers),
    ]);
    const updaterServices = getDockerUpdaterServices();
    const updaterEvents = getDockerUpdaterEvents(25);
    const payload = {
        checkedAt: nowIso(),
        containers,
        images,
        volumes,
        updaterServices,
        updaterEvents,
        updaterSummary: getDockerUpdaterSummary(updaterServices),
    };
    writeCacheSuccess({
        key: DOCKER_SUMMARY_KEY,
        data: payload,
        source: "backend",
        ttl: 45,
        ttlUnit: "minutes",
        metadata: {
            producer: "refreshCacheProducer",
            workflow: "Cache Foundation - Docker Summary",
            refreshIntervalMinutes: 30,
        },
    });
    return { refreshed: [DOCKER_SUMMARY_KEY] };
}

async function refreshDatabaseSummaryCache() {
    const isIsolated =
        process.env.NODE_ENV !== "production" &&
        process.env.MIRA_DASHBOARD_DEV_SAFE_MODE === "1";
    const previousEntry = isIsolated ? getCacheEntry(DATABASE_SUMMARY_KEY) : undefined;
    const previous = isIsolated
        ? parseJsonField<unknown>(previousEntry?.data || "")
        : undefined;
    const payload = {
        checkedAt: nowIso(),
        ...(isIsolated
            ? getIsolatedDatabaseOverview(previous)
            : await getDatabaseOverview()),
    };
    writeCacheSuccess({
        key: DATABASE_SUMMARY_KEY,
        data: payload,
        source: "backend",
        ttl: 90,
        ttlUnit: "minutes",
        metadata: {
            producer: "refreshCacheProducer",
            profile: isIsolated ? "isolated" : "full",
            workflow: "Cache Foundation - Database Summary",
            refreshIntervalMinutes: 60,
        },
    });
    return { refreshed: [DATABASE_SUMMARY_KEY] };
}

const inFlightCacheRefreshes = new Map<string, Promise<{ refreshed: string[] }>>();

function observeCacheRefreshMetric(event: string, operation: () => void): void {
    try {
        operation();
    } catch (error) {
        logger.warn("cache_refresh.metrics_write_failed", { error, metricEvent: event });
    }
}

class SerialOperationQueue {
    private tail: Promise<void> = Promise.resolve();

    private async observe(result: Promise<unknown>): Promise<void> {
        try {
            await result;
        } catch {
            // A failed operation must not block later queue entries.
        }
    }

    run<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.tail;
        const result = (async () => {
            await previous;
            return operation();
        })();
        this.tail = this.observe(result);
        return result;
    }
}

const cacheRefreshQueue = new SerialOperationQueue();
const localCacheSeedQueue = new SerialOperationQueue();

function cacheRefreshScopeKey(key: string): string {
    if (key === "moltbook") {
        return "moltbook";
    }
    if (key === "system.openclaw") {
        return "system.host";
    }
    return key;
}

function isSupportedCacheProducerKey(key: string): boolean {
    return (
        key === "moltbook" ||
        MOLTBOOK_CACHE_KEYS.has(key) ||
        key === "weather.spydeberg" ||
        key === "git.workspace" ||
        key === "system.openclaw" ||
        key === "system.host" ||
        key === "backup.kopia.status" ||
        key === "backup.walg.status" ||
        key === "quotas.summary" ||
        key === DOCKER_SUMMARY_KEY ||
        key === DATABASE_SUMMARY_KEY ||
        key === LOG_ROTATION_STATE_KEY
    );
}

export function cacheRefreshResourceClass(key: string): JobResourceClass {
    if (!isSupportedCacheProducerKey(key)) {
        throw Object.assign(
            new Error(`No backend refresh producer configured for cache key: ${key}`),
            { statusCode: 400 }
        );
    }
    if (
        key === "weather.spydeberg" ||
        key === "quotas.summary" ||
        key === "moltbook" ||
        MOLTBOOK_CACHE_KEYS.has(key)
    ) {
        return "network";
    }
    return "host-heavy";
}

async function refreshCacheWithFailureRecord(
    key: string,
    refresh: () => Promise<{ refreshed: string[] }> | { refreshed: string[] },
    failureKeys: string[] = [key]
) {
    try {
        return await refresh();
    } catch (error) {
        for (const failureKey of failureKeys) {
            writeCacheFailure({
                key: failureKey,
                source: "backend",
                ttl: 15,
                ttlUnit: "minutes",
                error,
                metadata: {
                    producer: "refreshCacheProducer",
                },
            });
        }
        throw error;
    }
}

async function refreshCacheProducerUnlocked(key: string) {
    if (key === "moltbook") {
        try {
            return await refreshMoltbookCache();
        } catch (error) {
            const failureKeys = getMoltbookFailureKeys(error) ?? [
                ...MOLTBOOK_CACHE_KEY_LIST,
            ];
            for (const failureKey of failureKeys) {
                writeCacheFailure({
                    key: failureKey,
                    source: "backend",
                    ttl: 15,
                    ttlUnit: "minutes",
                    error,
                    metadata: {
                        producer: "refreshCacheProducer",
                    },
                });
            }
            throw error;
        }
    }
    if (MOLTBOOK_CACHE_KEYS.has(key)) {
        return refreshCacheWithFailureRecord(key, () =>
            refreshMoltbookCache(key as MoltbookCacheKey)
        );
    }
    if (key.startsWith("moltbook.")) {
        throw Object.assign(new Error(`Unsupported Moltbook cache key: ${key}`), {
            statusCode: 400,
        });
    }
    if (key === "weather.spydeberg") {
        return refreshCacheWithFailureRecord(key, refreshWeatherCache);
    }
    if (key === "git.workspace") {
        return refreshCacheWithFailureRecord(key, refreshGitCache);
    }
    if (key === "system.host" || key === "system.openclaw") {
        return refreshCacheWithFailureRecord(key, refreshSystemCache, [
            "system.openclaw",
            "system.host",
        ]);
    }
    if (key === "backup.kopia.status") {
        return refreshCacheWithFailureRecord(key, refreshKopiaBackupCache);
    }
    if (key === "backup.walg.status") {
        return refreshCacheWithFailureRecord(key, refreshWalgBackupCache);
    }
    if (key === "quotas.summary") {
        return refreshCacheWithFailureRecord(key, refreshQuotasCache);
    }
    if (key === DOCKER_SUMMARY_KEY) {
        return refreshCacheWithFailureRecord(key, refreshDockerSummaryCache);
    }
    if (key === DATABASE_SUMMARY_KEY) {
        return refreshCacheWithFailureRecord(key, refreshDatabaseSummaryCache);
    }
    if (key === LOG_ROTATION_STATE_KEY) {
        return refreshCacheWithFailureRecord(key, refreshLogRotationStateCache);
    }
    throw Object.assign(
        new Error(`No backend refresh producer configured for cache key: ${key}`),
        {
            statusCode: 400,
        }
    );
}

function abortError(): Error {
    const error = new Error("Cache refresh aborted");
    Object.defineProperty(error, "name", {
        configurable: true,
        value: "AbortError",
    });
    return error;
}

function runBoundedCacheRefresh<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal
): Promise<T> {
    return cacheRefreshQueue.run(async () => {
        if (signal?.aborted) throw abortError();
        return await operation();
    });
}

async function waitForRefreshWithSignal<T>(
    refresh: Promise<T>,
    signal: AbortSignal | undefined
): Promise<T> {
    if (!signal) {
        return await refresh;
    }
    if (signal.aborted) {
        throw abortError();
    }
    let isAborted = false;
    const onAbort = () => {
        isAborted = true;
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
        // Keep the permit occupied until the producer really settles. Returning
        // on abort would let a second heavy producer overlap the first one.
        const result = await refresh;
        if (isAborted) throw abortError();
        return result;
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

async function waitForExistingRefresh(
    requestedKey: string,
    scopeKey: string,
    refresh: Promise<{ refreshed: string[] }>,
    signal: AbortSignal | undefined
): Promise<{ refreshed: string[] }> {
    try {
        return await waitForRefreshWithSignal(refresh, signal);
    } catch (error) {
        const failedKeys = getMoltbookFailureKeys(error);
        if (
            failedKeys &&
            MOLTBOOK_CACHE_KEYS.has(scopeKey) &&
            failedKeys.length > 0 &&
            !failedKeys.includes(scopeKey as MoltbookCacheKey)
        ) {
            return { refreshed: [requestedKey] };
        }
        throw error;
    }
}

export async function refreshCacheProducer(
    key: string,
    signal?: AbortSignal,
    options: { force?: boolean } = {}
) {
    observeCacheRefreshMetric("request", recordCacheRefreshRequest);
    if (signal?.aborted) {
        throw abortError();
    }
    const scopeKey = cacheRefreshScopeKey(key);
    const inFlightEntries = isSupportedCacheProducerKey(key)
        ? [...inFlightCacheRefreshes]
        : [];
    const existing = inFlightEntries
        .filter(
            ([inFlightKey]) =>
                inFlightKey === scopeKey || scopeKey.startsWith(`${inFlightKey}.`)
        )
        .toSorted(([left], [right]) => left.length - right.length)[0]?.[1];
    if (existing !== undefined && !options.force) {
        observeCacheRefreshMetric("coalesced", recordCacheRefreshCoalesced);
        return await waitForExistingRefresh(key, scopeKey, existing, signal);
    }
    const childRefreshes = inFlightEntries
        .filter(([inFlightKey]) =>
            options.force
                ? inFlightKey === scopeKey ||
                  inFlightKey.startsWith(`${scopeKey}.`) ||
                  scopeKey.startsWith(`${inFlightKey}.`)
                : inFlightKey.startsWith(`${scopeKey}.`)
        )
        .map(([, refresh]) => refresh);
    const refresh =
        childRefreshes.length > 0
            ? refreshAfterChildRefreshes(childRefreshes, key, signal)
            : runBoundedCacheRefresh(() => refreshCacheProducerUnlocked(key), signal);
    const startedAt = performance.now();
    observeCacheRefreshMetric("started", recordCacheRefreshStarted);
    inFlightCacheRefreshes.set(scopeKey, refresh);
    void (async () => {
        let failed = false;
        try {
            await refresh;
        } catch {
            failed = true;
            // The caller observes refresh failures.
        } finally {
            const durationMs =
                Math.round(Math.max(0, performance.now() - startedAt) * 100) / 100;
            observeCacheRefreshMetric("finished", () =>
                recordCacheRefreshFinished(durationMs, failed)
            );
            if (inFlightCacheRefreshes.get(scopeKey) === refresh) {
                inFlightCacheRefreshes.delete(scopeKey);
            }
        }
    })();
    return await waitForRefreshWithSignal(refresh, signal);
}

async function refreshAfterChildRefreshes(
    childRefreshes: Array<Promise<{ refreshed: string[] }>>,
    key: string,
    signal?: AbortSignal
): Promise<{ refreshed: string[] }> {
    await Promise.allSettled(childRefreshes);
    return await runBoundedCacheRefresh(() => refreshCacheProducerUnlocked(key), signal);
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
        const statusCode =
            error instanceof Error && "statusCode" in error
                ? (error as { statusCode?: unknown }).statusCode
                : undefined;
        if (statusCode !== 409) {
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
            const statusCode =
                error instanceof Error && "statusCode" in error
                    ? (error as { statusCode?: unknown }).statusCode
                    : undefined;
            if (statusCode !== 409) {
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
