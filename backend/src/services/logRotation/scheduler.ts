import { database } from "../../database.ts";
import { writeCacheSuccess } from "../cacheEntryWriter.ts";
import {
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    ScheduledJobActionError,
    upsertScheduledJob,
} from "../scheduledJobs.ts";
import {
    type ElevatedLogRotationResult,
    runElevatedLogRotationService,
} from "./runtime.ts";

const STATE_CACHE_KEY = "log_rotation.state";
const LOG_ROTATION_JOB_ID = "ops.log-rotation";
const LOG_ROTATION_FAILURE_OUTPUT_MAX_CHARS = 100_000;
const writeLogRotationCacheSuccess = writeCacheSuccess;

function dateToISOString(date: Date): string {
    return date.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function logRotationFailureMessage(logRotation: ElevatedLogRotationResult): string {
    if (logRotation.stderr.trim()) {
        return logRotation.stderr.trim();
    }
    const result = asRecord(logRotation.result);
    if (typeof result.error === "string" && result.error.trim()) {
        return result.error.trim();
    }
    if (result.isOk === false) {
        const details = {
            errors: Array.isArray(result.errors) ? result.errors : [],
            groups: Array.isArray(result.groups) ? result.groups : [],
            warnings: Array.isArray(result.warnings) ? result.warnings : [],
        };
        if (
            details.errors.length > 0 ||
            details.warnings.length > 0 ||
            details.groups.length > 0
        ) {
            return `Log rotation failed: ${JSON.stringify(details)}`;
        }
    }
    return "Log rotation failed";
}

function capLogRotationFailureOutput(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    if (value.length <= LOG_ROTATION_FAILURE_OUTPUT_MAX_CHARS) {
        return value;
    }
    return value.slice(-LOG_ROTATION_FAILURE_OUTPUT_MAX_CHARS);
}

function capScheduledLogRotationFailure(
    logRotation: ElevatedLogRotationResult
): ElevatedLogRotationResult {
    const result = asRecord(logRotation.result);
    return {
        result: {
            ...result,
            stdout: capLogRotationFailureOutput(result.stdout),
        },
        stderr: capLogRotationFailureOutput(logRotation.stderr) ?? "",
    };
}

function readLogRotationStateCacheForFailure(): Record<string, unknown> {
    const fallback = { version: 1, files: {} };
    const row = database
        .prepare("SELECT data_json FROM cache_entries WHERE key = ? LIMIT 1")
        .get(STATE_CACHE_KEY) as undefined | { data_json?: string | undefined };
    if (!row?.data_json) {
        return fallback;
    }
    try {
        return { ...fallback, ...asRecord(JSON.parse(row.data_json) as unknown) };
    } catch {
        return fallback;
    }
}

function persistLogRotationScheduledFailure(
    logRotation: ElevatedLogRotationResult,
    message: string
): void {
    const existingState = readLogRotationStateCacheForFailure();
    const structuredLastRun = asRecord(logRotation.result);
    writeLogRotationCacheSuccess({
        key: STATE_CACHE_KEY,
        data: {
            ...existingState,
            version: 1,
            lastRun: {
                ...structuredLastRun,
                isOk: false,
                isDryRun: false,
                stdout: capLogRotationFailureOutput(structuredLastRun.stdout),
                finishedAt:
                    typeof structuredLastRun.finishedAt === "string"
                        ? structuredLastRun.finishedAt
                        : dateToISOString(new Date()),
                message,
                stderr: capLogRotationFailureOutput(logRotation.stderr),
            },
        },
        source: "backend",
        ttl: 90 * 24,
        ttlUnit: "hours",
        metadata: { workflow: "Log Rotation - Foundation" },
    });
}

/** Registers the scheduled real log rotation job. */
export function registerLogRotationScheduledJobs(): void {
    registerScheduledJobAction(LOG_ROTATION_JOB_ID, async (job, signal, context) => {
        const isDryRun = job.actionPayload.isDryRun === true;
        if (!isDryRun) context.protectFromCancellation();
        const logRotation = await runElevatedLogRotationService({
            isDryRun,
            signal,
        });
        if (logRotation.result?.isOk !== true) {
            const message = logRotationFailureMessage(logRotation);
            if (!isDryRun) persistLogRotationScheduledFailure(logRotation, message);
            throw new ScheduledJobActionError(message, {
                logRotation: capScheduledLogRotationFailure(logRotation),
            });
        }
        return { logRotation };
    });
    database.run("BEGIN IMMEDIATE");
    try {
        removeScheduledJobsNotInAction(LOG_ROTATION_JOB_ID, [LOG_ROTATION_JOB_ID]);
        const existing = getScheduledJob(LOG_ROTATION_JOB_ID);
        upsertScheduledJob({
            id: LOG_ROTATION_JOB_ID,
            name: "Log rotation",
            description:
                "Rotate approved Docker file logs and update log rotation cache.",
            enabled: existing?.enabled ?? true,
            scheduleType: existing?.scheduleType ?? "daily",
            intervalSeconds: existing?.intervalSeconds ?? 24 * 60 * 60,
            timeOfDay: existing ? existing.timeOfDay : "02:10",
            cronExpression: existing?.cronExpression ?? undefined,
            actionKey: LOG_ROTATION_JOB_ID,
            actionPayload: { key: STATE_CACHE_KEY },
            resourceClass: "host-heavy",
        });
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the registration error.
        }
        throw error;
    }
}
