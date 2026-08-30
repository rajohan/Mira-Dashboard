import * as v from "valibot";

import {
    fullCommitShaSchema,
    lowercaseUuidV7Schema,
    nonnegativeSafeIntegerSchema,
} from "./validation.ts";

const invalidActivationRecord = "Production activation record is invalid";
/** Epoch shared only by activations that may safely restore one another's host policy. */
export const productionRollbackCompatibilityEpoch = 1;
const releaseRuntimeSchema = v.strictObject({
    releaseId: fullCommitShaSchema(invalidActivationRecord),
    runtimeRevision: fullCommitShaSchema(invalidActivationRecord),
});

/** Atomic authoritative identity for the active release/database pair. */
export const productionActivationRecordSchema = v.strictObject({
    formatVersion: v.literal(1, invalidActivationRecord),
    current: releaseRuntimeSchema,
    previous: v.nullable(
        v.strictObject({
            databaseSnapshotTransitionId: lowercaseUuidV7Schema(invalidActivationRecord),
            releaseId: fullCommitShaSchema(invalidActivationRecord),
            rollbackCompatibilityEpoch: v.optional(
                nonnegativeSafeIntegerSchema(invalidActivationRecord)
            ),
            runtimeRevision: fullCommitShaSchema(invalidActivationRecord),
        })
    ),
    rollbackCompatibilityEpoch: v.optional(
        nonnegativeSafeIntegerSchema(invalidActivationRecord)
    ),
    transitionId: lowercaseUuidV7Schema(invalidActivationRecord),
});

export type ProductionActivationRecord = v.InferOutput<
    typeof productionActivationRecordSchema
>;

/**
 * Parses and deeply freezes one untrusted activation record.
 * @param input Unknown JSON-compatible boundary value.
 * @returns Immutable authoritative release/database pairing.
 */
export function parseProductionActivationRecord(
    input: unknown
): ProductionActivationRecord {
    const parsed = v.safeParse(productionActivationRecordSchema, input, {
        abortEarly: true,
    });
    if (!parsed.success) throw new TypeError(invalidActivationRecord);
    Object.freeze(parsed.output.current);
    if (parsed.output.previous) Object.freeze(parsed.output.previous);
    return Object.freeze(parsed.output);
}

/**
 * Serializes one validated activation record canonically with one final newline.
 * @param input Parsed or untrusted activation record.
 * @returns Canonical JSON activation record.
 */
export function serializeProductionActivationRecord(input: unknown): string {
    return `${JSON.stringify(parseProductionActivationRecord(input), null, 2)}\n`;
}
