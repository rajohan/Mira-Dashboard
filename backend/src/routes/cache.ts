import express, { type RequestHandler } from "express";

import { getAllCacheEntries, getCacheEntry, parseJsonField, type CacheEntryRow } from "../lib/cacheStore.js";

function parseJsonFieldOrValue(value: string) {
    const parsed = parseJsonField<unknown>(value);
    return parsed ?? value;
}

function mapCacheRow(row: CacheEntryRow) {
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

export default function cacheRoutes(app: express.Application): void {
    app.get("/api/cache/heartbeat", (async (_req, res) => {
        const mapped = (await getAllCacheEntries()).map(mapCacheRow);
        res.json({
            generatedAt: new Date().toISOString(),
            count: mapped.length,
            entries: mapped,
        });
    }) as RequestHandler);

    app.get("/api/cache/:key", (async (req, res) => {
        const key = String(req.params.key || "").trim();
        if (!key) {
            res.status(400).json({ error: "Missing cache key" });
            return;
        }

        const row = await getCacheEntry(key);
        if (!row) {
            res.status(404).json({ error: "Cache key not found", key });
            return;
        }

        res.json(mapCacheRow(row));
    }) as RequestHandler);
}
