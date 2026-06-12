import express, { type RequestHandler } from "express";

import {
    type CacheEntryRow,
    getAllCacheEntries,
    getCacheEntry,
    parseJsonField,
} from "../lib/cacheStore.js";
import { errorMessage } from "../lib/errors.js";
import { stringFallback } from "../lib/values.js";
import { refreshCacheProducer } from "../services/cacheRefresh.js";

interface HttpStatusError extends Error {
    statusCode?: number;
}

type CacheRefreshProducer = (key: string) => Promise<unknown>;
let cacheRefreshProducerForTests: CacheRefreshProducer | null = null;

function setCacheRefreshProducerForTests(producer: CacheRefreshProducer | null): void {
    cacheRefreshProducerForTests = producer;
}

function resetCacheRefreshForTests(): void {
    cacheRefreshProducerForTests = null;
}

export const __testing = {
    resetCacheRefreshForTests,
    setCacheRefreshProducerForTests,
};

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
    const producer = cacheRefreshProducerForTests ?? refreshCacheProducer;
    await producer(key);
    const row = await getCacheEntry(key);
    if (!row) {
        throw new Error(`Cache key not found after refresh: ${key}`);
    }
    return mapCacheRowForResponse(row);
}

/** Registers cache API routes. */
export default function cacheRoutes(app: express.Application): void {
    app.get("/api/cache/heartbeat", (async (_req, res) => {
        const cacheEntries = await getAllCacheEntries();
        const mapped = cacheEntries.map(mapCacheRowForResponse);
        res.json({
            generatedAt: new Date().toISOString(),
            count: mapped.length,
            entries: mapped,
        });
    }) as RequestHandler);

    app.post("/api/cache/:key/refresh", (async (req, res) => {
        const key = stringFallback(req.params.key).trim();
        if (!key) {
            res.status(400).json({ error: "Missing cache key" });
            return;
        }

        try {
            const entry = await refreshCacheKey(key);
            res.json({ ok: true, entry });
        } catch (error) {
            res.status((error as HttpStatusError).statusCode || 500).json({
                error: errorMessage(error, "Cache refresh failed"),
            });
        }
    }) as RequestHandler);

    app.get("/api/cache/:key", (async (req, res) => {
        const key = stringFallback(req.params.key).trim();
        if (!key) {
            res.status(400).json({ error: "Missing cache key" });
            return;
        }

        const row = await getCacheEntry(key);
        if (!row) {
            res.status(404).json({ error: "Cache key not found", key });
            return;
        }

        res.json(mapCacheRowForResponse(row));
    }) as RequestHandler);
}
