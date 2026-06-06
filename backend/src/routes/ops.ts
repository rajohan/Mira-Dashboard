import express, { type RequestHandler } from "express";

import { db } from "../db.js";
import { asyncRoute as baseAsyncRoute } from "../lib/errors.js";
import { runLogRotationService } from "../services/logRotation.js";
const LOG_ROTATION_STATE_KEY = "log_rotation.state";

interface LogRotationResult {
    result: Record<string, unknown>;
    stderr: string;
}

/** Performs async route. */
function asyncRoute(handler: RequestHandler): RequestHandler {
    return baseAsyncRoute(handler, {
        fallback: "Ops route failed",
        logLabel: "[opsRoutes]",
    });
}

/** Performs read log rotation status. */
async function readLogRotationStatus() {
    const row = db
        .prepare("SELECT data_json FROM cache_entries WHERE key = ? LIMIT 1")
        .get(LOG_ROTATION_STATE_KEY) as { data_json?: string | null } | undefined;
    const raw = row?.data_json ?? "";
    let data: { lastRun?: unknown } | null = null;
    if (raw) {
        try {
            data = JSON.parse(raw) as { lastRun?: unknown };
        } catch (error) {
            console.warn("[opsRoutes] Ignoring malformed log rotation state", error);
        }
    }
    return {
        success: true,
        lastRun: data?.lastRun ?? null,
    };
}

/** Performs run log rotation. */
export async function runLogRotation(options: {
    dryRun: boolean;
}): Promise<LogRotationResult> {
    const result = await runLogRotationService({ dryRun: options.dryRun });
    return {
        result: result as unknown as Record<string, unknown>,
        stderr: "",
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
