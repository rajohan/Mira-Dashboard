import * as v from "valibot";

import { databaseSnapshotManifestSchema } from "./databaseSnapshotManifest.ts";
import { productionActivationRecordSchema } from "./productionActivationRecord.ts";
import { fullCommitShaSchema, lowercaseUuidV7Schema } from "./validation.ts";

const invalidActivationTransition = "Production activation transition is invalid";
const releaseRuntimeSchema = v.strictObject({
    releaseId: fullCommitShaSchema(invalidActivationTransition),
    runtimeRevision: fullCommitShaSchema(invalidActivationTransition),
});
const sourceDatabaseIdentitySchema = v.strictObject({
    ctimeNs: v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d{0,39})$/u)),
    device: v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d{0,39})$/u)),
    inode: v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d{0,39})$/u)),
    mtimeNs: v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d{0,39})$/u)),
    size: v.pipe(v.string(), v.regex(/^[1-9]\d{0,39}$/u)),
});
const transitionIdentitySchema = {
    candidate: releaseRuntimeSchema,
    formatVersion: v.literal(1, invalidActivationTransition),
    previousActivation: v.nullable(productionActivationRecordSchema),
    transitionId: lowercaseUuidV7Schema(invalidActivationTransition),
} as const;
const recordedPreviousDatabaseSchema = v.variant("state", [
    v.strictObject({ state: v.literal("absent") }),
    v.strictObject({
        manifest: databaseSnapshotManifestSchema,
        sourceDatabase: sourceDatabaseIdentitySchema,
        state: v.literal("present"),
    }),
]);

/** Durable recovery journal spanning database promotion and activation-record commit. */
export const productionActivationTransitionSchema = v.variant("phase", [
    v.strictObject({
        ...transitionIdentitySchema,
        phase: v.literal("service-stop-requested"),
        previousDatabase: v.strictObject({ state: v.literal("unrecorded") }),
    }),
    v.strictObject({
        ...transitionIdentitySchema,
        phase: v.literal("prepared"),
        previousDatabase: recordedPreviousDatabaseSchema,
    }),
    v.strictObject({
        ...transitionIdentitySchema,
        phase: v.literal("database-promoted"),
        previousDatabase: recordedPreviousDatabaseSchema,
    }),
    v.strictObject({
        ...transitionIdentitySchema,
        phase: v.literal("rollback-required"),
        previousDatabase: recordedPreviousDatabaseSchema,
    }),
]);

export type ProductionActivationTransition = v.InferOutput<
    typeof productionActivationTransitionSchema
>;
export type ProductionActivationPreviousDatabase = Extract<
    ProductionActivationTransition,
    { phase: "prepared" }
>["previousDatabase"];

function freezeTransitionIdentity(transition: ProductionActivationTransition): void {
    Object.freeze(transition.candidate);
    if (transition.previousActivation) {
        Object.freeze(transition.previousActivation.current);
        if (transition.previousActivation.previous) {
            Object.freeze(transition.previousActivation.previous);
        }
        Object.freeze(transition.previousActivation);
    }
}

/**
 * Parses, validates semantic pairing, and freezes one recovery journal.
 * @param input Unknown JSON-compatible transition value.
 * @returns Immutable activation transition journal.
 */
export function parseProductionActivationTransition(
    input: unknown
): ProductionActivationTransition {
    const parsed = v.safeParse(productionActivationTransitionSchema, input, {
        abortEarly: true,
    });
    if (!parsed.success) throw new TypeError(invalidActivationTransition);
    const transition = parsed.output;
    freezeTransitionIdentity(transition);
    if (transition.phase === "service-stop-requested") {
        Object.freeze(transition.previousDatabase);
        return Object.freeze(transition);
    }
    const validAbsentPair =
        transition.previousDatabase.state === "absent" &&
        transition.previousActivation === null;
    const validPresentPair =
        transition.previousDatabase.state === "present" &&
        transition.previousActivation !== null &&
        transition.previousDatabase.manifest.transitionId === transition.transitionId &&
        transition.previousDatabase.manifest.releaseId ===
            transition.previousActivation.current.releaseId;
    if (!validAbsentPair && !validPresentPair) {
        throw new TypeError(invalidActivationTransition);
    }
    if (transition.previousDatabase.state === "present") {
        Object.freeze(transition.previousDatabase.manifest.database);
        for (const migration of transition.previousDatabase.manifest.migrations) {
            Object.freeze(migration);
        }
        Object.freeze(transition.previousDatabase.manifest.migrations);
        Object.freeze(transition.previousDatabase.manifest);
        Object.freeze(transition.previousDatabase.sourceDatabase);
    }
    Object.freeze(transition.previousDatabase);
    return Object.freeze(transition);
}

/**
 * Serializes one validated transition journal canonically with one final newline.
 * @param input Parsed or untrusted transition journal.
 * @returns Canonical JSON transition journal.
 */
export function serializeProductionActivationTransition(input: unknown): string {
    return `${JSON.stringify(parseProductionActivationTransition(input), null, 2)}\n`;
}
