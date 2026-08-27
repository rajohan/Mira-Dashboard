import * as v from "valibot";

import {
    type BackupRequestOperationInput,
    type BackupRequestOperationResult,
    backupRequestOperationInputSchema,
} from "../../../contracts/backups.ts";
import {
    type BackupOperationJobPayload,
    parseBackupOperationJobPayload,
} from "../../../contracts/backupsWorker.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { fullCommitShaSchema } from "../../../shared/validation.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import {
    backupClearAttentionJobActionDefinition,
    backupKopiaRunJobActionDefinition,
    backupWalgRunJobActionDefinition,
    type JobExecutableActionDefinition,
} from "../jobs/actionRegistry.ts";
import {
    preflightManualEnqueue,
    resolveManualScheduleAssociation,
} from "../jobs/manualEnqueue.ts";
import type { JobRunRecord } from "../jobs/records.ts";
import type { JobRepository } from "../jobs/repository.ts";
import {
    createJobMutationSideEffects,
    createJobRealtimeSideEffects,
} from "../jobs/sideEffects.ts";
import type { BackupOperationActor } from "./operationAudit.ts";

export type BackupOperationQueueErrorReason =
    | "conflict"
    | "unavailable"
    | "unknown-outcome";

export class BackupOperationQueueError extends Error {
    readonly reason: BackupOperationQueueErrorReason;
    constructor(reason: BackupOperationQueueErrorReason) {
        super("Backup operation queue failed");
        this.name = "BackupOperationQueueError";
        this.reason = reason;
    }
}

export interface BackupOperationQueueRequest {
    readonly actor: BackupOperationActor;
    readonly authorizeDispatch: () => Promise<{
        readonly authorize: () => void;
        readonly payload: BackupOperationJobPayload;
    }>;
    readonly input: BackupRequestOperationInput;
    readonly requestId: string;
    readonly signal?: AbortSignal;
}

export interface BackupOperationQueue {
    readonly enqueue: (
        request: BackupOperationQueueRequest
    ) => Promise<BackupRequestOperationResult>;
}

type QueueDefinition = JobExecutableActionDefinition;

function definitionFor(input: BackupRequestOperationInput): QueueDefinition {
    if (input.operation === "clear-attention") {
        return backupClearAttentionJobActionDefinition;
    }
    return input.type === "kopia"
        ? backupKopiaRunJobActionDefinition
        : backupWalgRunJobActionDefinition;
}

function payloadMatches(
    payload: BackupOperationJobPayload,
    input: BackupRequestOperationInput
): boolean {
    return input.operation === "run"
        ? payload.operation === "run" &&
              payload.trigger === "manual" &&
              payload.type === input.type &&
              payload.sourceRevision === input.sourceRevision
        : payload.operation === "clear-attention" &&
              payload.type === input.type &&
              payload.sourceRevision === input.sourceRevision &&
              payload.attentionRunId === input.attentionRunId;
}

function matchingRun(
    run: JobRunRecord | undefined,
    request: BackupOperationQueueRequest,
    definition: QueueDefinition,
    enqueueSha256: string
): JobRunRecord | undefined {
    if (
        run === undefined ||
        run.actionKey !== definition.actionKey ||
        run.enqueueSha256 !== enqueueSha256 ||
        run.idempotencyKey !== request.input.idempotencyKey ||
        run.requestedById !== request.actor.id ||
        run.requestedByKind !== request.actor.kind
    ) {
        return undefined;
    }
    try {
        return payloadMatches(
            parseBackupOperationJobPayload(parseJsonText(run.payloadJson)),
            request.input
        )
            ? run
            : undefined;
    } catch {
        return undefined;
    }
}

function result(
    input: BackupRequestOperationInput,
    run: JobRunRecord
): BackupRequestOperationResult {
    const output: BackupRequestOperationResult = {
        jobRunId: run.id,
        operation: input.operation,
        queued: true,
        type: input.type,
    };
    return Object.freeze(output);
}

/**
 * Creates actor-bound durable admission for the four fixed backup mutations.
 *
 * @param dependencies - Durable queue and release-fence dependencies.
 * @returns The immutable backup operation queue.
 */
export function createBackupOperationQueue(dependencies: {
    readonly generateId?: () => string;
    readonly nowMs?: () => number;
    readonly requiredWorkerReleaseId?: string;
    readonly repository: Pick<
        JobRepository,
        "enqueueManualRun" | "findRunByIdempotency" | "findSchedule"
    >;
    readonly wakeEventPump?: () => Promise<void> | void;
}): BackupOperationQueue {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = dependencies.nowMs ?? Date.now;
    const requiredWorkerReleaseId =
        dependencies.requiredWorkerReleaseId === undefined
            ? undefined
            : v.parse(
                  fullCommitShaSchema("Required backup worker release is invalid"),
                  dependencies.requiredWorkerReleaseId
              );

    async function wake(run: JobRunRecord): Promise<void> {
        if (run.state !== "queued") return;
        try {
            await dependencies.wakeEventPump?.();
        } catch {
            // Worker polling owns the durable fallback.
        }
    }

    const queue: BackupOperationQueue = {
        async enqueue(request) {
            request.signal?.throwIfAborted();
            const input = v.parse(backupRequestOperationInputSchema, request.input);
            const definition = definitionFor(input);
            const enqueueSha256 = sha256Hex(
                JSON.stringify({
                    actionKey: definition.actionKey,
                    authenticatorId: request.actor.authenticatorId,
                    input,
                    version: 1,
                })
            );
            let replay: ReturnType<typeof preflightManualEnqueue>;
            try {
                replay = preflightManualEnqueue(dependencies.repository, {
                    enqueueSha256,
                    idempotencyKey: input.idempotencyKey,
                    requestedById: request.actor.id,
                    requestedByKind: request.actor.kind,
                });
            } catch {
                throw new BackupOperationQueueError("unavailable");
            }
            if (replay.kind === "idempotency-mismatch") {
                throw new BackupOperationQueueError("conflict");
            }
            if (replay.kind === "replayed") {
                const run = matchingRun(replay.run, request, definition, enqueueSha256);
                if (run === undefined) throw new BackupOperationQueueError("conflict");
                return result(input, run);
            }
            if (requiredWorkerReleaseId === undefined) {
                throw new BackupOperationQueueError("unavailable");
            }
            let scheduleAssociation:
                | ReturnType<typeof resolveManualScheduleAssociation>
                | undefined;
            try {
                scheduleAssociation =
                    input.operation === "run"
                        ? resolveManualScheduleAssociation(
                              dependencies.repository,
                              input.type === "kopia"
                                  ? backupKopiaRunJobActionDefinition
                                  : backupWalgRunJobActionDefinition
                          )
                        : undefined;
            } catch {
                throw new BackupOperationQueueError("unavailable");
            }
            const dispatch = await request.authorizeDispatch();
            request.signal?.throwIfAborted();
            const payload = parseBackupOperationJobPayload(dispatch.payload);
            if (!payloadMatches(payload, input)) {
                throw new BackupOperationQueueError("conflict");
            }
            const atMs = nowMs();
            if (!Number.isSafeInteger(atMs) || atMs < 0) {
                throw new BackupOperationQueueError("unavailable");
            }
            const at = new Date(atMs);
            const runId = generateId();
            const sideEffects = createJobMutationSideEffects({
                action: "backups.operation.enqueue",
                actor: request.actor,
                auditId: generateId(),
                occurredAt: at,
                outcome: "accepted",
                realtime: { id: runId, kind: "run", operation: "created" },
                requestId: request.requestId,
                targetId: runId,
                targetType: "job-run",
            });
            const realtimeEvents =
                scheduleAssociation === undefined
                    ? sideEffects.realtimeEvents
                    : Object.freeze([
                          ...sideEffects.realtimeEvents,
                          ...createJobRealtimeSideEffects({
                              occurredAt: at,
                              realtime: {
                                  id: scheduleAssociation.scheduledJobId,
                                  kind: "schedule",
                                  operation: "updated",
                              },
                          }).realtimeEvents,
                      ]);
            let authorizationFailure: unknown;
            let enqueued: Awaited<ReturnType<JobRepository["enqueueManualRun"]>>;
            try {
                enqueued = await dependencies.repository.enqueueManualRun(
                    {
                        ...sideEffects,
                        realtimeEvents,
                        queuedEvent: {
                            attempt: 0,
                            jobRunId: runId,
                            kind: "queued",
                            message: null,
                            occurredAt: at,
                            progressJson: null,
                            sequence: 1,
                            workerInstanceId: null,
                        },
                        rejectWhenActionActive: true,
                        run: {
                            actionKey: definition.actionKey,
                            attemptLimit: definition.attemptLimit,
                            availableAt: at,
                            cancellationPolicy: definition.cancellationPolicy,
                            cancelRequestedAt: null,
                            cancelRequestedById: null,
                            cancelRequestedByKind: null,
                            displayName: definition.displayName,
                            enqueueSha256,
                            finishedAt: null,
                            firstStartedAt: null,
                            heartbeatAt: null,
                            id: runId,
                            idempotencyKey: input.idempotencyKey,
                            lastAttemptStartedAt: null,
                            leaseExpiresAt: null,
                            leaseOwnerId: null,
                            leaseToken: null,
                            payloadJson: JSON.stringify(payload),
                            priority: definition.priority,
                            queuedAt: at,
                            requestedById: request.actor.id,
                            requestedByKind: request.actor.kind,
                            requiredWorkerReleaseId,
                            resourceClass: definition.resourceClass,
                            resourceKeysJson: JSON.stringify(definition.resourceKeys),
                            resultJson: null,
                            retrySafe: definition.retrySafe,
                            scheduledForAt: null,
                            scheduledJobId: scheduleAssociation?.scheduledJobId ?? null,
                            scheduledJobVersion:
                                scheduleAssociation?.scheduledJobVersion ?? null,
                            state: "queued",
                            terminalCode: null,
                            terminalMessage: null,
                            timeoutMs: definition.timeoutMs,
                            triggerType: "manual",
                            updatedAt: at,
                        },
                    },
                    () => {
                        request.signal?.throwIfAborted();
                        try {
                            dispatch.authorize();
                            request.signal?.throwIfAborted();
                        } catch (error) {
                            authorizationFailure = error;
                            throw error;
                        }
                    }
                );
            } catch {
                if (authorizationFailure instanceof Error) throw authorizationFailure;
                let recovered: JobRunRecord | undefined;
                try {
                    recovered = dependencies.repository.findRunByIdempotency(
                        request.actor.kind,
                        request.actor.id,
                        input.idempotencyKey
                    );
                } catch {
                    throw new BackupOperationQueueError("unknown-outcome");
                }
                if (recovered === undefined) {
                    throw new BackupOperationQueueError("unknown-outcome");
                }
                const run = matchingRun(recovered, request, definition, enqueueSha256);
                if (run === undefined) throw new BackupOperationQueueError("conflict");
                await wake(run);
                return result(input, run);
            }
            if (enqueued.kind === "idempotency-mismatch" || enqueued.kind === "active") {
                throw new BackupOperationQueueError("conflict");
            }
            if (enqueued.kind === "action-unavailable") {
                throw new BackupOperationQueueError("unavailable");
            }
            const run = matchingRun(enqueued.run, request, definition, enqueueSha256);
            if (run === undefined) {
                throw new BackupOperationQueueError("unknown-outcome");
            }
            if (enqueued.kind === "inserted") await wake(run);
            return result(input, run);
        },
    };
    return Object.freeze(queue);
}
