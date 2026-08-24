import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import {
    boundedControlSafeTextSchema,
    compareStrings,
    hasUniqueArrayItems,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import type { ProcedureContract } from "./registry.ts";

/** Exact OpenClaw main-session identity pinned ahead of every other projection. */
export const gatewayPrimarySessionKey = "agent:main:main";

/** Hard budget for current OpenClaw session rows in one Dashboard snapshot. */
export const gatewaySessionProjectionMaximum = 200;

/** Browser projection budgets; upstream adapters may read wider finite values. */
export const gatewaySessionDisplayNameMaximum = 256;
export const gatewaySessionModelMaximum = 160;
export const gatewaySessionProviderMaximum = 80;
export const gatewaySessionChannelMaximum = 80;
export const gatewaySessionPreferenceMaximum = 80;
export const gatewaySessionThinkingLevelLabelMaximum = 160;

/** Optional metadata that an adapter may omit rather than invalidate a full snapshot. */
export const gatewaySessionOmissibleMetadataFields = [
    "channel",
    "elevatedLevel",
    "model",
    "modelProvider",
    "reasoningLevel",
    "thinkingDefault",
    "thinkingLevel",
    "thinkingLevels",
    "thinkingOptions",
    "verboseLevel",
] as const;

export type GatewaySessionOmissibleMetadataField =
    (typeof gatewaySessionOmissibleMetadataFields)[number];

/** Operator-facing filters supported by the bounded current-session projection. */
export const gatewaySessionFilters = ["ALL", "MAIN", "SUBAGENT", "HOOK", "CRON"] as const;

export type GatewaySessionFilter = (typeof gatewaySessionFilters)[number];

export const gatewaySessionFilterSchema = v.picklist(
    gatewaySessionFilters,
    "Gateway session filter is invalid"
);

/** Normalized OpenClaw session kinds exposed through the Dashboard boundary. */
export const gatewaySessionKinds = [
    "main",
    "subagent",
    "hook",
    "cron",
    "unknown",
] as const;

export type GatewaySessionKind = (typeof gatewaySessionKinds)[number];

export const gatewaySessionKindSchema = v.picklist(
    gatewaySessionKinds,
    "Gateway session kind is invalid"
);

/** Explicit current-session controls supported by the Dashboard. */
export const gatewaySessionActions = ["compact", "reset", "delete"] as const;

export type GatewaySessionAction = (typeof gatewaySessionActions)[number];

export const gatewaySessionActionSchema = v.picklist(
    gatewaySessionActions,
    "Gateway session action is invalid"
);

export const gatewaySessionKeySchema = boundedControlSafeTextSchema(
    512,
    "Gateway session key is invalid"
);

const gatewaySessionLabelSchema = boundedControlSafeTextSchema(
    gatewaySessionDisplayNameMaximum,
    "Gateway session label is invalid"
);
const gatewaySessionModelSchema = boundedControlSafeTextSchema(
    gatewaySessionModelMaximum,
    "Gateway session model is invalid"
);
const gatewaySessionProviderSchema = boundedControlSafeTextSchema(
    gatewaySessionProviderMaximum,
    "Gateway session provider is invalid"
);
const gatewaySessionChannelSchema = boundedControlSafeTextSchema(
    gatewaySessionChannelMaximum,
    "Gateway session channel is invalid"
);
const gatewaySessionTokenCountSchema = nonnegativeSafeIntegerSchema(
    "Gateway session token count is invalid"
);
const gatewaySessionContextTokenCountSchema = positiveSafeIntegerSchema(
    "Gateway session context-token count is invalid"
);
const gatewaySessionPreferenceSchema = boundedControlSafeTextSchema(
    gatewaySessionPreferenceMaximum,
    "Gateway session preference is invalid"
);
const gatewaySessionRunIdSchema = boundedControlSafeTextSchema(
    256,
    "Gateway session run id is invalid"
);
const gatewaySessionActiveRunIdsSchema = v.pipe(
    v.array(gatewaySessionRunIdSchema, "Gateway session active run ids are invalid"),
    v.maxLength(32, "Gateway session active run ids are outside their budget")
);
const gatewaySessionThinkingLevelSchema = v.strictObject({
    id: gatewaySessionPreferenceSchema,
    label: boundedControlSafeTextSchema(
        gatewaySessionThinkingLevelLabelMaximum,
        "Gateway session thinking-level label is invalid"
    ),
});
const gatewaySessionThinkingLevelsSchema = v.pipe(
    v.array(
        gatewaySessionThinkingLevelSchema,
        "Gateway session thinking levels are invalid"
    ),
    v.maxLength(32, "Gateway session thinking levels are outside their budget")
);
const gatewaySessionThinkingOptionsSchema = v.pipe(
    v.array(
        gatewaySessionPreferenceSchema,
        "Gateway session thinking options are invalid"
    ),
    v.maxLength(32, "Gateway session thinking options are outside their budget")
);
export const gatewaySessionIdSchema = boundedControlSafeTextSchema(
    256,
    "Gateway session generation id is invalid"
);

/**
 * @param fields Bounded omission markers to validate.
 * @returns Whether omission markers are unique and follow the public field order.
 */
export function gatewaySessionOmittedMetadataFieldsAreCanonical(
    fields: GatewaySessionOmissibleMetadataField[]
): boolean {
    return (
        hasUniqueArrayItems(fields) &&
        fields.every((field, index) => {
            const previous = fields[index - 1];
            return (
                previous === undefined ||
                gatewaySessionOmissibleMetadataFields.indexOf(previous) <
                    gatewaySessionOmissibleMetadataFields.indexOf(field)
            );
        })
    );
}

const gatewaySessionOmittedMetadataFieldsSchema = v.pipe(
    v.array(
        v.picklist(gatewaySessionOmissibleMetadataFields),
        "Gateway session omitted metadata fields are invalid"
    ),
    v.maxLength(
        gatewaySessionOmissibleMetadataFields.length,
        "Gateway session omitted metadata fields are outside their budget"
    ),
    v.check(
        gatewaySessionOmittedMetadataFieldsAreCanonical,
        "Gateway session omitted metadata fields are not canonical"
    )
);

const gatewaySessionObjectSchema = v.strictObject({
    activeRunIds: v.optional(gatewaySessionActiveRunIdsSchema),
    channel: v.optional(gatewaySessionChannelSchema),
    contextTokens: v.optional(gatewaySessionContextTokenCountSchema),
    createdAtMs: v.optional(
        timestampMillisecondsSchema("Gateway session creation timestamp is invalid")
    ),
    displayName: gatewaySessionLabelSchema,
    displayNameTruncated: v.optional(v.literal(true)),
    effectiveFastMode: v.optional(v.union([v.boolean(), v.literal("auto")])),
    elevatedLevel: v.optional(gatewaySessionPreferenceSchema),
    endedAtMs: v.optional(
        timestampMillisecondsSchema("Gateway session end timestamp is invalid")
    ),
    fastMode: v.optional(v.union([v.boolean(), v.literal("auto")])),
    hasActiveRun: v.boolean("Gateway session active-run state is invalid"),
    key: gatewaySessionKeySchema,
    kind: gatewaySessionKindSchema,
    model: v.optional(gatewaySessionModelSchema),
    modelProvider: v.optional(gatewaySessionProviderSchema),
    omittedMetadataFields: v.optional(gatewaySessionOmittedMetadataFieldsSchema),
    reasoningLevel: v.optional(gatewaySessionPreferenceSchema),
    runtimeMs: v.optional(
        nonnegativeSafeIntegerSchema("Gateway session runtime is invalid")
    ),
    sessionId: v.optional(gatewaySessionIdSchema),
    startedAtMs: v.optional(
        timestampMillisecondsSchema("Gateway session start timestamp is invalid")
    ),
    status: v.optional(
        v.picklist(
            ["running", "done", "failed", "killed", "timeout"],
            "Gateway session status is invalid"
        )
    ),
    thinkingDefault: v.optional(gatewaySessionPreferenceSchema),
    thinkingLevel: v.optional(gatewaySessionPreferenceSchema),
    thinkingLevels: v.optional(gatewaySessionThinkingLevelsSchema),
    thinkingOptions: v.optional(gatewaySessionThinkingOptionsSchema),
    totalTokens: v.optional(gatewaySessionTokenCountSchema),
    totalTokensFresh: v.boolean("Gateway session token freshness is invalid"),
    updatedAtMs: v.optional(
        timestampMillisecondsSchema("Gateway session timestamp is invalid")
    ),
    verboseLevel: v.optional(gatewaySessionPreferenceSchema),
});

/** @returns Whether a fresh-token assertion includes the required token count. */
export function gatewaySessionTokenFreshnessIsConsistent(
    session: v.InferOutput<typeof gatewaySessionObjectSchema>
): boolean {
    return !session.totalTokensFresh || session.totalTokens !== undefined;
}

/** @returns Whether lifecycle timestamps and projected active-run identities agree. */
export function gatewaySessionLifecycleIsConsistent(
    session: v.InferOutput<typeof gatewaySessionObjectSchema>
): boolean {
    if (
        session.activeRunIds !== undefined &&
        session.activeRunIds.length > 0 &&
        !session.hasActiveRun
    ) {
        return false;
    }
    if (
        session.startedAtMs !== undefined &&
        session.endedAtMs !== undefined &&
        session.endedAtMs < session.startedAtMs
    ) {
        return false;
    }
    return (
        session.createdAtMs === undefined ||
        session.endedAtMs === undefined ||
        session.endedAtMs >= session.createdAtMs
    );
}

/** One strict, non-secret current OpenClaw session projection. */
export const gatewaySessionSchema = v.pipe(
    gatewaySessionObjectSchema,
    v.check(
        gatewaySessionTokenFreshnessIsConsistent,
        "Gateway session token freshness is inconsistent"
    ),
    v.check(
        gatewaySessionLifecycleIsConsistent,
        "Gateway session lifecycle is inconsistent"
    )
);

export type GatewaySession = v.InferOutput<typeof gatewaySessionSchema>;

const gatewaySessionKindRank: Readonly<Record<GatewaySessionKind, number>> = {
    main: 0,
    subagent: 1,
    hook: 2,
    cron: 3,
    unknown: 4,
};

/**
 * Compares current sessions using primary-main, kind, recency, and stable-key order.
 * @param left First validated session.
 * @param right Second validated session.
 * @returns A negative, zero, or positive stable ordering value.
 */
export function compareGatewaySessions(
    left: GatewaySession,
    right: GatewaySession
): number {
    const leftIsPrimary = left.key === gatewayPrimarySessionKey;
    const rightIsPrimary = right.key === gatewayPrimarySessionKey;
    if (leftIsPrimary !== rightIsPrimary) return leftIsPrimary ? -1 : 1;
    const kindDifference =
        gatewaySessionKindRank[left.kind] - gatewaySessionKindRank[right.kind];
    if (kindDifference !== 0) return kindDifference;
    const recencyDifference = (() => {
        if (left.updatedAtMs === undefined && right.updatedAtMs === undefined) return 0;
        if (left.updatedAtMs === undefined) return 1;
        if (right.updatedAtMs === undefined) return -1;
        return right.updatedAtMs - left.updatedAtMs;
    })();
    if (recencyDifference !== 0) return recencyDifference;
    return compareStrings(left.key, right.key);
}

/**
 * @param sessions Current session rows to inspect.
 * @returns Whether identities are unique and rows use canonical main-first ordering.
 */
export function gatewaySessionPageIsCanonical(sessions: GatewaySession[]): boolean {
    return (
        hasUniqueArrayItems(sessions.map(({ key }) => key)) &&
        sessions.every((session, index) => {
            const previous = sessions[index - 1];
            return (
                previous === undefined || compareGatewaySessions(previous, session) <= 0
            );
        })
    );
}

/** Bounded, unique, main-first current-session rows. */
export const gatewaySessionPageSchema = v.pipe(
    v.array(gatewaySessionSchema, "Gateway session projection is invalid"),
    v.maxLength(
        gatewaySessionProjectionMaximum,
        "Gateway session projection is outside its budget"
    ),
    v.check(gatewaySessionPageIsCanonical, "Gateway session order is invalid")
);

const gatewaySessionKindCountsSchema = v.strictObject({
    cron: nonnegativeSafeIntegerSchema("Gateway cron-session count is invalid"),
    hook: nonnegativeSafeIntegerSchema("Gateway hook-session count is invalid"),
    main: nonnegativeSafeIntegerSchema("Gateway main-session count is invalid"),
    subagent: nonnegativeSafeIntegerSchema("Gateway subagent-session count is invalid"),
    unknown: nonnegativeSafeIntegerSchema("Unknown Gateway session count is invalid"),
});

const gatewaySessionModelCountSchema = v.strictObject({
    count: nonnegativeSafeIntegerSchema("Gateway model session count is invalid"),
    model: gatewaySessionModelSchema,
});

const gatewaySessionModelCountsSchema = v.pipe(
    v.array(gatewaySessionModelCountSchema, "Gateway model counts are invalid"),
    v.maxLength(
        gatewaySessionProjectionMaximum,
        "Gateway model counts are outside their budget"
    )
);

interface FreshGatewaySessionSourceTimes {
    readonly checkedAtMs: number;
    readonly connection: "connected";
    readonly freshness: "fresh";
    readonly observedAtMs: number;
}

interface StaleGatewaySessionSourceTimes {
    readonly checkedAtMs: number;
    readonly connection: "disconnected";
    readonly freshness: "stale";
    readonly observedAtMs: number;
}

/**
 * @param source Fresh source timestamps to compare.
 * @returns Whether a fresh projection was checked at its observation instant.
 */
export function freshGatewaySessionSourceTimesAreConsistent(
    source: FreshGatewaySessionSourceTimes & Record<string, unknown>
): boolean {
    return source.checkedAtMs === source.observedAtMs;
}

/**
 * @param source Stale source timestamps to compare.
 * @returns Whether a stale check occurs at or after its last observation.
 */
export function staleGatewaySessionSourceTimesAreConsistent(
    source: StaleGatewaySessionSourceTimes & Record<string, unknown>
): boolean {
    return source.checkedAtMs >= source.observedAtMs;
}

/** Statistics derived only from the rows in the same bounded snapshot. */
export const gatewaySessionStatsSchema = v.strictObject({
    activeInLastHour: nonnegativeSafeIntegerSchema(
        "Recently active Gateway session count is invalid"
    ),
    byKind: gatewaySessionKindCountsSchema,
    byModel: gatewaySessionModelCountsSchema,
    shown: nonnegativeSafeIntegerSchema("Shown Gateway session count is invalid"),
    tokenTotalState: v.picklist(["complete", "overflow", "partial"]),
    totalTokens: v.optional(gatewaySessionTokenCountSchema),
    unknownModelCount: nonnegativeSafeIntegerSchema(
        "Unknown Gateway model count is invalid"
    ),
});

export type GatewaySessionStats = v.InferOutput<typeof gatewaySessionStatsSchema>;

/**
 * @param sessions Bounded current-session rows.
 * @param observedAtMs Observation instant used for activity counts.
 * @returns Same-snapshot inventory statistics without unsafe integer overflow.
 */
export function deriveGatewaySessionStats(
    sessions: readonly GatewaySession[],
    observedAtMs: number
): GatewaySessionStats {
    const activeThresholdMs = Math.max(0, observedAtMs - 60 * 60 * 1000);
    const byKind = { cron: 0, hook: 0, main: 0, subagent: 0, unknown: 0 };
    const modelCounts = new Map<string, number>();
    let activeInLastHour = 0;
    let knownTokenTotal = 0;
    let missingTokenCount = 0;
    let tokenOverflow = false;
    let unknownModelCount = 0;
    for (const session of sessions) {
        byKind[session.kind] += 1;
        if (
            session.updatedAtMs !== undefined &&
            session.updatedAtMs >= activeThresholdMs
        ) {
            activeInLastHour += 1;
        }
        if (session.model === undefined) unknownModelCount += 1;
        else modelCounts.set(session.model, (modelCounts.get(session.model) ?? 0) + 1);
        if (session.totalTokens === undefined) missingTokenCount += 1;
        else if (knownTokenTotal > Number.MAX_SAFE_INTEGER - session.totalTokens) {
            tokenOverflow = true;
        } else {
            knownTokenTotal += session.totalTokens;
        }
    }
    let tokenTotalState: GatewaySessionStats["tokenTotalState"];
    if (tokenOverflow) tokenTotalState = "overflow";
    else if (missingTokenCount === 0) tokenTotalState = "complete";
    else tokenTotalState = "partial";
    return {
        activeInLastHour,
        byKind,
        byModel: [...modelCounts]
            .toSorted(([left], [right]) => compareStrings(left, right))
            .map(([model, count]) => ({ count, model })),
        shown: sessions.length,
        tokenTotalState,
        ...(tokenOverflow ? {} : { totalTokens: knownTokenTotal }),
        unknownModelCount,
    };
}

const freshGatewaySessionSourceSchema = v.pipe(
    v.strictObject({
        checkedAtMs: timestampMillisecondsSchema(
            "Gateway session check timestamp is invalid"
        ),
        connection: v.literal("connected"),
        freshness: v.literal("fresh"),
        observedAtMs: timestampMillisecondsSchema(
            "Gateway session observation timestamp is invalid"
        ),
    }),
    v.check(
        freshGatewaySessionSourceTimesAreConsistent,
        "Fresh Gateway session timestamps are inconsistent"
    )
);

const staleGatewaySessionSourceSchema = v.pipe(
    v.strictObject({
        checkedAtMs: timestampMillisecondsSchema(
            "Gateway session check timestamp is invalid"
        ),
        connection: v.literal("disconnected"),
        freshness: v.literal("stale"),
        observedAtMs: timestampMillisecondsSchema(
            "Gateway session observation timestamp is invalid"
        ),
    }),
    v.check(
        staleGatewaySessionSourceTimesAreConsistent,
        "Stale Gateway session timestamps are inconsistent"
    )
);

/** Explicit source connection and freshness for one current-session snapshot. */
export const gatewaySessionSourceSchema = v.variant("freshness", [
    freshGatewaySessionSourceSchema,
    staleGatewaySessionSourceSchema,
]);

/** One server-owned filter request over the bounded current projection. */
export const listGatewaySessionsInputSchema = v.strictObject({
    filter: v.optional(gatewaySessionFilterSchema, "ALL"),
});

export type ListGatewaySessionsInput = v.InferOutput<
    typeof listGatewaySessionsInputSchema
>;

const listGatewaySessionsResultObjectSchema = v.strictObject({
    filter: gatewaySessionFilterSchema,
    projectionTruncated: v.boolean("Gateway session truncation state is invalid"),
    sessions: gatewaySessionPageSchema,
    source: gatewaySessionSourceSchema,
    stats: gatewaySessionStatsSchema,
});

type ListGatewaySessionsResultValue = v.InferOutput<
    typeof listGatewaySessionsResultObjectSchema
>;

function filterMatchesSession(
    filter: GatewaySessionFilter,
    session: GatewaySession
): boolean {
    return filter === "ALL" || session.kind === filter.toLowerCase();
}

/**
 * @param snapshot Validated current-session snapshot to inspect.
 * @returns Whether its filter, rows, and same-snapshot statistics agree.
 */
export function gatewaySessionSnapshotIsConsistent(
    snapshot: ListGatewaySessionsResultValue
): boolean {
    for (const session of snapshot.sessions) {
        if (!filterMatchesSession(snapshot.filter, session)) return false;
    }
    const expected = deriveGatewaySessionStats(
        snapshot.sessions,
        snapshot.source.observedAtMs
    );
    return (
        snapshot.stats.shown === expected.shown &&
        snapshot.stats.activeInLastHour === expected.activeInLastHour &&
        snapshot.stats.unknownModelCount === expected.unknownModelCount &&
        snapshot.stats.tokenTotalState === expected.tokenTotalState &&
        snapshot.stats.totalTokens === expected.totalTokens &&
        gatewaySessionKinds.every(
            (kind) => snapshot.stats.byKind[kind] === expected.byKind[kind]
        ) &&
        snapshot.stats.byModel.length === expected.byModel.length &&
        snapshot.stats.byModel.every(
            (entry, index) =>
                entry.model === expected.byModel[index]?.model &&
                entry.count === expected.byModel[index]?.count
        )
    );
}

/** Bounded current sessions and statistics from the same observed projection. */
export const listGatewaySessionsResultSchema = v.pipe(
    listGatewaySessionsResultObjectSchema,
    v.check(
        gatewaySessionSnapshotIsConsistent,
        "Gateway session snapshot is inconsistent"
    )
);

export type ListGatewaySessionsResult = v.InferOutput<
    typeof listGatewaySessionsResultSchema
>;

/** Exact identity accepted by compact, reset, and transcript-delete controls. */
export const gatewaySessionActionInputSchema = v.strictObject({
    key: gatewaySessionKeySchema,
});

export type GatewaySessionActionInput = v.InferOutput<
    typeof gatewaySessionActionInputSchema
>;

/** Generation-fenced identity required before deleting an upstream transcript. */
export const gatewaySessionDeleteInputSchema = v.strictObject({
    expectedSessionId: gatewaySessionIdSchema,
    expectedUpdatedAtMs: v.optional(
        timestampMillisecondsSchema("Expected Gateway session timestamp is invalid")
    ),
    key: gatewaySessionKeySchema,
});

export type GatewaySessionDeleteInput = v.InferOutput<
    typeof gatewaySessionDeleteInputSchema
>;

const availableGatewaySessionRefreshSchema = v.strictObject({
    snapshot: listGatewaySessionsResultSchema,
    status: v.literal("available"),
});

const unavailableGatewaySessionRefreshSchema = v.strictObject({
    status: v.literal("unavailable"),
});

/** Refresh state after one upstream-confirmed session control. */
export const gatewaySessionActionRefreshSchema = v.variant("status", [
    availableGatewaySessionRefreshSchema,
    unavailableGatewaySessionRefreshSchema,
]);

const gatewaySessionActionResultObjectSchema = v.strictObject({
    action: gatewaySessionActionSchema,
    key: gatewaySessionKeySchema,
    outcome: v.picklist(["changed", "unchanged"]),
    refresh: gatewaySessionActionRefreshSchema,
});

type GatewaySessionActionResultValue = v.InferOutput<
    typeof gatewaySessionActionResultObjectSchema
>;

/**
 * @param result Confirmed action response to inspect.
 * @returns Whether any returned snapshot is the complete ALL-filter projection.
 */
export function gatewaySessionActionResultIsConsistent(
    result: GatewaySessionActionResultValue
): boolean {
    return (
        (result.outcome !== "unchanged" || result.action === "compact") &&
        (result.refresh.status !== "available" ||
            result.refresh.snapshot.filter === "ALL")
    );
}

/** Confirmed upstream action plus a best-effort post-action projection refresh. */
export const gatewaySessionActionResultSchema = v.pipe(
    gatewaySessionActionResultObjectSchema,
    v.check(
        gatewaySessionActionResultIsConsistent,
        "Gateway session action result is inconsistent"
    )
);

export type GatewaySessionActionResult = v.InferOutput<
    typeof gatewaySessionActionResultSchema
>;

const gatewaySessionReadAccess = {
    capabilities: ["gateway-sessions:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;

const gatewaySessionControlAccess = {
    capabilities: ["gateway-sessions:write"],
    kind: "recent-auth",
    principalKinds: ["session"],
    whenMfaDisabled: "deny",
    whenMfaEnabled: "mfa",
} as const;

const gatewaySessionQueryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;

const gatewaySessionMutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;

const gatewaySessionControlErrors = [
    "CONFLICT",
    "FORBIDDEN",
    "NOT_FOUND",
    "SERVICE_UNAVAILABLE",
    "UNAUTHORIZED",
] as const;

const gatewaySessionControlErrorReasons = [
    "mfa_enrollment_required",
    "operation_outcome_unknown",
    "step_up_required",
] as const;

/** Implemented session-only current OpenClaw session procedure metadata. */
export const gatewaySessionProcedureContracts = [
    {
        access: gatewaySessionReadAccess,
        domain: "gateway-sessions",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: listGatewaySessionsInputSchema,
        inputSchemaId: "gatewaySessions.list.input",
        kind: "query",
        name: "gatewaySessions.list",
        output: listGatewaySessionsResultSchema,
        outputSchemaId: "gatewaySessions.list.output",
        summary:
            "Returns one bounded current OpenClaw session projection with same-snapshot statistics.",
        transport: gatewaySessionQueryTransport,
    },
    {
        access: gatewaySessionControlAccess,
        domain: "gateway-sessions",
        errorReasons: gatewaySessionControlErrorReasons,
        errors: gatewaySessionControlErrors,
        input: gatewaySessionActionInputSchema,
        inputSchemaId: "gatewaySessions.compact.input",
        kind: "mutation",
        name: "gatewaySessions.compact",
        output: gatewaySessionActionResultSchema,
        outputSchemaId: "gatewaySessions.compact.output",
        summary: "Compacts one current OpenClaw session after recent MFA.",
        transport: gatewaySessionMutationTransport,
    },
    {
        access: gatewaySessionControlAccess,
        domain: "gateway-sessions",
        errorReasons: gatewaySessionControlErrorReasons,
        errors: gatewaySessionControlErrors,
        input: gatewaySessionActionInputSchema,
        inputSchemaId: "gatewaySessions.reset.input",
        kind: "mutation",
        name: "gatewaySessions.reset",
        output: gatewaySessionActionResultSchema,
        outputSchemaId: "gatewaySessions.reset.output",
        summary: "Resets one current OpenClaw session after recent MFA.",
        transport: gatewaySessionMutationTransport,
    },
    {
        access: gatewaySessionControlAccess,
        domain: "gateway-sessions",
        errorReasons: gatewaySessionControlErrorReasons,
        errors: gatewaySessionControlErrors,
        input: gatewaySessionDeleteInputSchema,
        inputSchemaId: "gatewaySessions.delete.input",
        kind: "mutation",
        name: "gatewaySessions.delete",
        output: gatewaySessionActionResultSchema,
        outputSchemaId: "gatewaySessions.delete.output",
        summary:
            "Deletes one current OpenClaw session and its transcript after recent MFA.",
        transport: gatewaySessionMutationTransport,
    },
] as const satisfies readonly ProcedureContract[];
