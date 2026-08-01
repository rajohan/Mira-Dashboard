import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import {
    recordCacheRefreshCoalesced,
    recordCacheRefreshFinished,
    recordCacheRefreshRequest,
    recordCacheRefreshStarted,
} from "../cacheRefreshMetrics.ts";
import {
    assertSupportedCacheProducerKey,
    cacheRefreshScopeKey,
    refreshCacheProducerUnlocked,
} from "./cacheProducerRegistry.ts";
import {
    getMoltbookFailureKeys,
    MOLTBOOK_CACHE_KEYS,
    type MoltbookCacheKey,
} from "./moltbookCacheProducer.ts";
import { SerialOperationQueue } from "./serialOperationQueue.ts";

const logger = createStructuredLogger("cache-refresh");
const inFlightCacheRefreshes = new Map<string, Promise<{ refreshed: string[] }>>();
// One global permit intentionally bounds aggregate producer load on this host.
const cacheRefreshQueue = new SerialOperationQueue();

function observeCacheRefreshMetric(event: string, operation: () => void): void {
    try {
        operation();
    } catch (error) {
        logger.warn("cache_refresh.metrics_write_failed", { error, metricEvent: event });
    }
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

async function refreshAfterChildRefreshes(
    childRefreshes: Array<Promise<{ refreshed: string[] }>>,
    key: string,
    signal?: AbortSignal
): Promise<{ refreshed: string[] }> {
    await Promise.allSettled(childRefreshes);
    return await runBoundedCacheRefresh(() => refreshCacheProducerUnlocked(key), signal);
}

/**
 * Coordinates cache refresh serialization, coalescing, cancellation, and metrics.
 * @param key Registered cache key.
 * @param signal Optional cancellation signal.
 * @param options Refresh coordination options.
 * @returns Refreshed cache keys.
 */
export async function refreshCacheProducer(
    key: string,
    signal?: AbortSignal,
    options: { force?: boolean } = {}
): Promise<{ refreshed: string[] }> {
    assertSupportedCacheProducerKey(key);
    observeCacheRefreshMetric("request", recordCacheRefreshRequest);
    if (signal?.aborted) {
        throw abortError();
    }
    const scopeKey = cacheRefreshScopeKey(key);
    const inFlightEntries = [...inFlightCacheRefreshes];
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
