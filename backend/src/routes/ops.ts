import { execFile } from "node:child_process";
import { promisify } from "node:util";

import express, { type RequestHandler } from "express";

import { asyncRoute as baseAsyncRoute } from "../lib/errors.js";
import { envFallback, nonEmptyEnvFallback, stringFallback } from "../lib/values.js";

const execFileAsync = promisify(execFile);
const N8N_ROOT = nonEmptyEnvFallback("MIRA_N8N_ROOT", "/home/ubuntu/projects/n8n");
const N8N_DATABASE = "n8n";
const dockerBin = nonEmptyEnvFallback("MIRA_DOCKER_BIN", "docker");
const LOG_ROTATION_SCRIPT = `${N8N_ROOT}/scripts/log-rotation.mjs`;
const LOG_ROTATION_CONFIG = `${N8N_ROOT}/config/log-rotation.json`;
const LOG_ROTATION_STATE_KEY = "log_rotation.state";

/** Performs async route. */
function asyncRoute(handler: RequestHandler): RequestHandler {
    return baseAsyncRoute(handler, {
        fallback: "Ops route failed",
        logLabel: "[opsRoutes]",
    });
}

/** Builds n8n script env. */
function buildN8nScriptEnv() {
    return {
        ...process.env,
        DB_POSTGRESDB_HOST: "127.0.0.1",
        DB_POSTGRESDB_PORT: "6432",
        DB_POSTGRESDB_DATABASE: N8N_DATABASE,
        DB_POSTGRESDB_USER: envFallback("DATABASE_USERNAME", "postgres"),
        DB_POSTGRESDB_PASSWORD: envFallback("DATABASE_PASSWORD", "postgres"),
    };
}

/** Builds PostgreSQL uri. */
function buildPostgresUri(database = N8N_DATABASE) {
    const username = envFallback("DATABASE_USERNAME", "postgres");
    const password = envFallback("DATABASE_PASSWORD", "postgres");
    const host = nonEmptyEnvFallback("DATABASE_HOST", "postgres");
    const port = nonEmptyEnvFallback("DATABASE_PORT", "5432");
    return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

/** Performs read log rotation status. */
async function readLogRotationStatus() {
    const sql = `SELECT COALESCE(data->'lastRun', 'null'::jsonb)::text FROM cache_entries WHERE key = '${LOG_ROTATION_STATE_KEY}'`;
    const { stdout } = await execFileAsync(
        dockerBin,
        ["exec", "postgres", "psql", buildPostgresUri(), "-t", "-A", "-c", sql],
        {
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
        }
    );
    const raw = stringFallback(stdout).trim();
    return {
        success: true,
        lastRun: raw ? JSON.parse(raw) : null,
    };
}

/** Performs run log rotation. */
async function runLogRotation(options: { dryRun: boolean }) {
    const args = [LOG_ROTATION_SCRIPT, "--config", LOG_ROTATION_CONFIG, "--json"];

    if (options.dryRun) {
        args.push("--dry-run");
    }

    const { stdout, stderr } = await execFileAsync(
        options.dryRun ? "node" : "sudo",
        options.dryRun
            ? args
            : [
                  "-n",
                  "--preserve-env=DB_POSTGRESDB_HOST,DB_POSTGRESDB_PORT,DB_POSTGRESDB_DATABASE,DB_POSTGRESDB_USER,DB_POSTGRESDB_PASSWORD",
                  "node",
                  ...args,
              ],
        {
            cwd: N8N_ROOT,
            env: buildN8nScriptEnv(),
            maxBuffer: 20 * 1024 * 1024,
        }
    );

    return {
        result: JSON.parse(stdout.trim() || "{}"),
        stderr: stringFallback(stderr),
    };
}

/** Registers ops API routes. */
export default function opsRoutes(app: express.Application): void {
    app.get(
        "/api/ops/log-rotation/status",
        asyncRoute(async (_req, res) => {
            res.json(await readLogRotationStatus());
        })
    );

    app.post(
        "/api/ops/log-rotation/dry-run",
        express.json(),
        asyncRoute(async (_req, res) => {
            const { result, stderr } = await runLogRotation({ dryRun: true });
            res.json({
                success: Boolean(result?.ok),
                result,
                stderr,
            });
        })
    );

    app.post(
        "/api/ops/log-rotation/run",
        express.json(),
        asyncRoute(async (_req, res) => {
            const { result, stderr } = await runLogRotation({ dryRun: false });
            res.json({
                success: Boolean(result?.ok),
                result,
                stderr,
            });
        })
    );
}

export const __testing = {
    buildN8nScriptEnv,
    buildPostgresUri,
};
