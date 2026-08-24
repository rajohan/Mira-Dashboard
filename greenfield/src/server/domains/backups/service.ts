import * as v from "valibot";

import {
    type BackupActivity,
    type BackupRequestOperationInput,
    type BackupRequestOperationResult,
    type BackupType,
    type KopiaBackupStatus,
    type WalgBackupStatus,
    backupRequestOperationInputSchema,
    backupRequestOperationResultSchema,
    backupStatusCacheKeys,
    backupStatusCacheSchemaIds,
    backupStatusCacheSource,
    kopiaBackupCachePayloadSchema,
    kopiaBackupStatusSchema,
    walgBackupCachePayloadSchema,
    walgBackupStatusSchema,
} from "../../../contracts/backups.ts";
import type { BackupOperationJobPayload } from "../../../contracts/backupsWorker.ts";
import type { BackupActivityRepository } from "./activityRepository.ts";
import type {
    BackupOperationAuditContext,
    BackupOperationAuditWriter,
} from "./operationAudit.ts";
import {
    type BackupOperationQueue,
    BackupOperationQueueError,
} from "./operationQueue.ts";
import type {
    BackupSnapshotRecord,
    BackupSnapshotRepository,
} from "./snapshotRepository.ts";

export const backupLastKnownGoodMs = 7 * 24 * 60 * 60_000;

export type BackupServiceErrorReason =
    | "audit-unavailable"
    | "conflict"
    | "not-found"
    | "unavailable"
    | "unknown-outcome";

export class BackupServiceError extends Error {
    readonly reason: BackupServiceErrorReason;
    constructor(reason: BackupServiceErrorReason, options?: ErrorOptions) {
        super("Backup operation failed", options);
        this.name = "BackupServiceError";
        this.reason = reason;
    }
}

export interface BackupControlContext extends BackupOperationAuditContext {
    readonly reauthorize: () => void;
}

export interface BackupService {
    readonly getKopiaStatus: () => KopiaBackupStatus;
    readonly getWalgStatus: () => WalgBackupStatus;
    readonly requestOperation: (
        input: BackupRequestOperationInput,
        context: BackupControlContext,
        signal?: AbortSignal
    ) => Promise<BackupRequestOperationResult>;
}

function checkedNow(nowMs: () => number): number {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new BackupServiceError("unavailable");
    }
    return value;
}

function unavailable(
    type: BackupType,
    activity: BackupActivity,
    checkedAtMs: number
): KopiaBackupStatus | WalgBackupStatus {
    const input = { activity, checkedAtMs, state: "unavailable" as const, type };
    return type === "kopia"
        ? v.parse(kopiaBackupStatusSchema, input)
        : v.parse(walgBackupStatusSchema, input);
}

function project(
    type: BackupType,
    record: BackupSnapshotRecord | undefined,
    activity: BackupActivity,
    checkedAtMs: number,
    lastKnownGoodMs: number
): KopiaBackupStatus | WalgBackupStatus {
    if (
        record === undefined ||
        record.key !== backupStatusCacheKeys[type] ||
        record.schemaId !== backupStatusCacheSchemaIds[type] ||
        record.source !== backupStatusCacheSource ||
        record.expiresAtMs === null ||
        record.lastSuccessAtMs === null ||
        record.lastAttemptAtMs > checkedAtMs ||
        record.lastSuccessAtMs > record.lastAttemptAtMs ||
        record.expiresAtMs <= record.lastSuccessAtMs ||
        checkedAtMs - record.lastSuccessAtMs > lastKnownGoodMs
    ) {
        return unavailable(type, activity, checkedAtMs);
    }
    const payloadSchema =
        type === "kopia" ? kopiaBackupCachePayloadSchema : walgBackupCachePayloadSchema;
    const parsed = v.safeParse(payloadSchema, record.payload);
    if (
        !parsed.success ||
        parsed.output.type !== type ||
        parsed.output.observedAtMs > record.lastSuccessAtMs ||
        parsed.output.observedAtMs > checkedAtMs
    ) {
        return unavailable(type, activity, checkedAtMs);
    }
    const fresh =
        record.lastAttemptStatus === "succeeded" &&
        record.lastAttemptAtMs === record.lastSuccessAtMs &&
        record.expiresAtMs > checkedAtMs;
    const candidate = fresh
        ? { activity, checkedAtMs, payload: parsed.output, state: "fresh" as const }
        : {
              activity,
              checkedAtMs,
              payload: parsed.output,
              staleSinceMs:
                  record.lastAttemptStatus === "failed"
                      ? record.lastAttemptAtMs
                      : record.expiresAtMs,
              state: "last-known-good" as const,
          };
    return type === "kopia"
        ? v.parse(kopiaBackupStatusSchema, candidate)
        : v.parse(walgBackupStatusSchema, candidate);
}

function payloadFor(input: BackupRequestOperationInput): BackupOperationJobPayload {
    return input.operation === "run"
        ? {
              operation: "run",
              sourceRevision: input.sourceRevision,
              trigger: "manual",
              type: input.type,
          }
        : {
              attentionRunId: input.attentionRunId,
              operation: "clear-attention",
              sourceRevision: input.sourceRevision,
              type: input.type,
          };
}

/**
 * Creates LKG reads and audited recent-MFA durable operation admission.
 *
 * @param options - The bounded backup domain dependencies.
 * @returns The immutable backup service.
 */
export function createBackupService(options: {
    readonly activityRepository: BackupActivityRepository;
    readonly auditWriter: BackupOperationAuditWriter;
    readonly lastKnownGoodMs?: number;
    readonly nowMs?: () => number;
    readonly operationQueue: BackupOperationQueue;
    readonly snapshotRepository: BackupSnapshotRepository;
}): BackupService {
    const nowMs = options.nowMs ?? Date.now;
    const lastKnownGoodMs = options.lastKnownGoodMs ?? backupLastKnownGoodMs;
    if (!Number.isSafeInteger(lastKnownGoodMs) || lastKnownGoodMs < 0) {
        throw new RangeError("Backup snapshot stale window is invalid");
    }

    function status(type: BackupType): KopiaBackupStatus | WalgBackupStatus {
        let checkedAtMs = 0;
        let activity: BackupActivity = { state: "idle" };
        try {
            checkedAtMs = checkedNow(nowMs);
            activity = options.activityRepository.read(type);
            return project(
                type,
                options.snapshotRepository.read(type),
                activity,
                checkedAtMs,
                lastKnownGoodMs
            );
        } catch {
            return unavailable(type, activity, checkedAtMs);
        }
    }

    async function auditSettlement(
        input: BackupRequestOperationInput,
        context: BackupOperationAuditContext,
        settlement:
            | { readonly kind: "failed" }
            | { readonly jobRunId: string; readonly kind: "queued" }
    ): Promise<void> {
        try {
            await options.auditWriter.record({
                ...context,
                ...(settlement.kind === "queued"
                    ? { jobRunId: settlement.jobRunId }
                    : {}),
                operation: input.operation,
                settlement: settlement.kind,
                type: input.type,
            });
        } catch {
            // Durable queue settlement remains authoritative after admission.
        }
    }

    const service: BackupService = {
        getKopiaStatus() {
            return status("kopia") as KopiaBackupStatus;
        },
        getWalgStatus() {
            return status("walg") as WalgBackupStatus;
        },
        async requestOperation(input, context, signal) {
            const parsed = v.parse(backupRequestOperationInputSchema, input);
            signal?.throwIfAborted();
            try {
                await options.auditWriter.record({
                    actor: context.actor,
                    operation: parsed.operation,
                    requestId: context.requestId,
                    settlement: "attempted",
                    type: parsed.type,
                });
            } catch (error) {
                throw new BackupServiceError("audit-unavailable", { cause: error });
            }
            try {
                const result = await options.operationQueue.enqueue({
                    actor: context.actor,
                    authorizeDispatch: () => {
                        const current = status(parsed.type);
                        if (
                            current.state !== "fresh" ||
                            current.payload.sourceRevision !== parsed.sourceRevision
                        ) {
                            throw new BackupServiceError("conflict");
                        }
                        if (!current.payload.providerIdle) {
                            throw new BackupServiceError("conflict");
                        }
                        if (
                            parsed.operation === "run" &&
                            current.activity.state === "needs-attention"
                        ) {
                            throw new BackupServiceError("conflict");
                        }
                        if (
                            parsed.operation === "clear-attention" &&
                            !options.activityRepository.isAttentionRun(
                                parsed.type,
                                parsed.attentionRunId
                            )
                        ) {
                            throw new BackupServiceError("not-found");
                        }
                        const payload = payloadFor(parsed);
                        const serialized = JSON.stringify(payload);
                        return Promise.resolve({
                            authorize: () => {
                                context.reauthorize();
                                const refreshed = status(parsed.type);
                                if (
                                    refreshed.state !== "fresh" ||
                                    !refreshed.payload.providerIdle ||
                                    refreshed.payload.sourceRevision !==
                                        parsed.sourceRevision ||
                                    JSON.stringify(payloadFor(parsed)) !== serialized ||
                                    (parsed.operation === "clear-attention" &&
                                        !options.activityRepository.isAttentionRun(
                                            parsed.type,
                                            parsed.attentionRunId
                                        ))
                                ) {
                                    throw new BackupServiceError("conflict");
                                }
                            },
                            payload,
                        });
                    },
                    input: parsed,
                    requestId: context.requestId,
                    signal,
                });
                const output = v.parse(backupRequestOperationResultSchema, result);
                await auditSettlement(parsed, context, {
                    jobRunId: output.jobRunId,
                    kind: "queued",
                });
                return output;
            } catch (error) {
                await auditSettlement(parsed, context, { kind: "failed" });
                if (error instanceof BackupServiceError) throw error;
                if (error instanceof BackupOperationQueueError) {
                    throw new BackupServiceError(error.reason, { cause: error });
                }
                throw error;
            }
        },
    };
    return Object.freeze(service);
}
