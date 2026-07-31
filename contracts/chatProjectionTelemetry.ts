import * as v from "valibot";

import {
    nonNegativeIntegerSchema,
    parseContract,
    strictJsonObjectSchema,
    successLiteralSchema,
} from "./runtime";

export const CHAT_PROJECTION_SHADOW_SCHEMA_VERSION = 1;
export const CHAT_PROJECTION_SHADOW_DIFFERENCES = [
    "active-runs",
    "canonical-error",
    "compaction-status",
    "rows",
] as const;
export const CHAT_PROJECTION_COMPACTION_PHASES = ["none", "active", "complete"] as const;

const boundedProjectionCountSchema = v.pipe(
    nonNegativeIntegerSchema,
    v.maxValue(1_000_000)
);
const chatProjectionShadowDifferenceSchema = v.picklist(
    CHAT_PROJECTION_SHADOW_DIFFERENCES
);
const chatProjectionCompactionPhaseSchema = v.picklist(CHAT_PROJECTION_COMPACTION_PHASES);

export const chatProjectionShadowObservationSchema = v.pipe(
    strictJsonObjectSchema({
        canonicalActiveRunCount: v.optional(boundedProjectionCountSchema),
        canonicalCompactionPhase: v.optional(chatProjectionCompactionPhaseSchema),
        canonicalRowCount: v.optional(boundedProjectionCountSchema),
        differenceKinds: v.pipe(
            v.array(chatProjectionShadowDifferenceSchema),
            v.maxLength(CHAT_PROJECTION_SHADOW_DIFFERENCES.length)
        ),
        legacyActiveRunCount: boundedProjectionCountSchema,
        legacyCompactionPhase: chatProjectionCompactionPhaseSchema,
        legacyRowCount: boundedProjectionCountSchema,
        matches: v.boolean(),
        schemaVersion: v.literal(CHAT_PROJECTION_SHADOW_SCHEMA_VERSION),
        turnCount: v.optional(boundedProjectionCountSchema),
    }),
    v.check(
        (observation) =>
            new Set(observation.differenceKinds).size ===
            observation.differenceKinds.length,
        "difference kinds must be unique"
    ),
    v.check(
        (observation) =>
            observation.matches === (observation.differenceKinds.length === 0),
        "match state must agree with difference kinds"
    ),
    v.check((observation) => {
        const hasCanonicalError = observation.differenceKinds.includes("canonical-error");
        const hasCanonicalProjection =
            observation.canonicalActiveRunCount !== undefined &&
            observation.canonicalCompactionPhase !== undefined &&
            observation.canonicalRowCount !== undefined &&
            observation.turnCount !== undefined;
        if (hasCanonicalError) {
            return (
                observation.differenceKinds.length === 1 &&
                observation.canonicalActiveRunCount === undefined &&
                observation.canonicalCompactionPhase === undefined &&
                observation.canonicalRowCount === undefined &&
                observation.turnCount === undefined
            );
        }
        return hasCanonicalProjection;
    }, "canonical projection fields must agree with canonical error state")
);

export const chatProjectionShadowObservationResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
});

export type ChatProjectionShadowDifference =
    (typeof CHAT_PROJECTION_SHADOW_DIFFERENCES)[number];
export type ChatProjectionCompactionPhase =
    (typeof CHAT_PROJECTION_COMPACTION_PHASES)[number];
export type ChatProjectionShadowObservation = v.InferOutput<
    typeof chatProjectionShadowObservationSchema
>;
export type ChatProjectionShadowObservationResponse = v.InferOutput<
    typeof chatProjectionShadowObservationResponseSchema
>;

/**
 * Parses one content-free projection parity observation at the HTTP boundary.
 * @param value Value to process.
 * @returns Validated projection parity observation.
 */
export function parseChatProjectionShadowObservation(
    value: unknown
): ChatProjectionShadowObservation {
    return parseContract(chatProjectionShadowObservationSchema, value, "body");
}

/**
 * Parses the projection observation acknowledgement at the browser boundary.
 * @param value Value to process.
 * @returns Validated acknowledgement.
 */
export function parseChatProjectionShadowObservationResponse(
    value: unknown
): ChatProjectionShadowObservationResponse {
    return parseContract(
        chatProjectionShadowObservationResponseSchema,
        value,
        "response"
    );
}
