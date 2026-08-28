import { Effect } from "effect";
import * as v from "valibot";

import {
    type BackupCachePayload,
    type BackupType,
    backupStatusCacheGroupKey,
    backupStatusCacheKeys,
    backupStatusCacheSchemaIds,
    backupStatusCacheSource,
    backupStatusCacheTtlMs,
    backupTypes,
} from "../../../contracts/backups.ts";
import {
    type BackupJobExecutionPort,
    backupClearAttentionJobResultSchema,
    backupRunJobResultSchema,
    parseBackupOperationJobPayload,
} from "../../../contracts/backupsWorker.ts";
import type { BackupActivityRepository } from "../backups/activityRepository.ts";
import {
    type JobActionExecutionContext,
    type JobActionExecutor,
    JobActionOutcomeUnknownError,
    JobActionRetryableError,
} from "./actionRegistry.ts";
import { reportJobProgress } from "./progressReporting.ts";

const statusPayloadSchema = v.strictObject({
    key: v.literal(backupStatusCacheGroupKey),
});

export interface BackupActionExecutorDependencies {
    readonly activityRepository: BackupActivityRepository;
    readonly executionPort: BackupJobExecutionPort;
}

function elapsed(startedAt: number): number {
    return Math.max(0, Math.floor(performance.now() - startedAt));
}

async function persistSuccess(
    context: JobActionExecutionContext,
    payload: BackupCachePayload,
    durationMs: number
): Promise<void> {
    await context.commitCacheAttempt({
        durationMs,
        entries: [
            {
                key: backupStatusCacheKeys[payload.type],
                metadata: { kind: "backup-status", type: payload.type },
                payload,
                schemaId: backupStatusCacheSchemaIds[payload.type],
                source: backupStatusCacheSource,
                ttlMs: backupStatusCacheTtlMs,
            },
        ],
        kind: "succeeded",
    });
}

async function persistFailure(
    context: JobActionExecutionContext,
    type: BackupType,
    durationMs: number
): Promise<void> {
    await context.commitCacheAttempt({
        durationMs,
        failureCode: `provider/backup-${type}-unavailable`,
        failureMessage: `${type === "kopia" ? "Kopia" : "WAL-G"} backup status could not be collected.`,
        key: backupStatusCacheKeys[type],
        kind: "failed",
    });
}

/**
 * Refreshes and commits provider status independently so one failure preserves the other.
 *
 * @param executionPort - Worker-only backup provider operations.
 * @returns The fixed backup status action executor.
 */
export function createBackupStatusJobExecutor(
    executionPort: BackupJobExecutionPort
): JobActionExecutor {
    return (context, rawPayload) =>
        Effect.tryPromise({
            catch: (error) =>
                error instanceof JobActionRetryableError
                    ? error
                    : new JobActionRetryableError(error),
            try: async (signal) => {
                v.parse(statusPayloadSchema, rawPayload);
                await reportJobProgress(context, {
                    message: "Refreshing backup provider status",
                    phase: "collecting",
                });
                const startedAt = performance.now();
                const refreshed = await executionPort.refresh(signal);
                const cacheKeys: string[] = [];
                for (const type of backupTypes) {
                    const result = refreshed[type];
                    if (result.kind === "succeeded") {
                        await persistSuccess(context, result.payload, elapsed(startedAt));
                        cacheKeys.push(backupStatusCacheKeys[type]);
                    } else {
                        await persistFailure(context, type, elapsed(startedAt));
                    }
                }
                if (cacheKeys.length === 0) {
                    throw new JobActionRetryableError();
                }
                return {
                    cacheKeys,
                    completedAtMs: context.nowMs(),
                };
            },
        });
}

/**
 * Executes only a run payload for one fixed provider action.
 *
 * @param type - The fixed provider type for this executor.
 * @param dependencies - Provider and attention-ledger dependencies.
 * @returns The fixed provider run action executor.
 */
export function createBackupRunJobExecutor(
    type: BackupType,
    dependencies: BackupActionExecutorDependencies
): JobActionExecutor {
    return (context, rawPayload) =>
        Effect.tryPromise({
            catch: (error) => error,
            try: async (signal) => {
                const payload = parseBackupOperationJobPayload(rawPayload);
                if (payload.operation !== "run" || payload.type !== type) {
                    throw new TypeError("Backup run job payload is invalid");
                }
                if (
                    dependencies.activityRepository.read(type).state === "needs-attention"
                ) {
                    throw new Error("Backup attention must be cleared before running");
                }
                await reportJobProgress(context, {
                    message: `Running ${type === "kopia" ? "Kopia" : "WAL-G"} backup`,
                    phase: "backing-up",
                });
                const outcome = await dependencies.executionPort.run(
                    {
                        ...(payload.trigger === "manual"
                            ? { expectedSourceRevision: payload.sourceRevision }
                            : {}),
                        type,
                    },
                    signal
                );
                if (outcome.outcome === "unknown-outcome") {
                    throw new JobActionOutcomeUnknownError();
                }
                return v.parse(backupRunJobResultSchema, {
                    completedAtMs: context.nowMs(),
                    sourceRevision: outcome.sourceRevision,
                    status: "completed",
                    type,
                });
            },
        });
}

/**
 * Clears only the exact unresolved attention run after worker-side source/idle proof.
 *
 * @param dependencies - Provider and attention-ledger dependencies.
 * @returns The fixed attention-clear action executor.
 */
export function createBackupClearAttentionJobExecutor(
    dependencies: BackupActionExecutorDependencies
): JobActionExecutor {
    return (context, rawPayload) =>
        Effect.tryPromise({
            catch: (error) => error,
            try: async (signal) => {
                const payload = parseBackupOperationJobPayload(rawPayload);
                if (payload.operation !== "clear-attention") {
                    throw new TypeError("Backup clearance job payload is invalid");
                }
                if (
                    !dependencies.activityRepository.isAttentionRun(
                        payload.type,
                        payload.attentionRunId
                    )
                ) {
                    throw new Error("Backup attention run changed");
                }
                await reportJobProgress(context, {
                    message: "Verifying and clearing backup attention",
                    phase: "verifying",
                });
                const outcome = await dependencies.executionPort.clearAttention(
                    payload,
                    signal
                );
                if (outcome.outcome === "unknown-outcome") {
                    throw new JobActionOutcomeUnknownError();
                }
                return v.parse(backupClearAttentionJobResultSchema, {
                    attentionRunId: payload.attentionRunId,
                    completedAtMs: context.nowMs(),
                    sourceRevision: outcome.sourceRevision,
                    status: "cleared",
                    type: payload.type,
                });
            },
        });
}
