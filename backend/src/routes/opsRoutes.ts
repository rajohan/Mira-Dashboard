import {
    type LogRotationStatus,
    parseLogRotationSummary,
} from "../../../contracts/logRotation.ts";
import { database } from "../database.ts";
import { json } from "../http.ts";
import { httpStatusCode } from "../lib/errors.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { routeErrorResponse, routeFailureResponse } from "../routeSupport.ts";
import { runElevatedLogRotationService } from "../services/logRotation.ts";
import {
    enqueueAndWaitForJobExecution,
    successfulJobExecutionOutput,
} from "../services/queuedJobExecution.ts";

const LOG_ROTATION_STATE_KEY = "log_rotation.state";
const logger = createStructuredLogger("operations");

interface LogRotationResult {
    result: Record<string, unknown>;
    stderr: string;
}

type LogRotationRunner = (options: { isDryRun: boolean }) => Promise<LogRotationResult>;

const elevatedLogRotationRunner: LogRotationRunner = runElevatedLogRotationService;

function readLogRotationStatus(): LogRotationStatus {
    const row = database
        .prepare("SELECT data_json FROM cache_entries WHERE key = ? LIMIT 1")
        .get(LOG_ROTATION_STATE_KEY) as undefined | { data_json: string | null };
    const raw = row?.data_json ?? "";
    let data: undefined | { lastRun?: unknown };
    if (raw) {
        try {
            data = JSON.parse(raw) as { lastRun?: unknown };
        } catch (error) {
            logger.warn("operations.log_rotation_state_invalid", { error });
        }
    }
    if (data?.lastRun === undefined) return { isSuccess: true };
    try {
        return {
            isSuccess: true,
            lastRun: parseLogRotationSummary(data.lastRun, "logRotationState.lastRun"),
        };
    } catch (error) {
        logger.warn("operations.log_rotation_last_run_invalid", { error });
        return { isSuccess: true };
    }
}

export async function runLogRotation(options: {
    isDryRun: boolean;
}): Promise<LogRotationResult> {
    return elevatedLogRotationRunner(options);
}

async function runLogRotationResponse(request: Request, isDryRun: boolean) {
    try {
        const execution = await enqueueAndWaitForJobExecution({
            actionKey: "ops.log-rotation",
            displayName: isDryRun ? "Log rotation dry run" : "Log rotation manual run",
            payload: { isDryRun },
            resourceClass: "host-heavy",
            timeoutMs: 10 * 60 * 1000,
        });
        const output = execution.output;
        const logRotation = output.logRotation;
        if (!logRotation || typeof logRotation !== "object") {
            successfulJobExecutionOutput(execution);
            throw new Error("Log rotation result was missing");
        }
        const rawResult: unknown = Reflect.get(logRotation, "result");
        const rawStderr: unknown = Reflect.get(logRotation, "stderr");
        const result = parseLogRotationSummary(rawResult, "logRotation.result");
        const stderr = typeof rawStderr === "string" ? rawStderr : "";
        return json({
            isSuccess: result?.isOk === true,
            result,
            stderr,
        });
    } catch (error) {
        const status = httpStatusCode(error);
        if (status === 500) {
            logger.error("operations.log_rotation_failed", { error });
        }
        return routeErrorResponse(request, error, {
            code: "log_rotation_failed",
            context: "ops.log-rotation",
            message: "Ops route failed",
        });
    }
}

export const opsRoutes = {
    "/api/ops/log-rotation/dry-run": {
        POST: (request: Request) => runLogRotationResponse(request, true),
    },
    "/api/ops/log-rotation/run": {
        POST: (request: Request) => runLogRotationResponse(request, false),
    },
    "/api/ops/log-rotation/status": {
        GET: () => {
            try {
                return json(readLogRotationStatus());
            } catch (error) {
                logger.error("operations.status_read_failed", { error });
                return routeFailureResponse({
                    context: "ops",
                    message: "Ops route failed",
                    status: 500,
                });
            }
        },
    },
} as const;
