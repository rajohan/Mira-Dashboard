import * as v from "valibot";

import {
    boundedControlSafeTextSchema,
    boundedNonBlankTextSchema,
    compareStrings,
    hasUniqueArrayItems,
    lowercaseSha256Schema,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import { agentIdSchema } from "./agentModel.ts";
import type { ProcedureContract } from "./registry.ts";

/** Maximum authenticated raw Gateway response accepted for config.get. */
export const openClawConfigurationUpstreamMaximumBytes = 2 * 1024 * 1024;
/** Maximum authenticated raw Gateway response accepted for skills.status. */
export const openClawSkillsUpstreamMaximumBytes = 1024 * 1024;
/** Maximum skill rows retained after immediate path-free projection. */
export const openClawSkillMaximum = 512;
export const openClawModelFallbackMaximum = 16;
export const openClawChannelMaximum = 64;
export const openClawAgentAccessMaximum = 32;

export const openClawConfigHashSchema = lowercaseSha256Schema(
    "OpenClaw configuration hash is invalid"
);

const optionalConfigurationTextSchema = (maximum: number, message: string) =>
    v.optional(boundedControlSafeTextSchema(maximum, message));

export const openClawModelIdSchema = boundedControlSafeTextSchema(
    200,
    "OpenClaw model id is invalid"
);

const openClawModelSettingsSchema = v.strictObject({
    fallbacks: v.pipe(
        v.array(openClawModelIdSchema, "OpenClaw model fallbacks are invalid"),
        v.maxLength(
            openClawModelFallbackMaximum,
            "OpenClaw model fallbacks are outside their budget"
        ),
        v.check(hasUniqueArrayItems, "OpenClaw model fallbacks must be unique")
    ),
    primary: v.optional(openClawModelIdSchema),
});

const openClawSessionResetSettingsSchema = v.strictObject({
    idleMinutes: v.optional(
        v.pipe(
            positiveSafeIntegerSchema("OpenClaw session reset is invalid"),
            v.maxValue(10_080, "OpenClaw session reset is outside its budget")
        )
    ),
});

const openClawHeartbeatSettingsSchema = v.strictObject({
    everySeconds: v.optional(
        v.pipe(
            positiveSafeIntegerSchema("OpenClaw heartbeat interval is invalid"),
            v.minValue(10, "OpenClaw heartbeat interval is outside its budget"),
            v.maxValue(86_400, "OpenClaw heartbeat interval is outside its budget")
        )
    ),
    target: optionalConfigurationTextSchema(128, "OpenClaw heartbeat target is invalid"),
});

const openClawToolSettingsSchema = v.strictObject({
    agentToAgentEnabled: v.boolean("OpenClaw agent-to-agent setting is invalid"),
    elevatedEnabled: v.boolean("OpenClaw elevated-tool setting is invalid"),
    execAsk: v.picklist(
        ["off", "on-miss", "always"],
        "OpenClaw exec approval setting is invalid"
    ),
    execSecurity: v.picklist(
        ["allowlist", "deny", "full"],
        "OpenClaw exec security setting is invalid"
    ),
    profile: optionalConfigurationTextSchema(64, "OpenClaw tool profile is invalid"),
    sessionsVisibility: v.optional(
        v.picklist(
            ["agent", "all", "self", "tree"],
            "OpenClaw session visibility setting is invalid"
        )
    ),
    webFetchEnabled: v.boolean("OpenClaw web-fetch setting is invalid"),
    webSearchEnabled: v.boolean("OpenClaw web-search setting is invalid"),
    webSearchProvider: optionalConfigurationTextSchema(
        64,
        "OpenClaw web-search provider is invalid"
    ),
});

export const openClawChannelIdSchema = v.pipe(
    boundedControlSafeTextSchema(64, "OpenClaw channel id is invalid"),
    v.regex(/^[a-z0-9][a-z0-9._-]*$/u, "OpenClaw channel id is invalid")
);

const openClawChannelSettingsSchema = v.strictObject({
    enabled: v.boolean("OpenClaw channel enabled state is invalid"),
    id: openClawChannelIdSchema,
});

type OpenClawChannelSettings = v.InferOutput<typeof openClawChannelSettingsSchema>;

export function openClawChannelsHaveStableUniqueOrder(
    channels: OpenClawChannelSettings[]
): boolean {
    if (!hasUniqueArrayItems(channels.map(({ id }) => id))) return false;
    return channels.every(
        (channel, index) =>
            index === 0 || compareStrings(channels[index - 1]?.id ?? "", channel.id) < 0
    );
}

const openClawChannelsSchema = v.pipe(
    v.array(openClawChannelSettingsSchema, "OpenClaw channels are invalid"),
    v.maxLength(openClawChannelMaximum, "OpenClaw channels are outside their budget"),
    v.check(
        openClawChannelsHaveStableUniqueOrder,
        "OpenClaw channels must be unique and ordered"
    )
);

const openClawSecuritySummarySchema = v.strictObject({
    authProfileCount: nonnegativeSafeIntegerSchema(
        "OpenClaw authentication profile count is invalid"
    ),
    commandRestartEnabled: v.boolean("OpenClaw command restart setting is invalid"),
    ownerAllowFromCount: nonnegativeSafeIntegerSchema(
        "OpenClaw owner allowlist count is invalid"
    ),
    redactionMode: optionalConfigurationTextSchema(
        64,
        "OpenClaw redaction mode is invalid"
    ),
});

/**
 * Exact pinned core-tool subset retained from the legacy Agent access surface.
 * Deprecated aliases and runtime/plugin-discovered tools never cross this contract.
 */
export const openClawReviewedAgentToolIds = [
    "automations",
    "browser",
    "edit",
    "exec",
    "gateway",
    "image",
    "image_generate",
    "memory_search",
    "message",
    "music_generate",
    "nodes",
    "read",
    "sessions_history",
    "sessions_list",
    "tts",
    "video_generate",
    "web_fetch",
    "web_search",
    "write",
] as const;

export const openClawReviewedAgentToolIdSchema = v.picklist(
    openClawReviewedAgentToolIds,
    "OpenClaw reviewed agent tool id is invalid"
);

export const openClawAgentToolOverrides = ["allow", "deny", "inherit"] as const;
export const openClawAgentToolOverrideSchema = v.picklist(
    openClawAgentToolOverrides,
    "OpenClaw agent tool override is invalid"
);

export interface OpenClawAgentToolAccessValue {
    readonly editable: boolean;
    readonly id: (typeof openClawReviewedAgentToolIds)[number];
    readonly override: (typeof openClawAgentToolOverrides)[number];
}

export function openClawAgentToolsAreCompleteAndOrdered(
    tools: OpenClawAgentToolAccessValue[]
): boolean {
    return (
        tools.length === openClawReviewedAgentToolIds.length &&
        tools.every(({ id }, index) => id === openClawReviewedAgentToolIds[index])
    );
}

const openClawAgentToolsSchema = v.pipe(
    v.array(
        v.strictObject({
            editable: v.boolean("OpenClaw agent tool editability is invalid"),
            id: openClawReviewedAgentToolIdSchema,
            override: openClawAgentToolOverrideSchema,
        }),
        "OpenClaw agent tools are invalid"
    ),
    v.check(
        openClawAgentToolsAreCompleteAndOrdered,
        "OpenClaw agent tools must be complete and ordered"
    )
);

export interface OpenClawAgentAccessValue {
    readonly id: string;
    readonly name?: string;
    readonly tools: OpenClawAgentToolAccessValue[];
}

export const openClawAgentIdSchema = v.pipe(
    agentIdSchema,
    v.regex(
        /^(?!(?:__proto__|constructor|prototype)$)[a-z0-9_][a-z0-9_-]{0,63}$/u,
        "OpenClaw agent id is invalid"
    )
);

const openClawAgentAccessSchema = v.strictObject({
    id: openClawAgentIdSchema,
    name: optionalConfigurationTextSchema(64, "OpenClaw agent name is invalid"),
    tools: openClawAgentToolsSchema,
});

export function openClawAgentAccessHasStableUniqueOrder(
    agents: OpenClawAgentAccessValue[]
): boolean {
    if (!hasUniqueArrayItems(agents.map(({ id }) => id))) return false;
    return agents.every(
        (agent, index) =>
            index === 0 || compareStrings(agents[index - 1]?.id ?? "", agent.id) < 0
    );
}

export const openClawAgentAccessListSchema = v.pipe(
    v.array(openClawAgentAccessSchema, "OpenClaw agent access is invalid"),
    v.maxLength(
        openClawAgentAccessMaximum,
        "OpenClaw agent access is outside its budget"
    ),
    v.check(
        openClawAgentAccessHasStableUniqueOrder,
        "OpenClaw agent access must be unique and ordered"
    )
);

export const getOpenClawConfigurationInputSchema = v.strictObject({});

/** Strict, secret-free projection of only code-owned Settings UI fields. */
export const openClawConfigurationSnapshotSchema = v.strictObject({
    agentAccess: openClawAgentAccessListSchema,
    agentAccessTruncated: v.boolean("OpenClaw agent access truncation state is invalid"),
    channels: openClawChannelsSchema,
    hash: openClawConfigHashSchema,
    heartbeat: openClawHeartbeatSettingsSchema,
    issueCount: nonnegativeSafeIntegerSchema(
        "OpenClaw configuration issue count is invalid"
    ),
    lastTouchedAt: optionalConfigurationTextSchema(
        64,
        "OpenClaw last-touched timestamp is invalid"
    ),
    lastTouchedVersion: optionalConfigurationTextSchema(
        64,
        "OpenClaw last-touched version is invalid"
    ),
    models: openClawModelSettingsSchema,
    security: openClawSecuritySummarySchema,
    sessionReset: openClawSessionResetSettingsSchema,
    tools: openClawToolSettingsSchema,
    valid: v.boolean("OpenClaw configuration validity is invalid"),
});

const updateOpenClawModelsSchema = v.strictObject({
    fallbacks: openClawModelSettingsSchema.entries.fallbacks,
    primary: openClawModelIdSchema,
    section: v.literal("models"),
});

const updateOpenClawSessionResetSchema = v.strictObject({
    idleMinutes: v.pipe(
        positiveSafeIntegerSchema("OpenClaw session reset is invalid"),
        v.maxValue(10_080, "OpenClaw session reset is outside its budget")
    ),
    section: v.literal("session-reset"),
});

const updateOpenClawHeartbeatSchema = v.strictObject({
    everySeconds: v.pipe(
        positiveSafeIntegerSchema("OpenClaw heartbeat interval is invalid"),
        v.minValue(10, "OpenClaw heartbeat interval is outside its budget"),
        v.maxValue(86_400, "OpenClaw heartbeat interval is outside its budget")
    ),
    section: v.literal("heartbeat"),
    target: v.nullable(
        boundedControlSafeTextSchema(128, "OpenClaw heartbeat target is invalid")
    ),
});

const updateOpenClawToolsSchema = v.strictObject({
    section: v.literal("tools"),
    settings: openClawToolSettingsSchema,
});

const updateOpenClawChannelsSchema = v.strictObject({
    channels: openClawChannelsSchema,
    section: v.literal("channels"),
});

const updateOpenClawAgentToolAccessSchema = v.strictObject({
    agentId: openClawAgentIdSchema,
    override: openClawAgentToolOverrideSchema,
    section: v.literal("agent-tool-access"),
    toolId: openClawReviewedAgentToolIdSchema,
});

export const openClawConfigurationUpdateSchema = v.variant("section", [
    updateOpenClawAgentToolAccessSchema,
    updateOpenClawChannelsSchema,
    updateOpenClawHeartbeatSchema,
    updateOpenClawModelsSchema,
    updateOpenClawSessionResetSchema,
    updateOpenClawToolsSchema,
]);

export const updateOpenClawConfigurationInputSchema = v.strictObject({
    baseHash: openClawConfigHashSchema,
    confirmation: v.literal(
        "apply-reviewed-settings",
        "OpenClaw settings confirmation is required"
    ),
    update: openClawConfigurationUpdateSchema,
});

export const updateOpenClawConfigurationResultSchema = v.strictObject({
    changed: v.boolean("OpenClaw configuration change state is invalid"),
    configuration: openClawConfigurationSnapshotSchema,
    restartRequired: v.boolean("OpenClaw restart requirement is invalid"),
    restartScheduled: v.boolean("OpenClaw restart schedule state is invalid"),
});

export const openClawSkillKeySchema = v.pipe(
    boundedControlSafeTextSchema(128, "OpenClaw skill key is invalid"),
    v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "OpenClaw skill key is invalid")
);

export const openClawSkillSources = [
    "openclaw-bundled",
    "openclaw-configured",
    "openclaw-managed",
    "openclaw-plugin",
    "openclaw-workspace",
] as const;

export const openClawSkillSourceSchema = v.picklist(
    openClawSkillSources,
    "OpenClaw skill source is invalid"
);

export interface OpenClawSkillValue {
    readonly bundled: boolean;
    readonly description?: string;
    readonly eligible: boolean;
    readonly enabled: boolean;
    readonly installed: boolean;
    readonly key: string;
    readonly name: string;
    readonly source: (typeof openClawSkillSources)[number];
}

export function openClawSkillBundledSourceIsConsistent({
    bundled,
    source,
}: OpenClawSkillValue): boolean {
    return bundled === (source === "openclaw-bundled");
}

export function openClawSkillInstallationSourceIsConsistent({
    installed,
    source,
}: OpenClawSkillValue): boolean {
    return installed === (source !== "openclaw-configured");
}

const openClawSkillSchema = v.pipe(
    v.strictObject({
        bundled: v.boolean("OpenClaw skill bundle state is invalid"),
        description: v.optional(
            boundedNonBlankTextSchema(1024, "OpenClaw skill description is invalid")
        ),
        eligible: v.boolean("OpenClaw skill eligibility is invalid"),
        enabled: v.boolean("OpenClaw skill enabled state is invalid"),
        installed: v.boolean("OpenClaw skill installation state is invalid"),
        key: openClawSkillKeySchema,
        name: boundedControlSafeTextSchema(128, "OpenClaw skill name is invalid"),
        source: openClawSkillSourceSchema,
    }),
    v.check(
        openClawSkillBundledSourceIsConsistent,
        "OpenClaw skill bundle state is inconsistent"
    ),
    v.check(
        openClawSkillInstallationSourceIsConsistent,
        "OpenClaw skill installation state is inconsistent"
    )
);

export function openClawSkillsHaveStableUniqueOrder(
    skills: OpenClawSkillValue[]
): boolean {
    if (!hasUniqueArrayItems(skills.map(({ key }) => key))) return false;
    return skills.every(
        (skill, index) =>
            index === 0 || compareStrings(skills[index - 1]?.key ?? "", skill.key) < 0
    );
}

export const listOpenClawSkillsInputSchema = v.strictObject({});

export const listOpenClawSkillsResultSchema = v.strictObject({
    skills: v.pipe(
        v.array(openClawSkillSchema, "OpenClaw skills are invalid"),
        v.maxLength(openClawSkillMaximum, "OpenClaw skills are outside their budget"),
        v.check(
            openClawSkillsHaveStableUniqueOrder,
            "OpenClaw skills must be unique and ordered"
        )
    ),
    truncated: v.boolean("OpenClaw skill truncation state is invalid"),
});

export const setOpenClawSkillEnabledInputSchema = v.strictObject({
    baseHash: openClawConfigHashSchema,
    enabled: v.boolean("OpenClaw skill enabled state is invalid"),
    skillKey: openClawSkillKeySchema,
});

export const setOpenClawSkillEnabledResultSchema = v.strictObject({
    enabled: v.boolean("OpenClaw skill enabled state is invalid"),
    skillKey: openClawSkillKeySchema,
});

export type OpenClawConfigurationSnapshot = v.InferOutput<
    typeof openClawConfigurationSnapshotSchema
>;
export type OpenClawConfigurationUpdate = v.InferOutput<
    typeof openClawConfigurationUpdateSchema
>;
export type UpdateOpenClawConfigurationInput = v.InferOutput<
    typeof updateOpenClawConfigurationInputSchema
>;
export type UpdateOpenClawConfigurationResult = v.InferOutput<
    typeof updateOpenClawConfigurationResultSchema
>;
export type ListOpenClawSkillsResult = v.InferOutput<
    typeof listOpenClawSkillsResultSchema
>;
export type SetOpenClawSkillEnabledInput = v.InferOutput<
    typeof setOpenClawSkillEnabledInputSchema
>;
export type SetOpenClawSkillEnabledResult = v.InferOutput<
    typeof setOpenClawSkillEnabledResultSchema
>;

const readAccess = {
    capabilities: ["openclaw-settings:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;
const controlAccess = {
    capabilities: ["openclaw-settings:write"],
    kind: "recent-auth",
    principalKinds: ["session"],
    whenMfaDisabled: "deny",
    whenMfaEnabled: "mfa",
} as const;
const queryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const mutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;
const controlErrors = [
    "CONFLICT",
    "FORBIDDEN",
    "SERVICE_UNAVAILABLE",
    "UNAUTHORIZED",
] as const;
const skillControlErrors = [
    "CONFLICT",
    "FORBIDDEN",
    "NOT_FOUND",
    "SERVICE_UNAVAILABLE",
    "UNAUTHORIZED",
] as const;
const controlErrorReasons = [
    "mfa_enrollment_required",
    "operation_outcome_unknown",
    "step_up_required",
] as const;

/** Bounded, secret-free OpenClaw settings procedure metadata. */
export const openClawSettingsProcedureContracts = [
    {
        access: readAccess,
        domain: "openclaw-settings",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: getOpenClawConfigurationInputSchema,
        inputSchemaId: "openClawSettings.getConfiguration.input",
        kind: "query",
        name: "openClawSettings.getConfiguration",
        output: openClawConfigurationSnapshotSchema,
        outputSchemaId: "openClawSettings.getConfiguration.output",
        summary:
            "Returns a bounded secret-free projection of exact code-owned OpenClaw settings.",
        transport: queryTransport,
    },
    {
        access: readAccess,
        domain: "openclaw-settings",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: listOpenClawSkillsInputSchema,
        inputSchemaId: "openClawSettings.listSkills.input",
        kind: "query",
        name: "openClawSettings.listSkills",
        output: listOpenClawSkillsResultSchema,
        outputSchemaId: "openClawSettings.listSkills.output",
        summary:
            "Lists one bounded, path-free projection of discovered and safe configured-only OpenClaw skills.",
        transport: queryTransport,
    },
    {
        access: controlAccess,
        domain: "openclaw-settings",
        errorReasons: controlErrorReasons,
        errors: controlErrors,
        input: updateOpenClawConfigurationInputSchema,
        inputSchemaId: "openClawSettings.updateConfiguration.input",
        kind: "mutation",
        name: "openClawSettings.updateConfiguration",
        output: updateOpenClawConfigurationResultSchema,
        outputSchemaId: "openClawSettings.updateConfiguration.output",
        summary:
            "Applies one hash-fenced server-built patch to an exact reviewed settings section after recent MFA.",
        transport: mutationTransport,
    },
    {
        access: controlAccess,
        domain: "openclaw-settings",
        errorReasons: controlErrorReasons,
        errors: skillControlErrors,
        input: setOpenClawSkillEnabledInputSchema,
        inputSchemaId: "openClawSettings.setSkillEnabled.input",
        kind: "mutation",
        name: "openClawSettings.setSkillEnabled",
        output: setOpenClawSkillEnabledResultSchema,
        outputSchemaId: "openClawSettings.setSkillEnabled.output",
        summary:
            "Enables or disables one freshly verified exact OpenClaw skill after recent MFA.",
        transport: mutationTransport,
    },
] as const satisfies readonly ProcedureContract[];
