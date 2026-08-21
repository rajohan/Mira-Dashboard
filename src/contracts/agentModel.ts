import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import {
    boundedControlSafeTextSchema,
    compareStrings,
    hasUniqueArrayItems,
    lowercaseUuidV7Schema,
} from "../shared/validation.ts";

/** Maximum configured agents exposed by one Dashboard process. */
export const dashboardAgentMaximum = 16;

/** Maximum Unicode code points retained for one current-task description. */
export const agentCurrentTaskMaximumLength = 512;

/** Maximum Unicode code points retained for one provider/model display value. */
export const agentGatewayProviderModelMaximumLength = 241;

/** Stable Dashboard-owned agent identifier. */
export const agentIdSchema = v.pipe(
    v.string("Agent id is invalid"),
    v.minLength(1, "Agent id is invalid"),
    v.maxLength(64, "Agent id is invalid"),
    v.regex(/^[a-z0-9][a-z0-9._-]*$/u, "Agent id is invalid")
);

/** Display label from reviewed application configuration. */
export const agentDisplayNameSchema = boundedControlSafeTextSchema(
    64,
    "Agent display name is invalid"
);

/** Short operator-facing purpose from reviewed application configuration. */
export const agentDescriptionSchema = boundedControlSafeTextSchema(
    256,
    "Agent description is invalid"
);

/** Current task text supplied by the scoped task-tracking caller. */
export const agentCurrentTaskSchema = boundedControlSafeTextSchema(
    agentCurrentTaskMaximumLength,
    "Agent current task is invalid"
);

/** Stable UUIDv7 identity for one durable agent task run. */
export const agentTaskRunIdSchema = lowercaseUuidV7Schema("Agent task run id is invalid");

export const agentRoles = ["primary", "specialist"] as const;
export const agentRoleSchema = v.picklist(agentRoles, "Agent role is invalid");

/** One reviewed Dashboard agent definition, independent of Gateway state. */
export const agentDefinitionSchema = v.strictObject({
    description: agentDescriptionSchema,
    displayName: agentDisplayNameSchema,
    id: agentIdSchema,
    role: agentRoleSchema,
});

export type AgentDefinition = v.InferOutput<typeof agentDefinitionSchema>;

/**
 * Returns whether a reviewed directory contains each agent ID exactly once.
 * @param definitions Agent definitions to inspect.
 * @returns Whether every agent ID is unique.
 */
export function agentDefinitionsHaveUniqueIds(definitions: AgentDefinition[]): boolean {
    return hasUniqueArrayItems(definitions.map(({ id }) => id));
}

/**
 * Sorts and freezes a reviewed agent directory into its transport form.
 * @param definitions Agent definitions to canonicalize.
 * @returns Canonically ordered immutable agent definitions.
 */
export function canonicalAgentDefinitions(
    definitions: AgentDefinition[]
): readonly AgentDefinition[] {
    const sorted = definitions.toSorted((left, right) =>
        compareStrings(left.id, right.id)
    );
    return Object.freeze(sorted.map((definition) => Object.freeze(definition)));
}

const agentDefinitionListSchema = v.pipe(
    v.array(agentDefinitionSchema, "Agent configuration is invalid"),
    v.minLength(1, "Agent configuration cannot be empty"),
    v.maxLength(dashboardAgentMaximum, "Agent configuration is outside its budget"),
    v.check(agentDefinitionsHaveUniqueIds, "Agent configuration ids must be unique"),
    v.transform(canonicalAgentDefinitions)
);

/** Complete reviewed agent directory returned to authenticated clients. */
export const agentConfigurationSchema = v.strictObject({
    agents: agentDefinitionListSchema,
});

/** Shared timestamp policy for agent status, task history, and cursors. */
export const agentTimestampSchema = timestampMillisecondsSchema(
    "Agent timestamp is invalid"
);

const idleAgentStatusSchema = v.strictObject({
    agentId: agentIdSchema,
    lastActivityAtMs: v.optional(agentTimestampSchema),
    state: v.literal("idle"),
});

const workingAgentStatusSchema = v.strictObject({
    agentId: agentIdSchema,
    currentTask: agentCurrentTaskSchema,
    lastActivityAtMs: agentTimestampSchema,
    startedAtMs: agentTimestampSchema,
    state: v.literal("working"),
});

/**
 * Returns whether a working status has monotonic task timestamps.
 * @param status Working status to inspect.
 * @returns Whether task activity is not earlier than task start.
 */
export function workingStatusTimeIsConsistent(
    status: v.InferOutput<typeof workingAgentStatusSchema>
): boolean {
    return status.lastActivityAtMs >= status.startedAtMs;
}

/** Dashboard-owned current task projection for one configured agent. */
export const agentStatusSchema = v.variant("state", [
    idleAgentStatusSchema,
    v.pipe(
        workingAgentStatusSchema,
        v.check(workingStatusTimeIsConsistent, "Agent status timestamps are inconsistent")
    ),
]);

export const agentGatewayAvailabilities = [
    "active",
    "idle",
    "disconnected",
    "stale",
    "unknown",
] as const;

export const agentGatewayAvailabilitySchema = v.picklist(
    agentGatewayAvailabilities,
    "Agent Gateway availability is invalid"
);

export const agentGatewayFreshnessStates = ["fresh", "stale", "unavailable"] as const;

export const agentGatewayFreshnessSchema = v.picklist(
    agentGatewayFreshnessStates,
    "Agent Gateway freshness is invalid"
);

const agentGatewaySessionKeySchema = boundedControlSafeTextSchema(
    512,
    "Agent Gateway session key is invalid"
);

const agentGatewayProviderModelSchema = boundedControlSafeTextSchema(
    agentGatewayProviderModelMaximumLength,
    "Agent Gateway provider model is invalid"
);

const agentStatusProjectionObjectSchema = v.strictObject({
    agentId: agentIdSchema,
    currentTask: v.optional(agentCurrentTaskSchema),
    freshness: agentGatewayFreshnessSchema,
    gatewayAvailability: agentGatewayAvailabilitySchema,
    hasActiveRun: v.optional(v.boolean("Agent Gateway active-run state is invalid")),
    lastActivityAtMs: v.optional(agentTimestampSchema),
    lastSeenAtMs: v.optional(agentTimestampSchema),
    observedAtMs: v.optional(agentTimestampSchema),
    providerModel: v.optional(agentGatewayProviderModelSchema),
    sessionKey: v.optional(agentGatewaySessionKeySchema),
    startedAtMs: v.optional(agentTimestampSchema),
    state: v.picklist(["idle", "working"], "Agent state is invalid"),
});

type AgentStatusProjectionValue = v.InferOutput<typeof agentStatusProjectionObjectSchema>;

/**
 * Returns whether Dashboard task state and Gateway availability remain separate,
 * internally complete projections.
 * @param status Combined read projection to inspect.
 * @returns Whether fields required by each independent state are consistent.
 */
export function agentStatusProjectionIsConsistent(
    status: AgentStatusProjectionValue
): boolean {
    const dashboardStateIsConsistent =
        status.state === "working"
            ? status.currentTask !== undefined &&
              status.lastActivityAtMs !== undefined &&
              status.startedAtMs !== undefined &&
              status.lastActivityAtMs >= status.startedAtMs
            : status.currentTask === undefined && status.startedAtMs === undefined;
    if (!dashboardStateIsConsistent) return false;

    const hasSessionMetadata =
        status.sessionKey !== undefined ||
        status.providerModel !== undefined ||
        status.hasActiveRun !== undefined ||
        status.lastSeenAtMs !== undefined;
    switch (status.gatewayAvailability) {
        case "active": {
            return (
                status.freshness === "fresh" &&
                status.observedAtMs !== undefined &&
                status.sessionKey !== undefined &&
                status.hasActiveRun === true
            );
        }
        case "idle": {
            return (
                status.freshness === "fresh" &&
                status.observedAtMs !== undefined &&
                status.sessionKey !== undefined &&
                status.hasActiveRun === false
            );
        }
        case "stale": {
            return (
                status.freshness === "stale" &&
                status.observedAtMs !== undefined &&
                status.sessionKey !== undefined &&
                status.hasActiveRun !== undefined
            );
        }
        case "unknown": {
            return (
                (status.freshness === "fresh" || status.freshness === "stale") &&
                status.observedAtMs !== undefined &&
                !hasSessionMetadata
            );
        }
        case "disconnected": {
            return (
                !hasSessionMetadata &&
                ((status.freshness === "stale" && status.observedAtMs !== undefined) ||
                    (status.freshness === "unavailable" &&
                        status.observedAtMs === undefined))
            );
        }
    }
}

/** Dashboard task state plus a separate, non-authoritative Gateway session overlay. */
export const agentStatusProjectionSchema = v.pipe(
    agentStatusProjectionObjectSchema,
    v.check(agentStatusProjectionIsConsistent, "Agent status projection is inconsistent")
);

const activeAgentTaskRunSchema = v.strictObject({
    agentId: agentIdSchema,
    id: agentTaskRunIdSchema,
    lastActivityAtMs: agentTimestampSchema,
    startedAtMs: agentTimestampSchema,
    status: v.literal("active"),
    task: agentCurrentTaskSchema,
});

const completedAgentTaskRunSchema = v.strictObject({
    agentId: agentIdSchema,
    completedAtMs: agentTimestampSchema,
    id: agentTaskRunIdSchema,
    lastActivityAtMs: agentTimestampSchema,
    startedAtMs: agentTimestampSchema,
    status: v.literal("completed"),
    task: agentCurrentTaskSchema,
});

type ActiveAgentTaskRun = v.InferOutput<typeof activeAgentTaskRunSchema>;
type CompletedAgentTaskRun = v.InferOutput<typeof completedAgentTaskRunSchema>;

/**
 * Returns whether an active task run has monotonic timestamps.
 * @param run Active task run to inspect.
 * @returns Whether task activity is not earlier than task start.
 */
export function activeRunTimeIsConsistent(run: ActiveAgentTaskRun): boolean {
    return run.lastActivityAtMs >= run.startedAtMs;
}

/**
 * Returns whether a completed task run has monotonic timestamps.
 * @param run Completed task run to inspect.
 * @returns Whether start, activity, and completion are monotonically ordered.
 */
export function completedRunTimeIsConsistent(run: CompletedAgentTaskRun): boolean {
    return (
        run.lastActivityAtMs >= run.startedAtMs &&
        run.completedAtMs >= run.lastActivityAtMs
    );
}

/** One active or completed current-task interval retained for history. */
export const agentTaskRunSchema = v.variant("status", [
    v.pipe(
        activeAgentTaskRunSchema,
        v.check(activeRunTimeIsConsistent, "Agent task run timestamps are inconsistent")
    ),
    v.pipe(
        completedAgentTaskRunSchema,
        v.check(
            completedRunTimeIsConsistent,
            "Agent task run timestamps are inconsistent"
        )
    ),
]);

export type AgentConfiguration = v.InferOutput<typeof agentConfigurationSchema>;
export type AgentGatewayAvailability = v.InferOutput<
    typeof agentGatewayAvailabilitySchema
>;
export type AgentGatewayFreshness = v.InferOutput<typeof agentGatewayFreshnessSchema>;
export type AgentStatus = v.InferOutput<typeof agentStatusSchema>;
export type AgentStatusProjection = v.InferOutput<typeof agentStatusProjectionSchema>;
export type WorkingAgentStatusProjection = AgentStatusProjection & {
    readonly currentTask: string;
    readonly lastActivityAtMs: number;
    readonly startedAtMs: number;
    readonly state: "working";
};
export type AgentTaskRun = v.InferOutput<typeof agentTaskRunSchema>;

/** @returns Whether one validated read projection contains a working Dashboard task. */
export function isWorkingAgentStatusProjection(
    status: AgentStatusProjection
): status is WorkingAgentStatusProjection {
    return (
        status.state === "working" &&
        status.currentTask !== undefined &&
        status.lastActivityAtMs !== undefined &&
        status.startedAtMs !== undefined
    );
}
