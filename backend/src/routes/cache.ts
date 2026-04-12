import { execFile } from "node:child_process";
import { promisify } from "node:util";

import express, { type RequestHandler } from "express";

import { getAllCacheEntries, getCacheEntry, parseJsonField, type CacheEntryRow } from "../lib/cacheStore.js";

const execFileAsync = promisify(execFile);
const N8N_ROOT = "/home/ubuntu/projects/n8n";
const N8N_DATABASE = "n8n";

const CACHE_REFRESH_COMMANDS: Record<string, string[]> = {
    "git.workspace": ["/usr/local/bin/doppler", "run", "--project", "rajohan", "--config", "prd", "--", "node", `${N8N_ROOT}/scripts/git-cache.mjs`],
    "moltbook.home": ["/usr/local/bin/doppler", "run", "--project", "rajohan", "--config", "prd", "--", "node", `${N8N_ROOT}/scripts/moltbook-cache.mjs`],
    "moltbook.feed.hot": ["/usr/local/bin/doppler", "run", "--project", "rajohan", "--config", "prd", "--", "node", `${N8N_ROOT}/scripts/moltbook-feed-cache.mjs`],
    "moltbook.feed.new": ["/usr/local/bin/doppler", "run", "--project", "rajohan", "--config", "prd", "--", "node", `${N8N_ROOT}/scripts/moltbook-feed-cache.mjs`],
    "moltbook.profile": ["/usr/local/bin/doppler", "run", "--project", "rajohan", "--config", "prd", "--", "node", `${N8N_ROOT}/scripts/moltbook-profile-cache.mjs`],
    "moltbook.my-content": ["/usr/local/bin/doppler", "run", "--project", "rajohan", "--config", "prd", "--", "node", `${N8N_ROOT}/scripts/moltbook-profile-cache.mjs`],
    "quotas.summary": ["/usr/local/bin/doppler", "run", "--project", "rajohan", "--config", "prd", "--", "node", `${N8N_ROOT}/scripts/quotas-cache.mjs`],
    "system.openclaw": ["/usr/local/bin/doppler", "run", "--project", "rajohan", "--config", "prd", "--", "node", `${N8N_ROOT}/scripts/system-cache.mjs`],
    "system.host": ["/usr/local/bin/doppler", "run", "--project", "rajohan", "--config", "prd", "--", "node", `${N8N_ROOT}/scripts/system-cache.mjs`],
    "backup.kopia.status": ["/usr/local/bin/doppler", "run", "--project", "rajohan", "--config", "prd", "--", "node", `${N8N_ROOT}/scripts/backup-kopia-status.mjs`],
    "weather.spydeberg": ["/usr/local/bin/doppler", "run", "--project", "rajohan", "--config", "prd", "--", "node", `${N8N_ROOT}/scripts/weather-cache.mjs`],
};

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

export async function refreshCacheKey(key: string) {
    const command = CACHE_REFRESH_COMMANDS[key];
    if (!command) {
        throw new Error(`No refresh command configured for cache key: ${key}`);
    }

    const env = {
        ...process.env,
        DB_POSTGRESDB_HOST: "127.0.0.1",
        DB_POSTGRESDB_PORT: "6432",
        DB_POSTGRESDB_DATABASE: N8N_DATABASE,
        DB_POSTGRESDB_USER: process.env.DATABASE_USERNAME || "",
        DB_POSTGRESDB_PASSWORD: process.env.DATABASE_PASSWORD || "",
    };

    const [file, ...args] = command;
    await execFileAsync(file, args, {
        cwd: N8N_ROOT,
        env,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
    });

    const row = await getCacheEntry(key);
    if (!row) {
        throw new Error(`Cache key not found after refresh: ${key}`);
    }

    return mapCacheRow(row);
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

    app.post("/api/cache/:key/refresh", (async (req, res) => {
        const key = String(req.params.key || "").trim();
        if (!key) {
            res.status(400).json({ error: "Missing cache key" });
            return;
        }

        try {
            const entry = await refreshCacheKey(key);
            res.json({ ok: true, entry });
        } catch (error) {
            res.status(500).json({
                error: error instanceof Error ? error.message : "Cache refresh failed",
            });
        }
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
