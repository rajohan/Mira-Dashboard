import { database } from "../database.ts";
import { json } from "../http.ts";
import { runElevatedLogRotationService } from "../services/logRotation.ts";

const LOG_ROTATION_STATE_KEY = "log_rotation.state";

interface LogRotationResult {
    result: Record<string, unknown>;
    stderr: string;
}

type LogRotationRunner = (options: { isDryRun: boolean }) => Promise<LogRotationResult>;

const elevatedLogRotationRunner: LogRotationRunner = runElevatedLogRotationService;

function normalizeLastRunErrors(run: Record<string, unknown>): unknown[] {
    if (Array.isArray(run.errors)) return run.errors;
    const result = run.result ?? undefined;
    const message =
        typeof run.message === "string" && run.message.trim()
            ? run.message.trim()
            : typeof run.stderr === "string" && run.stderr.trim()
              ? run.stderr.trim()
              : "";
    if (!message && result === undefined) return [];
    return [
        {
            message: message || "Log rotation failed",
            result,
            stderr: typeof run.stderr === "string" ? run.stderr : "",
        },
    ];
}

function normalizeLastRun(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return;
    }
    const run = value as Record<string, unknown>;
    return {
        checkedFiles: Number.isFinite(Number(run.checkedFiles))
            ? Number(run.checkedFiles)
            : 0,
        checkedGroups: Number.isFinite(Number(run.checkedGroups))
            ? Number(run.checkedGroups)
            : 0,
        compressedFiles: Number.isFinite(Number(run.compressedFiles))
            ? Number(run.compressedFiles)
            : 0,
        deletedArchives: Number.isFinite(Number(run.deletedArchives))
            ? Number(run.deletedArchives)
            : 0,
        errors: normalizeLastRunErrors(run),
        finishedAt: typeof run.finishedAt === "string" ? run.finishedAt : undefined,
        groups: Array.isArray(run.groups) ? run.groups : [],
        isDryRun: run.isDryRun === true,
        isOk: run.isOk === true,
        rotatedFiles: Number.isFinite(Number(run.rotatedFiles))
            ? Number(run.rotatedFiles)
            : 0,
        skippedFiles: Number.isFinite(Number(run.skippedFiles))
            ? Number(run.skippedFiles)
            : 0,
        startedAt: typeof run.startedAt === "string" ? run.startedAt : undefined,
        warnings: Array.isArray(run.warnings) ? run.warnings : [],
    };
}

async function readLogRotationStatus() {
    const row = database
        .prepare("SELECT data_json FROM cache_entries WHERE key = ? LIMIT 1")
        .get(LOG_ROTATION_STATE_KEY) as undefined | { data_json?: string | undefined };
    const raw = row?.data_json ?? "";
    let data: undefined | { lastRun?: unknown };
    if (raw) {
        try {
            data = JSON.parse(raw) as { lastRun?: unknown };
        } catch (error) {
            console.warn("[opsRoutes] Ignoring malformed log rotation state", error);
        }
    }
    return {
        isSuccess: true,
        lastRun: normalizeLastRun(data?.lastRun),
    };
}

export async function runLogRotation(options: {
    isDryRun: boolean;
}): Promise<LogRotationResult> {
    return elevatedLogRotationRunner(options);
}

async function runLogRotationResponse(isDryRun: boolean) {
    try {
        const { result, stderr } = await runLogRotation({ isDryRun });
        return json({
            isSuccess: result?.isOk === true,
            result,
            stderr,
        });
    } catch (error) {
        console.error("[opsRoutes] Ops route failed", error);
        return json({ error: "Ops route failed" }, { status: 500 });
    }
}

export const opsRoutes = {
    "/api/ops/log-rotation/dry-run": {
        POST: () => runLogRotationResponse(true),
    },
    "/api/ops/log-rotation/run": {
        POST: () => runLogRotationResponse(false),
    },
    "/api/ops/log-rotation/status": {
        GET: async () => {
            try {
                return json(await readLogRotationStatus());
            } catch (error) {
                console.error("[opsRoutes] Ops route failed", error);
                return json({ error: "Ops route failed" }, { status: 500 });
            }
        },
    },
} as const;
