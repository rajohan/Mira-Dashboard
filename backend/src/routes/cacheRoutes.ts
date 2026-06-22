import { json } from "../http.ts";
import {
    type CacheEntryRow,
    getAllCacheEntries,
    getCacheEntry,
    parseJsonField,
} from "../lib/cacheStore.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import { stringFallback } from "../lib/values.ts";
import { refreshCacheProducer } from "../services/cacheRefresh.ts";

function parseJsonFieldOrValue(value: string) {
    const parsed = parseJsonField<unknown>(value);
    return parsed ?? value;
}

function mapCacheRowForResponse(row: CacheEntryRow) {
    return {
        consecutiveFailures: Number(row.consecutive_failures) || 0,
        data: parseJsonFieldOrValue(row.data),
        errorCode: row.error_code || null,
        errorMessage: row.error_message || null,
        expiresAt: row.expires_at || null,
        key: row.key,
        lastAttemptAt: row.last_attempt_at || null,
        meta: parseJsonField<unknown>(row.meta) ?? {},
        source: row.source,
        status: row.status,
        updatedAt: row.updated_at || null,
    };
}

async function refreshCacheKey(key: string) {
    const result = await refreshCacheProducer(key);
    const refreshed = Array.isArray(result?.refreshed) ? result.refreshed : [];
    if (refreshed.length === 0) {
        throw Object.assign(new Error(`No cache keys refreshed for: ${key}`), {
            statusCode: 404,
        });
    }
    const refreshedKeys = refreshed
        .map((refreshedKey) => stringFallback(refreshedKey).trim())
        .filter((refreshedKey) => refreshedKey !== "");
    const refreshedKey = refreshedKeys.find((candidate) => candidate === key);
    if (!refreshedKey) {
        throw Object.assign(new Error(`No cache keys refreshed for: ${key}`), {
            statusCode: refreshedKeys.length > 0 ? 400 : 404,
        });
    }
    const row = await getCacheEntry(refreshedKey);
    if (!row) {
        throw new Error(`Cache key not found after refresh: ${refreshedKey}`);
    }
    return mapCacheRowForResponse(row);
}

type ParametersRequest<T extends string> = Request & { params: Record<T, string> };

export const cacheRoutes = {
    "/api/cache/heartbeat": {
        GET: async () => {
            const rows = await getAllCacheEntries();
            const entries = rows.map(mapCacheRowForResponse);
            return json({
                count: entries.length,
                entries,
                generatedAt: new Date().toISOString(),
            });
        },
    },
    "/api/cache/:key": {
        GET: async (request: ParametersRequest<"key">) => {
            const key = stringFallback(request.params.key).trim();
            if (!key) return json({ error: "Missing cache key" }, { status: 400 });
            const row = await getCacheEntry(key);
            if (!row) return json({ error: "Cache key not found", key }, { status: 404 });
            return json(mapCacheRowForResponse(row));
        },
    },
    "/api/cache/:key/refresh": {
        POST: async (request: ParametersRequest<"key">) => {
            const key = stringFallback(request.params.key).trim();
            if (!key) return json({ error: "Missing cache key" }, { status: 400 });
            try {
                return json({ entry: await refreshCacheKey(key), isOk: true });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Cache refresh failed") },
                    { status: httpStatusCode(error) }
                );
            }
        },
    },
} as const;
