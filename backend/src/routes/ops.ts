import express, { type RequestHandler } from "express";

import { db } from "../db.js";
import { asyncRoute as baseAsyncRoute } from "../lib/errors.js";
import { runElevatedLogRotationService } from "../services/logRotation.js";

const LOG_ROTATION_STATE_KEY = "log_rotation.state";

interface LogRotationResult {
    result: Record<string, unknown>;
    stderr: string;
}

type LogRotationRunner = (options: { dryRun: boolean }) => Promise<LogRotationResult>;

function normalizeLastRunErrors(run: Record<string, unknown>): unknown[] {
    if (Array.isArray(run.errors)) {
        return run.errors;
    }
    const message =
        typeof run.message === "string" && run.message.trim()
            ? run.message.trim()
            : typeof run.stderr === "string" && run.stderr.trim()
              ? run.stderr.trim()
              : "";
    if (!message && run.result === undefined) {
        return [];
    }
    return [
        {
            message: message || "Log rotation failed",
            result: run.result ?? null,
            stderr: typeof run.stderr === "string" ? run.stderr : "",
        },
    ];
}

function normalizeLastRun(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const run = value as Record<string, unknown>;
    return {
        ok: run.ok === true,
        dryRun: run.dryRun === true,
        startedAt: typeof run.startedAt === "string" ? run.startedAt : null,
        finishedAt: typeof run.finishedAt === "string" ? run.finishedAt : null,
        checkedGroups: Number.isFinite(Number(run.checkedGroups))
            ? Number(run.checkedGroups)
            : 0,
        checkedFiles: Number.isFinite(Number(run.checkedFiles))
            ? Number(run.checkedFiles)
            : 0,
        rotatedFiles: Number.isFinite(Number(run.rotatedFiles))
            ? Number(run.rotatedFiles)
            : 0,
        compressedFiles: Number.isFinite(Number(run.compressedFiles))
            ? Number(run.compressedFiles)
            : 0,
        deletedArchives: Number.isFinite(Number(run.deletedArchives))
            ? Number(run.deletedArchives)
            : 0,
        skippedFiles: Number.isFinite(Number(run.skippedFiles))
            ? Number(run.skippedFiles)
            : 0,
        warnings: Array.isArray(run.warnings) ? run.warnings : [],
        errors: normalizeLastRunErrors(run),
        groups: Array.isArray(run.groups) ? run.groups : [],
    };
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
        .get(LOG_ROTATION_STATE_KEY) as undefined | { data_json?: string | null };
    const raw = row?.data_json ?? "";
    let data: null | { lastRun?: unknown } = null;
    if (raw) {
        try {
            data = JSON.parse(raw) as { lastRun?: unknown };
        } catch (error) {
            console.warn("[opsRoutes] Ignoring malformed log rotation state", error);
        }
    }
    return {
        success: true,
        lastRun: normalizeLastRun(data?.lastRun),
    };
}

/** Performs run log rotation. */
export async function runLogRotation(options: {
    dryRun: boolean;
}): Promise<LogRotationResult> {
    return elevatedLogRotationRunner(options);
}

let elevatedLogRotationRunner: LogRotationRunner = runElevatedLogRotationService;

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
                success: result?.ok === true,
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
                success: result?.ok === true,
                result,
                stderr,
            });
        })
    );
}
