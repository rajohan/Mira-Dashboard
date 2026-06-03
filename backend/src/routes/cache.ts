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
import { envFallback, nonEmptyEnvFallback, stringFallback } from "../lib/values.js";

const execFileAsync = promisify(execFile);
const N8N_ROOT = "/home/ubuntu/projects/n8n";
const N8N_DATABASE = "n8n";
const CACHE_REFRESH_TIMEOUT_MS = 60_000;
const CACHE_REFRESH_MAX_BUFFER = 10 * 1024 * 1024;
let cacheRefreshCwd = N8N_ROOT;

interface HttpStatusError extends Error {
    statusCode?: number;
}

const CACHE_REFRESH_SCRIPTS: Record<string, string> = {
    "git.workspace": "git-cache.mjs",
    "moltbook.home": "moltbook-cache.mjs",
    "moltbook.feed.hot": "moltbook-feed-cache.mjs",
    "moltbook.feed.new": "moltbook-feed-cache.mjs",
    "moltbook.profile": "moltbook-profile-cache.mjs",
    "moltbook.my-content": "moltbook-profile-cache.mjs",
    "quotas.summary": "quotas-cache.mjs",
    "system.host": "system-cache.mjs",
    "backup.kopia.status": "backup-kopia-status.mjs",
    "backup.walg.status": "backup-walg-status.mjs",
    "weather.spydeberg": "weather-cache.mjs",
};

function buildCacheRefreshCommand(scriptName: string): string[] {
    const dopplerBin = nonEmptyEnvFallback("DOPPLER_BIN", "/usr/local/bin/doppler");
    return [
        dopplerBin,
        "run",
        "--project",
        "rajohan",
        "--config",
        "prd",
        "--",
        "node",
        `${cacheRefreshCwd}/scripts/${scriptName}`,
    ];
}

function envFallbackUnlessBlank(name: string, fallbackName: string): string {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") {
        return value;
    }

    const fallback = envFallback(fallbackName, "");
    return fallback.trim() === "" ? "" : fallback.trim();
}

function getCacheRefreshCommand(key: string): string[] | undefined {
    const scriptName = CACHE_REFRESH_SCRIPTS[key];
    return scriptName ? buildCacheRefreshCommand(scriptName) : undefined;
}

const cacheRefreshCommandOverrides = new Map<string, string[] | undefined>();

function setCacheRefreshCommandForTests(
    key: string,
    command: string[] | undefined
): void {
    if (command) {
        cacheRefreshCommandOverrides.set(key, command);
        return;
    }
    cacheRefreshCommandOverrides.delete(key);
}

function setCacheRefreshCwdForTests(cwd: string | undefined): void {
    cacheRefreshCwd = cwd ?? N8N_ROOT;
}

function resetCacheRefreshForTests(): void {
    cacheRefreshCommandOverrides.clear();
    cacheRefreshCwd = N8N_ROOT;
}

export const __testing = {
    getCacheRefreshCommand,
    resetCacheRefreshForTests,
    setCacheRefreshCommandForTests,
    setCacheRefreshCwdForTests,
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
    const command = cacheRefreshCommandOverrides.has(key)
        ? cacheRefreshCommandOverrides.get(key)
        : getCacheRefreshCommand(key);
    if (!command) {
        const error = new Error(
            `No refresh command configured for cache key: ${key}`
        ) as HttpStatusError;
        error.statusCode = 400;
        throw error;
    }
    const env = {
        ...process.env,
        DB_POSTGRESDB_HOST: "127.0.0.1",
        DB_POSTGRESDB_PORT: "6432",
        DB_POSTGRESDB_DATABASE: N8N_DATABASE,
        DB_POSTGRESDB_USER:
            envFallbackUnlessBlank("DB_POSTGRESDB_USER", "DATABASE_USERNAME") ||
            "postgres",
        DB_POSTGRESDB_PASSWORD:
            envFallbackUnlessBlank("DB_POSTGRESDB_PASSWORD", "DATABASE_PASSWORD") ||
            "postgres",
    };

    const [file, ...args] = command;
    await execFileAsync(file, args, {
        cwd: cacheRefreshCwd,
        env,
        encoding: "utf8",
        maxBuffer: CACHE_REFRESH_MAX_BUFFER,
        timeout: CACHE_REFRESH_TIMEOUT_MS,
    });
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
