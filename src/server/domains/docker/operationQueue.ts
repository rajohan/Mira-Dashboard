import * as v from "valibot";

import type {
    DockerOperationId,
    DockerRequestOperationInput,
    DockerRequestOperationResult,
} from "../../../contracts/docker.ts";
import { dockerRequestOperationInputSchema } from "../../../contracts/docker.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { fullCommitShaSchema } from "../../../shared/validation.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import {
    dockerOperationJobActionDefinition,
    dockerUpdaterJobActionDefinition,
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
import {
    type DockerOperationJobPayload,
    parseDockerOperationJobPayload,
} from "./jobPayload.ts";
import type { DockerOperationActor } from "./operationAudit.ts";

export type DockerOperationQueueErrorReason =
    | "conflict"
    | "unavailable"
    | "unknown-outcome";

/** Sanitized durable enqueue failure; provider details remain worker-only. */
export class DockerOperationQueueError extends Error {
    readonly reason: DockerOperationQueueErrorReason;

    constructor(reason: DockerOperationQueueErrorReason) {
        super("Docker operation queue failed");
        this.name = "DockerOperationQueueError";
        this.reason = reason;
    }
}

export interface DockerOperationQueueRequest {
    readonly actor: DockerOperationActor;
    /** Resolves the exact payload and final synchronous auth/source/ticket fence. */
    readonly authorizeDispatch: () => Promise<{
        readonly authorize: () => void;
        /** Finalizes one-time authority only after an exact run is durably accepted. */
        readonly onAccepted: () => void;
        readonly payload: DockerOperationJobPayload;
    }>;
    readonly input: DockerRequestOperationInput;
    readonly requestId: string;
    readonly signal?: AbortSignal;
}

export interface DockerOperationQueue {
    readonly enqueue: (
        request: DockerOperationQueueRequest
    ) => Promise<DockerRequestOperationResult>;
}

export interface DockerOperationQueueDependencies {
    readonly generateId?: () => string;
    readonly nowMs?: () => number;
    readonly requiredWorkerReleaseId?: string;
    readonly repository: Pick<
        JobRepository,
        "enqueueManualRun" | "findRunByIdempotency" | "findSchedule"
    >;
    readonly wakeEventPump?: () => Promise<void> | void;
}

function usesUpdaterAction(operation: DockerOperationId): boolean {
    return (
        operation === "updater-run" ||
        operation === "updater-scan" ||
        operation === "updater-update-service"
    );
}

/**
 * Selects the only registered worker action allowed for one exact operation.
 * @param operation Exact public Docker operation.
 * @returns Its dedicated registered worker action definition.
 */
export function dockerActionDefinitionFor(operation: DockerOperationId) {
    return usesUpdaterAction(operation)
        ? dockerUpdaterJobActionDefinition
        : dockerOperationJobActionDefinition;
}

function enqueueDigest(
    actionKey: string,
    authenticatorId: string,
    input: DockerRequestOperationInput
): string {
    return sha256Hex(JSON.stringify({ actionKey, authenticatorId, input, version: 1 }));
}

function payloadMatchesInput(
    payload: DockerOperationJobPayload,
    input: DockerRequestOperationInput
): boolean {
    if (
        payload.operation !== input.operation ||
        payload.sourceRevision !== input.sourceRevision
    ) {
        return false;
    }
    switch (input.operation) {
        case "container-restart":
        case "container-start":
        case "container-stop": {
            return "containerId" in payload && payload.containerId === input.containerId;
        }
        case "image-delete": {
            return "imageId" in payload && payload.imageId === input.imageId;
        }
        case "prune-execute": {
            return "target" in payload && payload.target === input.target;
        }
        case "updater-update-service": {
            return (
                "serviceId" in payload &&
                payload.serviceId === input.serviceId &&
                payload.currentImage === input.currentImage &&
                payload.candidateImage === input.candidateImage
            );
        }
        case "volume-delete": {
            return "volumeName" in payload && payload.volumeName === input.volumeName;
        }
        case "stack-restart":
        case "stack-start":
        case "stack-stop":
        case "updater-run":
        case "updater-scan": {
            return true;
        }
    }
}

function matchingRun(
    run: JobRunRecord | undefined,
    request: DockerOperationQueueRequest,
    actionKey: string,
    enqueueSha256: string
): JobRunRecord | undefined {
    if (
        run === undefined ||
        run.actionKey !== actionKey ||
        run.enqueueSha256 !== enqueueSha256 ||
        run.idempotencyKey !== request.input.idempotencyKey ||
        run.requestedById !== request.actor.id ||
        run.requestedByKind !== request.actor.kind
    ) {
        return undefined;
    }
    try {
        const payload = parseDockerOperationJobPayload(parseJsonText(run.payloadJson));
        return payloadMatchesInput(payload, request.input) ? run : undefined;
    } catch {
        return undefined;
    }
}

function queueResult(
    operation: DockerOperationId,
    run: JobRunRecord
): DockerRequestOperationResult {
    return Object.freeze({ jobRunId: run.id, operation, queued: true });
}

/**
 * Creates one actor/session-bound durable queue. Docker updater operations use the
 * dedicated updater action; all action definitions share the global mutation resource
 * lease, while each action also rejects a second active intent.
 * @param dependencies Durable repository, release fence, clock, ids, and wake hook.
 * @returns One purpose-built Docker operation queue.
 */
export function createDockerOperationQueue(
    dependencies: DockerOperationQueueDependencies
): DockerOperationQueue {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = dependencies.nowMs ?? Date.now;
    const requiredWorkerReleaseId =
        dependencies.requiredWorkerReleaseId === undefined
            ? undefined
            : v.parse(
                  fullCommitShaSchema("Required Docker worker release is invalid"),
                  dependencies.requiredWorkerReleaseId
              );

    async function wakeQueuedRun(run: JobRunRecord): Promise<void> {
        if (run.state !== "queued") return;
        try {
            await dependencies.wakeEventPump?.();
        } catch {
            // The durable run remains authoritative for worker polling.
        }
    }

    const queue: DockerOperationQueue = {
        async enqueue(request) {
            request.signal?.throwIfAborted();
            const input = v.parse(dockerRequestOperationInputSchema, request.input);
            const definition = dockerActionDefinitionFor(input.operation);
            const enqueueSha256 = enqueueDigest(
                definition.actionKey,
                request.actor.authenticatorId,
                input
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
                throw new DockerOperationQueueError("unavailable");
            }
            if (replay.kind === "idempotency-mismatch") {
                throw new DockerOperationQueueError("conflict");
            }
            if (replay.kind === "replayed") {
                const run = matchingRun(
                    replay.run,
                    request,
                    definition.actionKey,
                    enqueueSha256
                );
                if (run === undefined) throw new DockerOperationQueueError("conflict");
                return queueResult(input.operation, run);
            }
            if (requiredWorkerReleaseId === undefined) {
                throw new DockerOperationQueueError("unavailable");
            }
            let scheduleAssociation:
                | ReturnType<typeof resolveManualScheduleAssociation>
                | undefined;
            try {
                scheduleAssociation = usesUpdaterAction(input.operation)
                    ? resolveManualScheduleAssociation(
                          dependencies.repository,
                          dockerUpdaterJobActionDefinition
                      )
                    : undefined;
            } catch {
                throw new DockerOperationQueueError("unavailable");
            }

            const atMs = nowMs();
            if (!Number.isSafeInteger(atMs) || atMs < 0) {
                throw new DockerOperationQueueError("unavailable");
            }
            const at = new Date(atMs);
            const runId = generateId();
            request.signal?.throwIfAborted();
            const dispatch = await request.authorizeDispatch();
            request.signal?.throwIfAborted();
            const payload = parseDockerOperationJobPayload(dispatch.payload);
            if (!payloadMatchesInput(payload, input)) {
                throw new DockerOperationQueueError("conflict");
            }
            const payloadJson = JSON.stringify(payload);
            const sideEffects = createJobMutationSideEffects({
                action: "docker.operation.enqueue",
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
            const enqueueInput = Object.freeze({
                ...sideEffects,
                realtimeEvents,
                queuedEvent: {
                    attempt: 0,
                    jobRunId: runId,
                    kind: "queued" as const,
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
                    payloadJson,
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
                    scheduledJobVersion: scheduleAssociation?.scheduledJobVersion ?? null,
                    state: "queued" as const,
                    terminalCode: null,
                    terminalMessage: null,
                    timeoutMs: definition.timeoutMs,
                    triggerType: "manual" as const,
                    updatedAt: at,
                },
            });

            let authorizationFailure: unknown;
            let enqueued: Awaited<ReturnType<JobRepository["enqueueManualRun"]>>;
            try {
                enqueued = await dependencies.repository.enqueueManualRun(
                    enqueueInput,
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
                if (authorizationFailure !== undefined) {
                    if (authorizationFailure instanceof Error) {
                        throw authorizationFailure;
                    }
                    throw new DockerOperationQueueError("unavailable");
                }
                let recovered: JobRunRecord | undefined;
                try {
                    recovered = dependencies.repository.findRunByIdempotency(
                        request.actor.kind,
                        request.actor.id,
                        input.idempotencyKey
                    );
                } catch {
                    throw new DockerOperationQueueError("unknown-outcome");
                }
                if (recovered === undefined) {
                    throw new DockerOperationQueueError("unknown-outcome");
                }
                const run = matchingRun(
                    recovered,
                    request,
                    definition.actionKey,
                    enqueueSha256
                );
                if (run === undefined) throw new DockerOperationQueueError("conflict");
                try {
                    dispatch.onAccepted();
                } catch {
                    throw new DockerOperationQueueError("unknown-outcome");
                }
                await wakeQueuedRun(run);
                return queueResult(input.operation, run);
            }

            if (enqueued.kind === "idempotency-mismatch" || enqueued.kind === "active") {
                throw new DockerOperationQueueError("conflict");
            }
            if (enqueued.kind === "action-unavailable") {
                throw new DockerOperationQueueError("unavailable");
            }
            const run = matchingRun(
                enqueued.run,
                request,
                definition.actionKey,
                enqueueSha256
            );
            if (run === undefined) {
                throw new DockerOperationQueueError("unknown-outcome");
            }
            try {
                dispatch.onAccepted();
            } catch {
                throw new DockerOperationQueueError("unknown-outcome");
            }
            if (enqueued.kind === "inserted") await wakeQueuedRun(run);
            return queueResult(input.operation, run);
        },
    };
    return Object.freeze(queue);
}
