import {
    serializeDeliveryProductionPayload,
    type DeliveryProductionOperationCapsule,
    type DeliveryProductionOperationInspection,
    type DeliveryProductionOperationRecord,
    type DeliveryProductionTerminalRecord,
} from "../../../shared/deliveryProductionOperation.ts";
import { deliveryProductionJobActionDefinition } from "./actionRegistry.ts";
import type { JobRunRecord } from "./records.ts";
import type { JobRepository } from "./repository.ts";
import {
    createJobMutationSideEffects,
    createJobRealtimeSideEffects,
} from "./sideEffects.ts";

const recoveryFailureMessage = "Delivery production recovery failed";

export class DeliveryProductionRecoveryError extends Error {
    override readonly name = "DeliveryProductionRecoveryError";
}

/** Minimal immutable-executor control authority needed before ordinary claims start. */
export interface DeliveryProductionRecoveryControlPort {
    readonly clear: (
        transitionId: string,
        signal?: AbortSignal
    ) => Promise<DeliveryProductionOperationRecord>;
    readonly inspectActive: (
        signal?: AbortSignal
    ) => Promise<DeliveryProductionOperationInspection>;
}

/** Receipt-backed startup reconciliation that completes before coordinator initialization. */
export interface DeliveryProductionRecoveryPort {
    readonly reconcileBeforeClaims: (signal?: AbortSignal) => Promise<void>;
}

export interface DeliveryProductionRecoveryOptions {
    readonly control: DeliveryProductionRecoveryControlPort;
    readonly readActive: (
        signal?: AbortSignal
    ) => Promise<DeliveryProductionOperationRecord | null>;
    readonly repository: Pick<
        JobRepository,
        | "enqueueManualRun"
        | "findEnqueueAuditProvenance"
        | "findRun"
        | "findRunByIdempotency"
        | "recoverExpiredClaims"
    >;
    readonly now?: () => Date;
    readonly wake?: () => Promise<void> | void;
}

function failure(): DeliveryProductionRecoveryError {
    return new DeliveryProductionRecoveryError(recoveryFailureMessage);
}

function exactRunMatchesCapsule(
    run: JobRunRecord,
    capsule: DeliveryProductionOperationCapsule
): boolean {
    const enqueue = capsule.enqueue;
    return (
        run.id === capsule.runId &&
        run.actionKey === enqueue.actionKey &&
        run.enqueueSha256 === enqueue.enqueueSha256 &&
        run.idempotencyKey === enqueue.idempotencyKey &&
        run.payloadJson === serializeDeliveryProductionPayload(enqueue.payload) &&
        run.requestedById === enqueue.actor.id &&
        run.requestedByKind === enqueue.actor.kind &&
        run.requiredWorkerReleaseId === null &&
        run.queuedAt.getTime() === enqueue.queuedAtMs &&
        run.scheduledJobId === null &&
        run.scheduledJobVersion === null &&
        run.triggerType === "manual" &&
        (run.state === "queued" ||
            run.state === "cancelled" ||
            run.state === "failed" ||
            run.state === "succeeded" ||
            run.state === "timed-out")
    );
}

function exactRunningRunMatchesCapsule(
    run: JobRunRecord,
    capsule: DeliveryProductionOperationCapsule
): boolean {
    return (
        run.state === "running" &&
        exactRunMatchesCapsule({ ...run, state: "queued" }, capsule)
    );
}

function exactAuditMatchesCapsule(
    options: DeliveryProductionRecoveryOptions,
    capsule: DeliveryProductionOperationCapsule
): boolean {
    const provenance = options.repository.findEnqueueAuditProvenance(capsule.runId);
    const enqueue = capsule.enqueue;
    return (
        provenance?.auditEventId === enqueue.audit.eventId &&
        provenance.actorId === enqueue.actor.id &&
        provenance.actorKind === enqueue.actor.kind &&
        provenance.authenticatorId === enqueue.actor.authenticatorId &&
        provenance.requestId === enqueue.audit.requestId &&
        provenance.occurredAt.getTime() === enqueue.queuedAtMs
    );
}

async function rehydrateMissingRun(
    options: DeliveryProductionRecoveryOptions,
    receipt: DeliveryProductionTerminalRecord
): Promise<JobRunRecord> {
    const { capsule } = receipt;
    const enqueue = capsule.enqueue;
    const queuedAt = new Date(enqueue.queuedAtMs);
    const definition = deliveryProductionJobActionDefinition;
    const sideEffects = createJobMutationSideEffects({
        action: "delivery.operation.enqueue",
        actor: {
            authenticatorId: enqueue.actor.authenticatorId,
            id: enqueue.actor.id,
            kind: enqueue.actor.kind,
        },
        auditId: enqueue.audit.eventId,
        occurredAt: queuedAt,
        outcome: "accepted",
        realtime: { id: capsule.runId, kind: "run", operation: "created" },
        requestId: enqueue.audit.requestId,
        targetId: capsule.runId,
        targetType: "job-run",
    });
    const result = await options.repository.enqueueManualRun({
        ...sideEffects,
        queuedEvent: {
            attempt: 0,
            jobRunId: capsule.runId,
            kind: "queued",
            message: null,
            occurredAt: queuedAt,
            progressJson: null,
            sequence: 1,
            workerInstanceId: null,
        },
        run: {
            actionKey: definition.actionKey,
            attemptLimit: definition.attemptLimit,
            availableAt: queuedAt,
            cancellationPolicy: definition.cancellationPolicy,
            cancelRequestedAt: null,
            cancelRequestedById: null,
            cancelRequestedByKind: null,
            displayName: definition.displayName,
            enqueueSha256: enqueue.enqueueSha256,
            finishedAt: null,
            firstStartedAt: null,
            heartbeatAt: null,
            id: capsule.runId,
            idempotencyKey: enqueue.idempotencyKey,
            lastAttemptStartedAt: null,
            leaseExpiresAt: null,
            leaseOwnerId: null,
            leaseToken: null,
            payloadJson: serializeDeliveryProductionPayload(enqueue.payload),
            priority: definition.priority,
            queuedAt,
            requestedById: enqueue.actor.id,
            requestedByKind: enqueue.actor.kind,
            requiredWorkerReleaseId: null,
            resourceClass: definition.resourceClass,
            resourceKeysJson: JSON.stringify(definition.resourceKeys),
            resultJson: null,
            retrySafe: definition.retrySafe,
            scheduledForAt: null,
            scheduledJobId: null,
            scheduledJobVersion: null,
            state: "queued",
            terminalCode: null,
            terminalMessage: null,
            timeoutMs: definition.timeoutMs,
            triggerType: "manual",
            updatedAt: queuedAt,
        },
    });
    if (
        (result.kind !== "inserted" && result.kind !== "replayed") ||
        !exactRunMatchesCapsule(result.run, capsule)
    ) {
        throw failure();
    }
    return result.run;
}

async function recoverTerminal(
    options: DeliveryProductionRecoveryOptions,
    inspection: Extract<DeliveryProductionOperationInspection, { state: "terminal" }>
): Promise<void> {
    const { capsule } = inspection.record;
    let run = options.repository.findRun(capsule.runId);
    if (run?.state === "running") {
        const leaseExpiresAt = run.leaseExpiresAt;
        const now = options.now?.() ?? new Date();
        if (
            leaseExpiresAt === null ||
            leaseExpiresAt.getTime() > now.getTime() ||
            !run.retrySafe ||
            !exactRunningRunMatchesCapsule(run, capsule) ||
            !exactAuditMatchesCapsule(options, capsule)
        ) {
            throw failure();
        }
        const recovered = await options.repository.recoverExpiredClaims({
            at: now,
            limit: 1,
            runId: capsule.runId,
            retryAt: () => now,
            sideEffectsForRun: (expired) =>
                createJobRealtimeSideEffects({
                    occurredAt: expired.updatedAt,
                    realtime: {
                        id: expired.id,
                        kind: "run",
                        operation: "updated",
                    },
                }),
        });
        if (
            recovered.length !== 1 ||
            recovered[0]?.id !== capsule.runId ||
            recovered[0].state !== "queued"
        ) {
            throw failure();
        }
        run = options.repository.findRun(capsule.runId);
    }
    if (run === undefined) {
        const byIdempotency = options.repository.findRunByIdempotency(
            capsule.enqueue.actor.kind,
            capsule.enqueue.actor.id,
            capsule.enqueue.idempotencyKey
        );
        if (byIdempotency !== undefined) throw failure();
        run = await rehydrateMissingRun(options, inspection.record);
    }
    if (
        !exactRunMatchesCapsule(run, capsule) ||
        !exactAuditMatchesCapsule(options, capsule)
    ) {
        throw failure();
    }
    const cleared = await options.control.clear(capsule.transitionId);
    if (JSON.stringify(cleared) !== JSON.stringify(inspection.record)) throw failure();
    await options.wake?.();
}

/**
 * Creates receipt-backed production recovery before schedules or ordinary claims start.
 * @param options Exact executor control, Job repository, and optional wake boundary.
 * @returns Startup recovery port.
 */
export function createDeliveryProductionRecovery(
    options: DeliveryProductionRecoveryOptions
): DeliveryProductionRecoveryPort {
    return Object.freeze({
        async reconcileBeforeClaims(signal?: AbortSignal) {
            signal?.throwIfAborted();
            if ((await options.readActive(signal)) === null) return;
            signal?.throwIfAborted();
            const inspection = await options.control.inspectActive(signal);
            signal?.throwIfAborted();
            if (inspection.state === "missing") return;
            if (inspection.state === "terminal") {
                await recoverTerminal(options, inspection);
                signal?.throwIfAborted();
                return;
            }
            throw failure();
        },
    });
}
