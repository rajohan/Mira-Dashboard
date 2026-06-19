import express, { type RequestHandler } from "express";

import {
    type CacheEntryRow,
    getAllCacheEntries,
    getCacheEntry,
    parseJsonField,
} from "../lib/cacheStore.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import { stringFallback } from "../lib/values.ts";
import { refreshCacheProducer } from "../services/cacheRefresh.ts";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

type CacheRefreshProducer = (key: string) => Promise<void | { refreshed?: unknown }>;

/** Parses JSON field or value. */
export function parseJsonFieldOrValue(value: string) {
    const parsed = parseJsonField<unknown>(value);
    return parsed ?? value;
}

/** Performs map cache row for response. */
export function mapCacheRowForResponse(row: CacheEntryRow) {
    return {
        key: row.key,
        source: row.source,
        status: row.status,
        updatedAt: row.updated_at || null,
        lastAttemptAt: row.last_attempt_at || null,
        expiresAt: row.expires_at || null,
        errorCode: row.error_code || null,
        errorMessage: row.error_message || null,
        consecutiveFailures: Number(row.consecutive_failures || 0),
        data: parseJsonFieldOrValue(row.data),
        meta: parseJsonField<unknown>(row.meta) ?? {},
    };
}

/** Performs refresh cache key. */
export async function refreshCacheKey(key: string) {
    const producer: CacheRefreshProducer = refreshCacheProducer;
    const result = await producer(key);
    const refreshed = Array.isArray(result?.refreshed) ? result.refreshed : [];
    if (refreshed.length === 0) {
        throw Object.assign(new Error(`No cache keys refreshed for: ${key}`), {
            statusCode: 404,
        });
    }
    const refreshedKeys = refreshed
        .map((refreshedKey) => stringFallback(refreshedKey).trim())
        .filter((refreshedKey) => refreshedKey !== "");
    const refreshedKey =
        refreshedKeys.find((candidate) => candidate === key) ?? refreshedKeys[0] ?? "";
    if (!refreshedKey) {
        throw Object.assign(new Error(`No cache keys refreshed for: ${key}`), {
            statusCode: 404,
        });
    }
    if (refreshedKeys.length > 1 && !refreshedKeys.includes(key)) {
        throw Object.assign(
            new Error(`Cache refresh returned multiple keys for: ${key}`),
            { statusCode: 400 }
        );
    }
    const row = await getCacheEntry(refreshedKey);
    if (!row) {
        throw new Error(`Cache key not found after refresh: ${refreshedKey}`);
    }
    return mapCacheRowForResponse(row);
}

/** Registers cache API routes. */
export default function cacheRoutes(app: express.Application): void {
    app.get("/api/cache/heartbeat", (async (_request, response) => {
        const cacheEntries = await getAllCacheEntries();
        const mapped = cacheEntries.map(mapCacheRowForResponse);
        response.json({
            generatedAt: dateToISOString(new Date()),
            count: mapped.length,
            entries: mapped,
        });
    }) as RequestHandler);

    app.post("/api/cache/:key/refresh", (async (request, response) => {
        const key = stringFallback(request.params.key).trim();
        if (!key) {
            response.status(400).json({ error: "Missing cache key" });
            return;
        }

        try {
            const entry = await refreshCacheKey(key);
            response.json({ isOk: true, entry });
        } catch (error) {
            response.status(httpStatusCode(error)).json({
                error: errorMessage(error, "Cache refresh failed"),
            });
        }
    }) as RequestHandler);

    app.get("/api/cache/:key", (async (request, response) => {
        const key = stringFallback(request.params.key).trim();
        if (!key) {
            response.status(400).json({ error: "Missing cache key" });
            return;
        }

        const row = await getCacheEntry(key);
        if (!row) {
            response.status(404).json({ error: "Cache key not found", key });
            return;
        }

        response.json(mapCacheRowForResponse(row));
    }) as RequestHandler);
}
