import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

let cacheRefreshRunner = refreshCacheProducer;
const cacheRefreshCommandOverrides = new Map<string, string[] | undefined>();
const execFileAsync = promisify(execFile);

export const __testing = {
    getCacheRefreshCommand(key: string): string[] | undefined {
        return cacheRefreshCommandOverrides.get(key);
    },
    resetCacheRefreshForTests(): void {
        cacheRefreshRunner = refreshCacheProducer;
        cacheRefreshCommandOverrides.clear();
    },
    setCacheRefreshCommandForTests(key: string, command: string[] | undefined): void {
        if (command) {
            cacheRefreshCommandOverrides.set(key, command);
            cacheRefreshRunner = async (refreshKey: string) => {
                const override = cacheRefreshCommandOverrides.get(refreshKey);
                if (!override) {
                    return refreshCacheProducer(refreshKey);
                }
                const [file, ...args] = override;
                await execFileAsync(file, args, {
                    env: process.env,
                    encoding: "utf8",
                    maxBuffer: 10 * 1024 * 1024,
                    timeout: 60_000,
                });
                return { refreshed: [refreshKey] };
            };
            return;
        }
        cacheRefreshCommandOverrides.delete(key);
    },
    setCacheRefreshCwdForTests(_cwd: string | undefined): void {
        // Cache refresh no longer runs scripts from a cwd; retained for old tests.
    },
    setCacheRefreshRunnerForTests(nextRunner: typeof refreshCacheProducer): void {
        cacheRefreshRunner = nextRunner;
    },
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
    const result = (await cacheRefreshRunner(key)) as { refreshed?: unknown };
    if (!Array.isArray(result.refreshed) || result.refreshed.length === 0) {
        throw new Error(`Cache key not found after refresh: ${key}`);
    }
    const invalidRefreshedEntry = result.refreshed.find(
        (entry) => typeof entry !== "string"
    );
    if (invalidRefreshedEntry !== undefined) {
        throw new Error(
            `Invalid refreshed cache key for ${key}: ${JSON.stringify(invalidRefreshedEntry)}`
        );
    }
    const refreshedKeys = [...new Set(result.refreshed)];
    const refreshedRows = await Promise.all(
        refreshedKeys.map((refreshKey) => getCacheEntry(refreshKey))
    );
    const missingKeys = refreshedKeys.filter(
        (_refreshKey, index) => refreshedRows[index] === null
    );
    if (missingKeys.length > 0) {
        throw new Error(`Cache key not found after refresh: ${missingKeys.join(", ")}`);
    }
    const rows = refreshedRows as CacheEntryRow[];
    const mapped = rows.map(mapCacheRowForResponse);
    return mapped.length === 1 ? mapped[0] : mapped;
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
            const result = await refreshCacheKey(key);
            res.json(
                Array.isArray(result)
                    ? { ok: true, entries: result }
                    : { ok: true, entry: result }
            );
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
