import * as v from "valibot";

import { timestampMillisecondsSchema } from "./dateTime.ts";
import { deliveryOperationWarningsSchema } from "./deliveryOperationWarnings.ts";
import { utf8ByteLength } from "./encoding.ts";
import { productionActivationRecordSchema } from "./productionActivationRecord.ts";
import {
    boundedControlSafeTextSchema,
    fullCommitShaSchema,
    lowercaseSha256Schema,
    lowercaseUuidV7Schema,
    positiveSafeIntegerSchema,
} from "./validation.ts";

const invalidDeliveryProductionOperation = "Delivery production operation is invalid";
const deliveryProductionPayloadMaximumBytes = 16 * 1024;

/** Immutable protocol supported by production cutover executors. */
export const deliveryProductionProtocol = "delivery.production.v1" as const;
/** Maximum canonical bytes accepted for an operation journal or terminal receipt. */
export const deliveryProductionOperationMaximumBytes = 64 * 1024;

/** Ordered durable phases before one terminal receipt exists. */
export const deliveryProductionOperationPhases = Object.freeze([
    "intent-recorded",
    "executor-confirmed",
    "services-stopped",
    "current-snapshot-created",
    "target-database-ready",
    "target-services-started",
    "target-verified",
    "target-smoke-verified",
    "normal-runtime-starting",
] as const);

export type DeliveryProductionOperationPhase =
    (typeof deliveryProductionOperationPhases)[number];

const boundedIdentitySchema = boundedControlSafeTextSchema(
    128,
    invalidDeliveryProductionOperation
);
const canonicalIdempotencyKeySchema = v.pipe(
    v.string(invalidDeliveryProductionOperation),
    v.minLength(32, invalidDeliveryProductionOperation),
    v.maxLength(128, invalidDeliveryProductionOperation),
    v.regex(/^[A-Za-z0-9_-]+$/u, invalidDeliveryProductionOperation)
);
const releaseRuntimeSchema = v.strictObject({
    releaseId: fullCommitShaSchema(invalidDeliveryProductionOperation),
    runtimeRevision: fullCommitShaSchema(invalidDeliveryProductionOperation),
});
const currentReleaseCasSchema = v.strictObject({
    activationTransitionId: lowercaseUuidV7Schema(invalidDeliveryProductionOperation),
    releaseId: fullCommitShaSchema(invalidDeliveryProductionOperation),
    rollbackSnapshotTransitionId: lowercaseUuidV7Schema(
        invalidDeliveryProductionOperation
    ),
    runtimeRevision: fullCommitShaSchema(invalidDeliveryProductionOperation),
});
const targetReleaseCasSchema = v.strictObject({
    databaseSnapshotTransitionId: v.nullable(
        lowercaseUuidV7Schema(invalidDeliveryProductionOperation)
    ),
    releaseId: fullCommitShaSchema(invalidDeliveryProductionOperation),
    runtimeRevision: fullCommitShaSchema(invalidDeliveryProductionOperation),
});

const productionPullRequestNumberSchema = positiveSafeIntegerSchema(
    invalidDeliveryProductionOperation
);
const productionExpectedHeadSchema = v.strictObject({
    headSha: fullCommitShaSchema(invalidDeliveryProductionOperation),
    number: productionPullRequestNumberSchema,
});
const productionExpectedHeadsSchema = v.pipe(
    v.array(productionExpectedHeadSchema, invalidDeliveryProductionOperation),
    v.minLength(1, invalidDeliveryProductionOperation),
    v.maxLength(100, invalidDeliveryProductionOperation),
    v.check(
        (heads) => new Set(heads.map(({ number }) => number)).size === heads.length,
        invalidDeliveryProductionOperation
    )
);
const deployJobPayloadSchema = v.strictObject({
    activationRevision: lowercaseSha256Schema(invalidDeliveryProductionOperation),
    checkoutRevision: lowercaseSha256Schema(invalidDeliveryProductionOperation),
    expectedMainHeadSha: fullCommitShaSchema(invalidDeliveryProductionOperation),
    operation: v.literal("deploy", invalidDeliveryProductionOperation),
    sourceRevision: lowercaseSha256Schema(invalidDeliveryProductionOperation),
});
const mergeDeployJobPayloadSchema = v.strictObject({
    activationRevision: lowercaseSha256Schema(invalidDeliveryProductionOperation),
    checkoutRevision: lowercaseSha256Schema(invalidDeliveryProductionOperation),
    deploy: v.literal(true, invalidDeliveryProductionOperation),
    expectedHeads: productionExpectedHeadsSchema,
    mergeStack: v.boolean(invalidDeliveryProductionOperation),
    number: productionPullRequestNumberSchema,
    operation: v.literal("merge-pull-request", invalidDeliveryProductionOperation),
    sourceRevision: lowercaseSha256Schema(invalidDeliveryProductionOperation),
});
const rollbackJobPayloadSchema = v.strictObject({
    activationRevision: lowercaseSha256Schema(invalidDeliveryProductionOperation),
    operation: v.literal("rollback-release", invalidDeliveryProductionOperation),
    sourceRevision: lowercaseSha256Schema(invalidDeliveryProductionOperation),
    target: v.strictObject({
        databaseSnapshotTransitionId: lowercaseUuidV7Schema(
            invalidDeliveryProductionOperation
        ),
        releaseId: fullCommitShaSchema(invalidDeliveryProductionOperation),
        runtimeRevision: fullCommitShaSchema(invalidDeliveryProductionOperation),
    }),
});

/** Exact original Job payload variants eligible for cross-release rehydration. */
export const deliveryProductionJobPayloadSchema = v.pipe(
    v.variant("operation", [
        deployJobPayloadSchema,
        mergeDeployJobPayloadSchema,
        rollbackJobPayloadSchema,
    ]),
    v.check(
        (payload) =>
            utf8ByteLength(JSON.stringify(payload)) <=
            deliveryProductionPayloadMaximumBytes,
        invalidDeliveryProductionOperation
    )
);

export type DeliveryProductionJobPayload = v.InferOutput<
    typeof deliveryProductionJobPayloadSchema
>;

/** Secret-free enqueue capsule sufficient to rehydrate an exact durable Job run. */
export const deliveryProductionOperationCapsuleSchema = v.strictObject({
    cas: v.strictObject({
        current: currentReleaseCasSchema,
        target: targetReleaseCasSchema,
    }),
    enqueue: v.strictObject({
        actionKey: v.literal(
            "delivery.production.v1",
            invalidDeliveryProductionOperation
        ),
        actor: v.strictObject({
            authenticatorId: boundedIdentitySchema,
            id: boundedIdentitySchema,
            kind: v.literal("user", invalidDeliveryProductionOperation),
        }),
        audit: v.strictObject({
            eventId: lowercaseUuidV7Schema(invalidDeliveryProductionOperation),
            requestId: boundedIdentitySchema,
        }),
        enqueueSha256: lowercaseSha256Schema(invalidDeliveryProductionOperation),
        idempotencyKey: canonicalIdempotencyKeySchema,
        payload: deliveryProductionJobPayloadSchema,
        payloadSha256: lowercaseSha256Schema(invalidDeliveryProductionOperation),
        queuedAtMs: timestampMillisecondsSchema(invalidDeliveryProductionOperation),
    }),
    executor: v.strictObject({
        releaseId: fullCommitShaSchema(invalidDeliveryProductionOperation),
        runtimeRevision: fullCommitShaSchema(invalidDeliveryProductionOperation),
    }),
    protocol: v.literal(deliveryProductionProtocol, invalidDeliveryProductionOperation),
    preCutoverWarnings: v.optional(
        deliveryOperationWarningsSchema(invalidDeliveryProductionOperation)
    ),
    runId: lowercaseUuidV7Schema(invalidDeliveryProductionOperation),
    transitionId: lowercaseUuidV7Schema(invalidDeliveryProductionOperation),
});

export type DeliveryProductionOperationCapsule = v.InferOutput<
    typeof deliveryProductionOperationCapsuleSchema
>;

const terminalFailureReasons = [
    "activation-failed",
    "candidate-invalid",
    "capacity-unavailable",
    "readiness-failed",
    "recovery-conflict",
    "rollback-failed",
    "snapshot-failed",
    "source-conflict",
] as const;

const terminalResultSchema = v.variant("outcome", [
    v.strictObject({
        activation: productionActivationRecordSchema,
        completedAtMs: timestampMillisecondsSchema(invalidDeliveryProductionOperation),
        outcome: v.literal("succeeded", invalidDeliveryProductionOperation),
    }),
    v.strictObject({
        activation: v.nullable(productionActivationRecordSchema),
        completedAtMs: timestampMillisecondsSchema(invalidDeliveryProductionOperation),
        outcome: v.literal("failed", invalidDeliveryProductionOperation),
        reason: v.picklist(terminalFailureReasons, invalidDeliveryProductionOperation),
    }),
    v.strictObject({
        activation: v.nullable(productionActivationRecordSchema),
        completedAtMs: timestampMillisecondsSchema(invalidDeliveryProductionOperation),
        outcome: v.literal("unknown-outcome", invalidDeliveryProductionOperation),
    }),
]);

const nonterminalRecordSchema = v.strictObject({
    capsule: deliveryProductionOperationCapsuleSchema,
    phase: v.picklist(
        deliveryProductionOperationPhases,
        invalidDeliveryProductionOperation
    ),
    updatedAtMs: timestampMillisecondsSchema(invalidDeliveryProductionOperation),
});
const terminalRecordSchema = v.strictObject({
    capsule: deliveryProductionOperationCapsuleSchema,
    phase: v.literal("terminal", invalidDeliveryProductionOperation),
    result: terminalResultSchema,
    updatedAtMs: timestampMillisecondsSchema(invalidDeliveryProductionOperation),
});

/** Durable in-flight record and immutable receipt representation. */
export const deliveryProductionOperationRecordSchema = v.variant("phase", [
    nonterminalRecordSchema,
    terminalRecordSchema,
]);

export type DeliveryProductionOperationRecord = v.InferOutput<
    typeof deliveryProductionOperationRecordSchema
>;
export type DeliveryProductionTerminalRecord = Extract<
    DeliveryProductionOperationRecord,
    { phase: "terminal" }
>;
export type DeliveryProductionTerminalResult = DeliveryProductionTerminalRecord["result"];

/** Bounded worker/executor recovery inspection returned by the immutable control mode. */
export const deliveryProductionOperationInspectionSchema = v.variant("state", [
    v.strictObject({
        state: v.literal("conflict", invalidDeliveryProductionOperation),
        transitionId: lowercaseUuidV7Schema(invalidDeliveryProductionOperation),
    }),
    v.strictObject({
        record: nonterminalRecordSchema,
        state: v.literal("in-progress", invalidDeliveryProductionOperation),
        transitionId: lowercaseUuidV7Schema(invalidDeliveryProductionOperation),
    }),
    v.strictObject({
        state: v.literal("missing", invalidDeliveryProductionOperation),
        transitionId: v.optional(
            lowercaseUuidV7Schema(invalidDeliveryProductionOperation)
        ),
    }),
    v.strictObject({
        record: terminalRecordSchema,
        state: v.literal("terminal", invalidDeliveryProductionOperation),
        transitionId: lowercaseUuidV7Schema(invalidDeliveryProductionOperation),
    }),
]);

export type DeliveryProductionOperationInspection = v.InferOutput<
    typeof deliveryProductionOperationInspectionSchema
>;

/** Activation and journal identities whose terminal receipts must survive retention. */
export const deliveryProductionReceiptRetentionSchema = v.strictObject({
    currentTransitionId: v.nullable(
        lowercaseUuidV7Schema(invalidDeliveryProductionOperation)
    ),
    inFlightTransitionId: v.nullable(
        lowercaseUuidV7Schema(invalidDeliveryProductionOperation)
    ),
    previousTransitionId: v.nullable(
        lowercaseUuidV7Schema(invalidDeliveryProductionOperation)
    ),
});

export type DeliveryProductionReceiptRetention = v.InferOutput<
    typeof deliveryProductionReceiptRetentionSchema
>;

function canonicalPayloadText(
    payload: DeliveryProductionOperationCapsule["enqueue"]["payload"]
): string {
    return JSON.stringify(payload);
}

function recordActivationMatchesTuple(
    activation: v.InferOutput<typeof productionActivationRecordSchema>,
    tuple: v.InferOutput<typeof releaseRuntimeSchema>
): boolean {
    return (
        activation.current.releaseId === tuple.releaseId &&
        activation.current.runtimeRevision === tuple.runtimeRevision
    );
}

function capsuleIsConsistent(capsule: DeliveryProductionOperationCapsule): boolean {
    const { cas, enqueue, runId, transitionId } = capsule;
    if (
        runId !== transitionId ||
        cas.current.rollbackSnapshotTransitionId !== transitionId ||
        cas.current.releaseId === cas.target.releaseId ||
        utf8ByteLength(canonicalPayloadText(enqueue.payload)) >
            deliveryProductionPayloadMaximumBytes
    ) {
        return false;
    }
    const payload = enqueue.payload;
    if (payload.operation === "rollback-release") {
        return (
            cas.target.databaseSnapshotTransitionId !== null &&
            cas.target.databaseSnapshotTransitionId !== transitionId &&
            cas.target.databaseSnapshotTransitionId ===
                payload.target.databaseSnapshotTransitionId &&
            cas.target.releaseId === payload.target.releaseId &&
            cas.target.runtimeRevision === payload.target.runtimeRevision
        );
    }
    return (
        cas.target.databaseSnapshotTransitionId === null &&
        (payload.operation !== "deploy" ||
            payload.expectedMainHeadSha === cas.target.releaseId)
    );
}

function activationMatchesPrior(
    capsule: DeliveryProductionOperationCapsule,
    activation: v.InferOutput<typeof productionActivationRecordSchema>
): boolean {
    return (
        activation.transitionId === capsule.cas.current.activationTransitionId &&
        recordActivationMatchesTuple(activation, capsule.cas.current)
    );
}

function activationMatchesTarget(
    capsule: DeliveryProductionOperationCapsule,
    activation: v.InferOutput<typeof productionActivationRecordSchema>
): boolean {
    if (
        activation.transitionId !== capsule.transitionId ||
        !recordActivationMatchesTuple(activation, capsule.cas.target)
    ) {
        return false;
    }
    const previous = activation.previous;
    return (
        previous !== null &&
        previous.databaseSnapshotTransitionId ===
            capsule.cas.current.rollbackSnapshotTransitionId &&
        previous.releaseId === capsule.cas.current.releaseId &&
        previous.runtimeRevision === capsule.cas.current.runtimeRevision
    );
}

function recordIsConsistent(record: DeliveryProductionOperationRecord): boolean {
    if (
        !capsuleIsConsistent(record.capsule) ||
        record.updatedAtMs < record.capsule.enqueue.queuedAtMs
    ) {
        return false;
    }
    if (record.phase !== "terminal") return true;
    if (
        record.updatedAtMs !== record.result.completedAtMs ||
        record.result.completedAtMs < record.capsule.enqueue.queuedAtMs
    ) {
        return false;
    }
    if (record.result.outcome === "succeeded") {
        return activationMatchesTarget(record.capsule, record.result.activation);
    }
    return (
        record.result.activation === null ||
        activationMatchesPrior(record.capsule, record.result.activation) ||
        activationMatchesTarget(record.capsule, record.result.activation)
    );
}

function freezeActivation(
    activation: v.InferOutput<typeof productionActivationRecordSchema> | null
): void {
    if (!activation) return;
    Object.freeze(activation.current);
    if (activation.previous) Object.freeze(activation.previous);
    Object.freeze(activation);
}

function freezeCapsule(capsule: DeliveryProductionOperationCapsule): void {
    Object.freeze(capsule.cas.current);
    Object.freeze(capsule.cas.target);
    Object.freeze(capsule.cas);
    Object.freeze(capsule.enqueue.actor);
    Object.freeze(capsule.enqueue.audit);
    Object.freeze(capsule.enqueue.payload);
    Object.freeze(capsule.enqueue);
    Object.freeze(capsule);
}

/**
 * Parses and deeply freezes one secret-free rehydration capsule.
 * @param input Untrusted capsule candidate.
 * @returns Parsed immutable capsule.
 */
export function parseDeliveryProductionOperationCapsule(
    input: unknown
): DeliveryProductionOperationCapsule {
    const parsed = v.safeParse(deliveryProductionOperationCapsuleSchema, input, {
        abortEarly: true,
    });
    if (!parsed.success || !capsuleIsConsistent(parsed.output)) {
        throw new TypeError(invalidDeliveryProductionOperation);
    }
    freezeCapsule(parsed.output);
    return parsed.output;
}

/**
 * Parses and deeply freezes one in-flight journal or immutable terminal receipt.
 * @param input Untrusted record candidate.
 * @returns Parsed immutable journal or receipt.
 */
export function parseDeliveryProductionOperationRecord(
    input: unknown
): DeliveryProductionOperationRecord {
    const parsed = v.safeParse(deliveryProductionOperationRecordSchema, input, {
        abortEarly: true,
    });
    if (!parsed.success || !recordIsConsistent(parsed.output)) {
        throw new TypeError(invalidDeliveryProductionOperation);
    }
    freezeCapsule(parsed.output.capsule);
    if (parsed.output.phase === "terminal") {
        freezeActivation(parsed.output.result.activation);
        Object.freeze(parsed.output.result);
    }
    return Object.freeze(parsed.output);
}

/**
 * Parses and freezes one immutable executor recovery inspection.
 * @param input Untrusted executor inspection value.
 * @returns Parsed immutable inspection.
 */
export function parseDeliveryProductionOperationInspection(
    input: unknown
): DeliveryProductionOperationInspection {
    const parsed = v.parse(deliveryProductionOperationInspectionSchema, input);
    if ("record" in parsed) parseDeliveryProductionOperationRecord(parsed.record);
    return Object.freeze(parsed);
}

/**
 * Canonically serializes a parsed or untrusted capsule with one final newline.
 * @param input Parsed or untrusted capsule.
 * @returns Canonical bounded JSON text.
 */
export function serializeDeliveryProductionOperationCapsule(input: unknown): string {
    const text = `${JSON.stringify(parseDeliveryProductionOperationCapsule(input), null, 2)}\n`;
    if (utf8ByteLength(text) > deliveryProductionOperationMaximumBytes) {
        throw new TypeError(invalidDeliveryProductionOperation);
    }
    return text;
}

/**
 * Canonically serializes a parsed or untrusted journal/receipt with one final newline.
 * @param input Parsed or untrusted record.
 * @returns Canonical bounded JSON text.
 */
export function serializeDeliveryProductionOperationRecord(input: unknown): string {
    const text = `${JSON.stringify(parseDeliveryProductionOperationRecord(input), null, 2)}\n`;
    if (utf8ByteLength(text) > deliveryProductionOperationMaximumBytes) {
        throw new TypeError(invalidDeliveryProductionOperation);
    }
    return text;
}

/**
 * Returns the canonical payload bytes whose SHA-256 is captured by the enqueue capsule.
 * @param input Strict secret-free production payload.
 * @returns Canonical compact JSON payload text.
 */
export function serializeDeliveryProductionPayload(
    input: DeliveryProductionOperationCapsule["enqueue"]["payload"]
): string {
    const capsulePayload = v.parse(deliveryProductionJobPayloadSchema, input);
    return canonicalPayloadText(capsulePayload);
}

/**
 * Returns whether a durable phase can follow the exact currently persisted phase.
 * @param current Currently durable phase.
 * @param next Requested next phase.
 * @returns Whether the phases are exactly adjacent.
 */
export function deliveryProductionPhaseCanAdvance(
    current: DeliveryProductionOperationPhase,
    next: DeliveryProductionOperationPhase
): boolean {
    return (
        deliveryProductionOperationPhases.indexOf(next) ===
        deliveryProductionOperationPhases.indexOf(current) + 1
    );
}

/**
 * Validates, de-duplicates, and sorts current/previous/in-flight receipt identities.
 * @param input Authoritative activation and journal identities.
 * @returns Canonically sorted immutable identity set.
 */
export function retainedDeliveryProductionReceiptIds(
    input: DeliveryProductionReceiptRetention
): readonly string[] {
    const parsed = v.parse(deliveryProductionReceiptRetentionSchema, input);
    return Object.freeze(
        [
            ...new Set(
                Object.values(parsed).filter((value): value is string => value !== null)
            ),
        ].toSorted()
    );
}
