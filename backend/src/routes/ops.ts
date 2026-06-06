import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import express, { type RequestHandler } from "express";

import { db } from "../db.js";
import { asyncRoute as baseAsyncRoute } from "../lib/errors.js";
import { runLogRotationService } from "../services/logRotation.js";
const LOG_ROTATION_STATE_KEY = "log_rotation.state";
const execFileAsync = promisify(execFile);

interface LogRotationResult {
    result: Record<string, unknown>;
    stderr: string;
}

type LogRotationRunner = (options: { dryRun: boolean }) => Promise<LogRotationResult>;
type ExecFileRunner = typeof execFileAsync;

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
        errors: Array.isArray(run.errors) ? run.errors : [],
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
        lastRun: normalizeLastRun(data?.lastRun),
    };
}

/** Performs run log rotation. */
export async function runLogRotation(options: {
    dryRun: boolean;
}): Promise<LogRotationResult> {
    if (!options.dryRun) {
        return elevatedLogRotationRunner(options);
    }
    const result = await runLogRotationService({ dryRun: options.dryRun });
    return {
        result: result as unknown as Record<string, unknown>,
        stderr: "",
    };
}

let elevatedLogRotationRunner: LogRotationRunner = runElevatedLogRotation;
let execFileRunner: ExecFileRunner = execFileAsync;

async function runElevatedLogRotation(): Promise<LogRotationResult> {
    const modulePath = fileURLToPath(
        new URL("../services/logRotation.js", import.meta.url)
    );
    const { stdout, stderr } = await execFileRunner(
        "sudo",
        ["-n", process.execPath, modulePath, "--json"],
        {
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
        }
    );
    return {
        result: JSON.parse(stdout || "{}") as Record<string, unknown>,
        stderr,
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
    resetLogRotationRunner() {
        elevatedLogRotationRunner = runElevatedLogRotation;
        execFileRunner = execFileAsync;
    },
    setElevatedLogRotationRunner(runner: LogRotationRunner) {
        elevatedLogRotationRunner = runner;
    },
    setLogRotationExecFileRunner(runner: ExecFileRunner) {
        execFileRunner = runner;
    },
};
