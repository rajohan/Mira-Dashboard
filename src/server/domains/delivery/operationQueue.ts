import * as v from "valibot";

import type {
    DeliveryOperationId,
    DeliveryRequestOperationInput,
    DeliveryRequestOperationResult,
} from "../../../contracts/delivery.ts";
import { deliveryRequestOperationInputSchema } from "../../../contracts/delivery.ts";
import {
    type DeliveryOperationJobPayload,
    deliveryGitHubActionKey,
    deliveryJobActionKeyForPayload,
    deliveryPreviewActionKey,
    deliveryProductionActionKey,
    parseDeliveryOperationJobPayload,
} from "../../../contracts/deliveryWorker.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { fullCommitShaSchema } from "../../../shared/validation.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import { preflightManualEnqueue } from "../jobs/manualEnqueue.ts";
import type { JobRunRecord } from "../jobs/records.ts";
import type { JobRepository } from "../jobs/repository.ts";
import { createJobMutationSideEffects } from "../jobs/sideEffects.ts";
import type { DeliveryOperationActor } from "./operationAudit.ts";

export type DeliveryOperationQueueErrorReason =
    | "conflict"
    | "unavailable"
    | "unknown-outcome";

/** Sanitized durable enqueue failure; provider details remain worker-only. */
export class DeliveryOperationQueueError extends Error {
    readonly reason: DeliveryOperationQueueErrorReason;

    constructor(reason: DeliveryOperationQueueErrorReason) {
        super("Delivery operation queue failed");
        this.name = "DeliveryOperationQueueError";
        this.reason = reason;
    }
}

export interface DeliveryOperationQueueRequest {
    readonly actor: DeliveryOperationActor;
    readonly authorizeDispatch: () => Promise<{
        readonly authorize: () => void;
        readonly payload: DeliveryOperationJobPayload;
    }>;
    readonly input: DeliveryRequestOperationInput;
    readonly requestId: string;
    readonly signal?: AbortSignal;
}

export interface DeliveryOperationQueue {
    readonly enqueue: (
        request: DeliveryOperationQueueRequest
    ) => Promise<DeliveryRequestOperationResult>;
}

export interface DeliveryQueueActionDefinition {
    readonly actionKey:
        | typeof deliveryGitHubActionKey
        | typeof deliveryPreviewActionKey
        | typeof deliveryProductionActionKey;
    readonly attemptLimit: number;
    readonly cancellationPolicy: "cooperative" | "never" | "queued-only";
    readonly displayName: string;
    readonly priority: number;
    readonly resourceClass:
        | "exclusive"
        | "host-heavy"
        | "interactive"
        | "light"
        | "network";
    readonly resourceKeys: readonly string[];
    readonly retrySafe: boolean;
    readonly timeoutMs: number;
}

export interface DeliveryOperationQueueDependencies {
    readonly actionDefinitions: Readonly<
        Record<
            | typeof deliveryGitHubActionKey
            | typeof deliveryPreviewActionKey
            | typeof deliveryProductionActionKey,
            DeliveryQueueActionDefinition
        >
    >;
    readonly generateId?: () => string;
    readonly nowMs?: () => number;
    /** `null` is reserved for the journaled cross-release production protocol. */
    readonly requiredWorkerReleaseId: (
        actionKey: DeliveryQueueActionDefinition["actionKey"]
    ) => string | null | undefined;
    readonly repository: Pick<JobRepository, "enqueueManualRun" | "findRunByIdempotency">;
    readonly wakeEventPump?: () => Promise<void> | void;
}

function enqueueDigest(
    actionKey: string,
    authenticatorId: string,
    input: DeliveryRequestOperationInput
): string {
    return sha256Hex(JSON.stringify({ actionKey, authenticatorId, input, version: 1 }));
}

function headsMatch(
    left: readonly { readonly headSha: string; readonly number: number }[],
    right: readonly { readonly headSha: string; readonly number: number }[]
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (head, index) =>
                head.number === right[index]?.number &&
                head.headSha === right[index]?.headSha
        )
    );
}

function payloadMatchesInput(
    payload: DeliveryOperationJobPayload,
    input: DeliveryRequestOperationInput
): boolean {
    if (
        payload.operation !== input.operation ||
        payload.sourceRevision !== input.sourceRevision
    ) {
        return false;
    }
    switch (input.operation) {
        case "approve-review": {
            return (
                payload.operation === input.operation &&
                payload.number === input.number &&
                payload.expectedHeadSha === input.expectedHeadSha &&
                payload.reviewerRevision === input.reviewerRevision
            );
        }
        case "create-pull-request-stack": {
            return (
                payload.operation === input.operation &&
                headsMatch(payload.expectedHeads, input.expectedHeads)
            );
        }
        case "deploy": {
            return (
                payload.operation === input.operation &&
                payload.activationRevision === input.activationRevision &&
                payload.checkoutRevision === input.checkoutRevision &&
                payload.expectedMainHeadSha === input.expectedMainHeadSha
            );
        }
        case "merge-pull-request": {
            return (
                payload.operation === input.operation &&
                payload.number === input.number &&
                payload.mergeStack === input.mergeStack &&
                payload.checkoutRevision === input.checkoutRevision &&
                headsMatch(payload.expectedHeads, input.expectedHeads)
            );
        }
        case "reject-pull-request":
        case "update-branch": {
            return (
                payload.operation === input.operation &&
                payload.number === input.number &&
                payload.expectedHeadSha === input.expectedHeadSha
            );
        }
        case "rollback-release": {
            return (
                payload.operation === input.operation &&
                payload.activationRevision === input.activationRevision &&
                JSON.stringify(payload.target) === JSON.stringify(input.target)
            );
        }
        case "start-preview": {
            return (
                payload.operation === input.operation &&
                payload.number === input.number &&
                payload.previewRevision === input.previewRevision &&
                headsMatch(payload.expectedHeads, input.expectedHeads)
            );
        }
        case "stop-preview": {
            return (
                payload.operation === input.operation &&
                payload.number === input.number &&
                payload.previewRevision === input.previewRevision
            );
        }
    }
}

function matchingRun(
    run: JobRunRecord | undefined,
    request: DeliveryOperationQueueRequest,
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
        const payload = parseDeliveryOperationJobPayload(parseJsonText(run.payloadJson));
        return payloadMatchesInput(payload, request.input) ? run : undefined;
    } catch {
        return undefined;
    }
}

function queueResult(
    operation: DeliveryOperationId,
    run: JobRunRecord
): DeliveryRequestOperationResult {
    return Object.freeze({ jobRunId: run.id, operation, queued: true });
}

function validatedDefinition(
    dependencies: DeliveryOperationQueueDependencies,
    actionKey: DeliveryQueueActionDefinition["actionKey"]
): DeliveryQueueActionDefinition {
    const definition = dependencies.actionDefinitions[actionKey];
    if (definition.actionKey !== actionKey) {
        throw new DeliveryOperationQueueError("unavailable");
    }
    return definition;
}

function actionKeyForInput(
    input: DeliveryRequestOperationInput
): DeliveryQueueActionDefinition["actionKey"] {
    if (input.operation === "start-preview" || input.operation === "stop-preview") {
        return deliveryPreviewActionKey;
    }
    if (input.operation === "deploy" || input.operation === "rollback-release") {
        return deliveryProductionActionKey;
    }
    return deliveryGitHubActionKey;
}

function releaseFence(
    dependencies: DeliveryOperationQueueDependencies,
    actionKey: DeliveryQueueActionDefinition["actionKey"]
): string | null | undefined {
    const releaseId = dependencies.requiredWorkerReleaseId(actionKey);
    if (releaseId === undefined) return undefined;
    if (releaseId === null) {
        return actionKey === deliveryProductionActionKey ? null : undefined;
    }
    return v.parse(
        fullCommitShaSchema("Required Delivery worker release is invalid"),
        releaseId
    );
}

/**
 * Creates one actor/session-bound durable queue for the three fixed Delivery actions.
 * @param dependencies Definitions, durable repository, release fence, ids, and wake hook.
 * @returns One purpose-built Delivery operation queue.
 */
export function createDeliveryOperationQueue(
    dependencies: DeliveryOperationQueueDependencies
): DeliveryOperationQueue {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = dependencies.nowMs ?? Date.now;

    async function wakeQueuedRun(run: JobRunRecord): Promise<void> {
        if (run.state !== "queued") return;
        try {
            await dependencies.wakeEventPump?.();
        } catch {
            // Durable worker polling remains authoritative.
        }
    }

    const queue: DeliveryOperationQueue = {
        async enqueue(request) {
            request.signal?.throwIfAborted();
            const input = v.parse(deliveryRequestOperationInputSchema, request.input);
            const definition = validatedDefinition(
                dependencies,
                actionKeyForInput(input)
            );
            const requiredWorkerReleaseId = releaseFence(
                dependencies,
                definition.actionKey
            );
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
                throw new DeliveryOperationQueueError("unavailable");
            }
            if (replay.kind === "idempotency-mismatch") {
                throw new DeliveryOperationQueueError("conflict");
            }
            if (replay.kind === "replayed") {
                const run = matchingRun(
                    replay.run,
                    request,
                    definition.actionKey,
                    enqueueSha256
                );
                if (run === undefined) {
                    throw new DeliveryOperationQueueError("conflict");
                }
                return queueResult(input.operation, run);
            }
            if (requiredWorkerReleaseId === undefined) {
                throw new DeliveryOperationQueueError("unavailable");
            }

            request.signal?.throwIfAborted();
            const dispatch = await request.authorizeDispatch();
            request.signal?.throwIfAborted();
            const payload = parseDeliveryOperationJobPayload(dispatch.payload);
            if (
                !payloadMatchesInput(payload, input) ||
                deliveryJobActionKeyForPayload(payload) !== definition.actionKey
            ) {
                throw new DeliveryOperationQueueError("conflict");
            }

            const atMs = nowMs();
            if (!Number.isSafeInteger(atMs) || atMs < 0) {
                throw new DeliveryOperationQueueError("unavailable");
            }
            const at = new Date(atMs);
            const runId = generateId();
            const payloadJson = JSON.stringify(payload);
            const sideEffects = createJobMutationSideEffects({
                action: "delivery.operation.enqueue",
                actor: request.actor,
                auditId: generateId(),
                occurredAt: at,
                outcome: "accepted",
                realtime: { id: runId, kind: "run", operation: "created" },
                requestId: request.requestId,
                targetId: runId,
                targetType: "job-run",
            });
            const enqueueInput = Object.freeze({
                ...sideEffects,
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
                rejectWhenAnyActionActive: [
                    deliveryGitHubActionKey,
                    deliveryPreviewActionKey,
                    deliveryProductionActionKey,
                ],
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
                    scheduledJobId: null,
                    scheduledJobVersion: null,
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
                    throw new DeliveryOperationQueueError("unavailable");
                }
                let recovered: JobRunRecord | undefined;
                try {
                    recovered = dependencies.repository.findRunByIdempotency(
                        request.actor.kind,
                        request.actor.id,
                        input.idempotencyKey
                    );
                } catch {
                    throw new DeliveryOperationQueueError("unknown-outcome");
                }
                if (recovered === undefined) {
                    throw new DeliveryOperationQueueError("unknown-outcome");
                }
                const run = matchingRun(
                    recovered,
                    request,
                    definition.actionKey,
                    enqueueSha256
                );
                if (run === undefined) {
                    throw new DeliveryOperationQueueError("conflict");
                }
                await wakeQueuedRun(run);
                return queueResult(input.operation, run);
            }

            if (enqueued.kind === "idempotency-mismatch" || enqueued.kind === "active") {
                throw new DeliveryOperationQueueError("conflict");
            }
            if (enqueued.kind === "action-unavailable") {
                throw new DeliveryOperationQueueError("unavailable");
            }
            const run = matchingRun(
                enqueued.run,
                request,
                definition.actionKey,
                enqueueSha256
            );
            if (run === undefined) {
                throw new DeliveryOperationQueueError("unknown-outcome");
            }
            if (enqueued.kind === "inserted") await wakeQueuedRun(run);
            return queueResult(input.operation, run);
        },
    };
    return Object.freeze(queue);
}
