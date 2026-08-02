import type { JobResourceClass } from "../../../../contracts/jobs/shared.ts";
import {
    refreshKopiaBackupCache,
    refreshWalgBackupCache,
} from "./backupCacheProducers.ts";
import { writeCacheFailure } from "./cacheEntryFailure.ts";
import {
    DATABASE_SUMMARY_KEY,
    refreshDatabaseSummaryCache,
} from "./databaseSummaryCacheProducer.ts";
import {
    DOCKER_SUMMARY_KEY,
    refreshDockerSummaryCache,
} from "./dockerSummaryCacheProducer.ts";
import { refreshGitCache } from "./gitCacheProducer.ts";
import {
    LOG_ROTATION_STATE_KEY,
    refreshLogRotationStateCache,
} from "./logRotationCacheProducer.ts";
import {
    getMoltbookFailureKeys,
    MOLTBOOK_CACHE_KEY_LIST,
    MOLTBOOK_CACHE_KEYS,
    type MoltbookCacheKey,
    refreshMoltbookCache,
} from "./moltbookCacheProducer.ts";
import { refreshQuotasCache } from "./quotaCacheProducer.ts";
import { refreshSystemCache } from "./systemCacheProducer.ts";
import { refreshWeatherCache } from "./weatherCacheProducer.ts";

/**
 * Maps cache aliases to the producer scope used for in-flight coalescing.
 * @param key Requested cache key.
 * @returns Coalescing scope key.
 */
export function cacheRefreshScopeKey(key: string): string {
    if (key === "moltbook") {
        return "moltbook";
    }
    if (key === "system.openclaw") {
        return "system.host";
    }
    return key;
}

/**
 * Returns whether the registry owns the requested cache key.
 * @param key Requested cache key.
 * @returns Whether a producer is registered.
 */
export function isSupportedCacheProducerKey(key: string): boolean {
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

function unsupportedCacheKeyError(key: string): Error {
    const message = key.startsWith("moltbook.")
        ? `Unsupported Moltbook cache key: ${key}`
        : `No backend refresh producer configured for cache key: ${key}`;
    return Object.assign(new Error(message), { statusCode: 400 });
}

export function assertSupportedCacheProducerKey(key: string): void {
    if (!isSupportedCacheProducerKey(key)) {
        throw unsupportedCacheKeyError(key);
    }
}

/**
 * Returns the execution resource class for a registered cache producer.
 * @param key Registered cache key.
 * @returns Scheduled-job resource class.
 */
export function cacheRefreshResourceClass(key: string): JobResourceClass {
    assertSupportedCacheProducerKey(key);
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
    failureKeys?: string[] | ((error: unknown) => string[])
): Promise<{ refreshed: string[] }> {
    try {
        return await refresh();
    } catch (error) {
        const resolvedFailureKeys =
            typeof failureKeys === "function"
                ? failureKeys(error)
                : (failureKeys ?? [key]);
        for (const failureKey of resolvedFailureKeys) {
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

/**
 * Runs the producer registered for one cache key without queue coordination.
 * @param key Registered cache key.
 * @returns Refreshed cache keys.
 */
export async function refreshCacheProducerUnlocked(
    key: string
): Promise<{ refreshed: string[] }> {
    if (key === "moltbook") {
        return refreshCacheWithFailureRecord(
            key,
            refreshMoltbookCache,
            (error) => getMoltbookFailureKeys(error) ?? [...MOLTBOOK_CACHE_KEY_LIST]
        );
    }
    if (MOLTBOOK_CACHE_KEYS.has(key)) {
        return refreshCacheWithFailureRecord(key, () =>
            refreshMoltbookCache(key as MoltbookCacheKey)
        );
    }
    if (key.startsWith("moltbook.")) {
        throw unsupportedCacheKeyError(key);
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
    throw unsupportedCacheKeyError(key);
}
