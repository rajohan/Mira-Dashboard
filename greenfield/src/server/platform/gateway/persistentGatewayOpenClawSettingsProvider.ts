/* oxlint-disable unicorn/max-nested-calls -- Valibot boundary schemas are declarative compositions. */
import { isDeepStrictEqual } from "node:util";

import * as v from "valibot";

import {
    listOpenClawSkillsResultSchema,
    openClawAgentAccessMaximum,
    openClawAgentIdSchema,
    openClawChannelIdSchema,
    openClawChannelMaximum,
    openClawConfigurationSnapshotSchema,
    openClawConfigurationUpstreamMaximumBytes,
    openClawConfigHashSchema,
    openClawConfigRevisionHashSchema,
    openClawGatewaySkillSources,
    openClawModelFallbackMaximum,
    openClawModelIdSchema,
    openClawReviewedAgentToolIds,
    openClawSkillKeySchema,
    openClawSkillMaximum,
    openClawSkillsUpstreamMaximumBytes,
    setOpenClawSkillEnabledInputSchema,
    setOpenClawSkillEnabledResultSchema,
    updateOpenClawConfigurationInputSchema,
    updateOpenClawConfigurationResultSchema,
    type ListOpenClawSkillsResult,
    type OpenClawAgentToolAccessValue,
    type OpenClawConfigurationSnapshot,
    type OpenClawConfigurationUpdate,
    type OpenClawSkillValue,
    type UpdateOpenClawConfigurationResult,
} from "../../../contracts/openClawSettings.ts";
import {
    compareStrings,
    hasNoUnicodeControlOrFormat,
} from "../../../shared/validation.ts";
import {
    OpenClawSettingsProviderError,
    type OpenClawSettingsProvider,
    type OpenClawSettingsProviderRequest,
    type OpenClawSettingsProviderSetSkillEnabledRequest,
    type OpenClawSettingsProviderSetSkillEnabledResult,
    type OpenClawSettingsProviderUpdateConfigurationRequest,
} from "../../domains/openClawSettings/provider.ts";
import { persistentGatewayOpenClawSettingsPatchMaximumBytes } from "./persistentGatewayProtocol.ts";
import {
    persistentGatewayConfigurationChangedReason,
    PersistentGatewayRequestError,
    type PersistentGatewayRequestOptions,
    type PersistentGatewayTransport,
    PersistentGatewayUnknownOutcomeError,
} from "./persistentGatewayTransport.ts";

export const persistentGatewayOpenClawSettingsReadTimeoutMs = 15_000;
export const persistentGatewayOpenClawSettingsWriteTimeoutMs = 60_000;

export type PersistentGatewayOpenClawSettingsTransport = Pick<
    PersistentGatewayTransport,
    "requestOpenClawSettingsRead" | "requestOpenClawSettingsWrite"
>;

class OpenClawSettingsDispatchAuthorizationError extends Error {
    public readonly failure: unknown;

    public constructor(failure: unknown) {
        super("OpenClaw Settings dispatch authorization failed");
        this.name = "OpenClawSettingsDispatchAuthorizationError";
        this.failure = failure;
    }
}

const upstreamTextSchema = (maximum: number) =>
    v.pipe(
        v.string(),
        v.maxLength(maximum),
        v.check((value) => !value.includes("\0"))
    );
const upstreamControlSafeTextSchema = (maximum: number) =>
    v.pipe(upstreamTextSchema(maximum), v.check(hasNoUnicodeControlOrFormat));
const upstreamUnknownArraySchema = v.pipe(v.array(v.unknown()), v.maxLength(4096));
const upstreamRecordSchema = v.record(v.string(), v.unknown());
const upstreamAgentToolPolicyMaximum = 512;
const upstreamConfiguredSkillMaximum = 4096;
const upstreamConfiguredSkillEntriesSchema = v.pipe(
    v.record(v.string(), v.object({ enabled: v.optional(v.boolean()) })),
    v.check((entries) => Object.keys(entries).length <= upstreamConfiguredSkillMaximum)
);
const upstreamAgentToolPolicyListSchema = v.pipe(
    v.array(upstreamControlSafeTextSchema(256)),
    v.maxLength(upstreamAgentToolPolicyMaximum)
);
const upstreamHeartbeatSchema = v.object({
    every: v.optional(upstreamControlSafeTextSchema(128)),
    target: v.optional(upstreamControlSafeTextSchema(1024)),
});
const upstreamAgentEntriesSchema = v.pipe(
    v.record(
        v.string(),
        v.object({
            default: v.optional(v.boolean()),
            heartbeat: v.optional(upstreamHeartbeatSchema),
            name: v.optional(upstreamControlSafeTextSchema(1024)),
            tools: v.optional(
                v.object({
                    allow: v.optional(upstreamAgentToolPolicyListSchema),
                    alsoAllow: v.optional(upstreamAgentToolPolicyListSchema),
                    deny: v.optional(upstreamAgentToolPolicyListSchema),
                })
            ),
        })
    ),
    v.check((entries) => Object.keys(entries).length <= 256)
);

const upstreamModelSchema = v.union([
    upstreamControlSafeTextSchema(16 * 1024),
    v.object({
        fallbacks: v.optional(
            v.pipe(
                v.array(upstreamControlSafeTextSchema(16 * 1024)),
                v.maxLength(openClawModelFallbackMaximum)
            )
        ),
        primary: v.optional(upstreamControlSafeTextSchema(16 * 1024)),
    }),
]);
const upstreamConfigurationSchema = v.object({
    agents: v.optional(
        v.object({
            defaults: v.optional(
                v.object({
                    heartbeat: v.optional(upstreamHeartbeatSchema),
                    imageModel: v.optional(upstreamModelSchema),
                    mediaModels: v.optional(
                        v.object({ image: v.optional(upstreamModelSchema) })
                    ),
                    model: v.optional(upstreamModelSchema),
                })
            ),
            entries: v.optional(upstreamAgentEntriesSchema),
        })
    ),
    auth: v.optional(v.object({ profiles: v.optional(upstreamRecordSchema) })),
    channels: v.optional(
        v.record(
            upstreamControlSafeTextSchema(256),
            v.object({ enabled: v.optional(v.boolean()) })
        )
    ),
    commands: v.optional(
        v.object({
            ownerAllowFrom: v.optional(upstreamUnknownArraySchema),
            restart: v.optional(v.boolean()),
        })
    ),
    logging: v.optional(
        v.object({ redactSensitive: v.optional(upstreamControlSafeTextSchema(256)) })
    ),
    meta: v.optional(
        v.object({
            lastTouchedAt: v.optional(upstreamControlSafeTextSchema(1024)),
            lastTouchedVersion: v.optional(upstreamControlSafeTextSchema(1024)),
        })
    ),
    session: v.optional(
        v.object({
            reset: v.optional(
                v.object({
                    atHour: v.optional(
                        v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(23))
                    ),
                    idleMinutes: v.optional(
                        v.pipe(v.number(), v.safeInteger(), v.minValue(1))
                    ),
                    mode: v.optional(v.picklist(["daily", "idle", "none"])),
                })
            ),
        })
    ),
    skills: v.optional(
        v.object({ entries: v.optional(upstreamConfiguredSkillEntriesSchema) })
    ),
    tools: v.optional(
        v.object({
            agentToAgent: v.optional(v.object({ enabled: v.optional(v.boolean()) })),
            elevated: v.optional(v.object({ enabled: v.optional(v.boolean()) })),
            exec: v.optional(
                v.object({
                    ask: v.optional(v.picklist(["off", "on-miss", "always"])),
                    mode: v.optional(
                        v.picklist(["deny", "allowlist", "ask", "auto", "full"])
                    ),
                    security: v.optional(v.picklist(["allowlist", "deny", "full"])),
                })
            ),
            profile: v.optional(upstreamControlSafeTextSchema(256)),
            sessions: v.optional(
                v.object({
                    visibility: v.optional(v.picklist(["all", "self", "tree", "agent"])),
                })
            ),
            web: v.optional(
                v.object({
                    fetch: v.optional(v.object({ enabled: v.optional(v.boolean()) })),
                    search: v.optional(
                        v.object({
                            enabled: v.optional(v.boolean()),
                            provider: v.optional(upstreamControlSafeTextSchema(256)),
                        })
                    ),
                })
            ),
        })
    ),
    wizard: v.optional(
        v.object({
            lastRunAt: v.optional(upstreamControlSafeTextSchema(1024)),
            lastRunVersion: v.optional(upstreamControlSafeTextSchema(1024)),
        })
    ),
});

const upstreamConfigGetResponseSchema = v.object({
    config: v.unknown(),
    configRevisionHash: openClawConfigRevisionHashSchema,
    hash: openClawConfigHashSchema,
    includedPaths: v.pipe(v.array(upstreamTextSchema(4096)), v.maxLength(4096)),
    issues: upstreamUnknownArraySchema,
    legacyIssues: upstreamUnknownArraySchema,
    parsed: v.unknown(),
    sourceConfig: v.unknown(),
    valid: v.boolean(),
});

const upstreamConfigPatchResponseSchema = v.object({
    config: upstreamConfigurationSchema,
    hash: v.optional(openClawConfigHashSchema),
    noop: v.optional(v.boolean()),
    ok: v.literal(true),
    restart: v.optional(v.object({ ok: v.literal(true) })),
    sentinel: v.optional(
        v.object({
            payload: v.object({
                stats: v.object({ requiresRestart: v.boolean() }),
            }),
            persisted: v.boolean(),
        })
    ),
});

const upstreamSkillUpdateResponseSchema = v.object({
    config: v.object({ enabled: v.optional(v.boolean()) }),
    ok: v.literal(true),
    skillKey: openClawSkillKeySchema,
});

const upstreamSkillSchema = v.object({
    bundled: v.boolean(),
    description: v.optional(upstreamTextSchema(64 * 1024)),
    disabled: v.boolean(),
    eligible: v.boolean(),
    name: upstreamControlSafeTextSchema(16 * 1024),
    skillKey: upstreamControlSafeTextSchema(128),
    source: upstreamControlSafeTextSchema(256),
});
const upstreamSkillsStatusResponseSchema = v.object({
    skills: v.pipe(v.array(upstreamSkillSchema), v.maxLength(4096)),
});
const reservedOpenClawChannelKeys = new Set(["defaults", "modelByChannel"]);

const gatewaySkillSourceProjection = {
    "agents-skills-personal": "agents-skills-personal",
    "agents-skills-project": "agents-skills-project",
    "openclaw-bundled": "openclaw-bundled",
    "openclaw-extra": "openclaw-extra",
    "openclaw-managed": "openclaw-managed",
    "openclaw-node": "openclaw-node",
    "openclaw-workspace": "openclaw-workspace",
    unknown: "openclaw-unknown",
} as const satisfies Readonly<
    Record<(typeof openClawGatewaySkillSources)[number], OpenClawSkillValue["source"]>
>;

function projectGatewaySkillSource(
    source: string
): OpenClawSkillValue["source"] | undefined {
    return Object.hasOwn(gatewaySkillSourceProjection, source)
        ? gatewaySkillSourceProjection[
              source as keyof typeof gatewaySkillSourceProjection
          ]
        : undefined;
}

interface InternalConfigurationSnapshot {
    readonly configuration: OpenClawConfigurationSnapshot;
    readonly upstream: v.InferOutput<typeof upstreamConfigurationSchema>;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isUnknownRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoundary<TSchema extends v.GenericSchema>(
    schema: TSchema,
    value: unknown,
    reason: "data-invalid" | "unknown-outcome" = "data-invalid"
): v.InferOutput<TSchema> {
    const parsed = v.safeParse(schema, value, { abortEarly: true });
    if (!parsed.success) throw new OpenClawSettingsProviderError(reason);
    return parsed.output;
}

function requestOptions(
    signal: AbortSignal | undefined,
    timeoutMs: number,
    observeBytes: (bytes: number) => void
): PersistentGatewayRequestOptions {
    return {
        onResponseBytes: observeBytes,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs,
    };
}

function createByteObservation(maximumBytes: number): Readonly<{
    assertWithinBudget: (reason: "data-invalid" | "unknown-outcome") => void;
    observe: (bytes: number) => void;
}> {
    let observed: number | undefined;
    return Object.freeze({
        assertWithinBudget(reason) {
            if (
                observed === undefined ||
                !Number.isSafeInteger(observed) ||
                observed < 1 ||
                observed > maximumBytes
            ) {
                throw new OpenClawSettingsProviderError(reason);
            }
        },
        observe(bytes) {
            observed = observed === undefined ? bytes : Number.NaN;
        },
    });
}

function mapFailure(error: unknown, mutation: boolean): never {
    if (error instanceof OpenClawSettingsDispatchAuthorizationError) {
        throw error.failure;
    }
    if (error instanceof OpenClawSettingsProviderError) throw error;
    if (error instanceof PersistentGatewayUnknownOutcomeError) {
        throw new OpenClawSettingsProviderError(
            mutation ? "unknown-outcome" : "unavailable"
        );
    }
    if (
        error instanceof PersistentGatewayRequestError &&
        error.reason === persistentGatewayConfigurationChangedReason
    ) {
        throw new OpenClawSettingsProviderError("conflict");
    }
    if (
        error instanceof PersistentGatewayRequestError &&
        error.code === "INVALID_REQUEST"
    ) {
        throw new OpenClawSettingsProviderError("data-invalid");
    }
    throw new OpenClawSettingsProviderError("unavailable");
}

function beforeMutationDispatch(
    authorizeDispatch: () => Promise<void>
): () => Promise<void> {
    return async () => {
        try {
            await authorizeDispatch();
        } catch (error) {
            throw new OpenClawSettingsDispatchAuthorizationError(error);
        }
    };
}

function configMutationOutcomeIsUncertain(error: unknown): boolean {
    // beforeMutationDispatch wraps every pre-dispatch failure. A direct request
    // error therefore proves that the one-shot lane already sent the mutation.
    // OpenClaw's audited INVALID_REQUEST responses are definitive: the canonical
    // base-hash reason is a conflict and every other rejection is data-invalid.
    return (
        error instanceof PersistentGatewayUnknownOutcomeError ||
        (error instanceof PersistentGatewayRequestError &&
            error.code !== "INVALID_REQUEST")
    );
}

function skillMutationNeedsReconciliation(error: unknown): boolean {
    // skills.update has no hash fence. Any response/error after dispatch needs
    // one readback, and an inconclusive readback must never trigger a replay.
    return (
        error instanceof PersistentGatewayRequestError ||
        error instanceof PersistentGatewayUnknownOutcomeError
    );
}

async function providerOperation<T>(
    mutation: boolean,
    operation: () => Promise<T>
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        mapFailure(error, mutation);
    }
}

function heartbeatSeconds(
    value: string | undefined,
    reason: "data-invalid" | "unknown-outcome" = "data-invalid"
): number | undefined {
    if (value === undefined) return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) return undefined;
    const unitMilliseconds = Object.freeze({
        d: 86_400_000,
        h: 3_600_000,
        m: 60_000,
        ms: 1,
        s: 1000,
    });
    type DurationUnit = keyof typeof unitMilliseconds;
    const single = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/u.exec(normalized);
    let milliseconds = 0;
    if (single === null) {
        let consumed = 0;
        for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gu)) {
            if (match.index !== consumed) {
                throw new OpenClawSettingsProviderError(reason);
            }
            const amount = match[1];
            const unit = match[2] as DurationUnit | undefined;
            if (amount === undefined || unit === undefined) {
                throw new OpenClawSettingsProviderError(reason);
            }
            milliseconds += Number(amount) * unitMilliseconds[unit];
            consumed += match[0].length;
        }
        if (consumed !== normalized.length || consumed === 0) {
            throw new OpenClawSettingsProviderError(reason);
        }
    } else {
        const amount = single[1];
        const unit = (single[2] ?? "m") as DurationUnit;
        if (amount === undefined) {
            throw new OpenClawSettingsProviderError(reason);
        }
        milliseconds = Number(amount) * unitMilliseconds[unit];
    }
    const seconds = milliseconds / 1000;
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
        throw new OpenClawSettingsProviderError(reason);
    }
    return seconds;
}

function projectExecPolicy(
    exec:
        | NonNullable<
              NonNullable<
                  v.InferOutput<typeof upstreamConfigurationSchema>["tools"]
              >["exec"]
          >
        | undefined
): OpenClawConfigurationSnapshot["tools"]["execPolicy"] {
    if (exec === undefined) return { state: "inherited" };
    if (exec.mode !== undefined) return { mode: exec.mode, state: "legacy-mode" };
    if (exec.ask === undefined || exec.security === undefined) {
        return { state: "partial" };
    }
    return { ask: exec.ask, security: exec.security, state: "explicit" };
}

function projectToolSettings(
    tools: v.InferOutput<typeof upstreamConfigurationSchema>["tools"]
): OpenClawConfigurationSnapshot["tools"] {
    const visibility = tools?.sessions?.visibility;
    const profile = optionalNonBlankUpstreamText(tools?.profile);
    const webSearchProvider = optionalNonBlankUpstreamText(tools?.web?.search?.provider);
    return {
        agentToAgentEnabled: tools?.agentToAgent?.enabled ?? false,
        elevatedEnabled: tools?.elevated?.enabled !== false,
        execPolicy: projectExecPolicy(tools?.exec),
        ...(profile === undefined ? {} : { profile }),
        ...(visibility === undefined ? {} : { sessionsVisibility: visibility }),
        webFetchEnabled: tools?.web?.fetch?.enabled ?? true,
        webSearchEnabled: tools?.web?.search?.enabled ?? true,
        ...(webSearchProvider === undefined ? {} : { webSearchProvider }),
    };
}

function optionalNonBlankUpstreamText(value: string | undefined): string | undefined {
    return value === undefined || value.trim().length === 0 ? undefined : value;
}

function projectSessionReset(
    reset: NonNullable<
        v.InferOutput<typeof upstreamConfigurationSchema>["session"]
    >["reset"]
): OpenClawConfigurationSnapshot["sessionReset"] {
    if (reset === undefined) return { state: "inherited-none" };
    if (reset.mode === undefined) return { state: "implicit-daily" };
    if (reset.mode !== "idle") {
        return {
            ...(reset.mode === "daily" && reset.atHour !== undefined
                ? { atHour: reset.atHour }
                : {}),
            ...(reset.idleMinutes !== undefined && reset.idleMinutes <= 10_080
                ? { idleMinutes: reset.idleMinutes }
                : {}),
            mode: reset.mode,
            state: "locked-mode",
        };
    }
    if (reset.idleMinutes === undefined || reset.idleMinutes > 10_080) {
        return { state: "partial-idle" };
    }
    return {
        idleMinutes: reset.idleMinutes,
        mode: "idle",
        state: "explicit-idle",
    };
}

const googleModelProviders = new Set(["google", "google-gemini-cli", "google-vertex"]);

function normalizeGoogleModelId(modelId: string): string {
    if (modelId.startsWith("google/")) {
        return `google/${normalizeGoogleModelId(modelId.slice("google/".length))}`;
    }
    switch (modelId) {
        case "gemini-3-pro":
        case "gemini-3-pro-preview":
        case "gemini-3.1-pro": {
            return "gemini-3.1-pro-preview";
        }
        case "gemini-3-flash":
        case "gemini-3.1-flash":
        case "gemini-3.1-flash-preview": {
            return "gemini-3-flash-preview";
        }
        case "gemini-3.1-flash-lite-preview": {
            return "gemini-3.1-flash-lite";
        }
        case "gemma-4-26b": {
            return "gemma-4-26b-a4b-it";
        }
        default: {
            return modelId;
        }
    }
}

/**
 * Mirrors only the hash-pinned config.patch model-ref canonicalization surface.
 * @param model Submitted provider/model reference.
 * @returns The exact model reference that the reviewed Gateway will persist.
 */
function normalizeSubmittedModelRef(model: string): string {
    const trimmed = model.trim();
    const separator = trimmed.indexOf("/");
    if (separator <= 0 || separator >= trimmed.length - 1) return trimmed;
    const provider = trimmed.slice(0, separator).trim().toLowerCase();
    const modelId = trimmed.slice(separator + 1).trim();
    let normalizedModelId = modelId;
    if (googleModelProviders.has(provider) || modelId.startsWith("google/")) {
        normalizedModelId = normalizeGoogleModelId(modelId);
    } else if (provider === "together" && modelId === "moonshotai/Kimi-K2.5") {
        normalizedModelId = "moonshotai/Kimi-K2.6";
    }
    return normalizedModelId.toLowerCase().startsWith(`${provider}/`)
        ? normalizedModelId
        : `${provider}/${normalizedModelId}`;
}

function validatedSubmittedModelRef(model: string): string {
    return parseBoundary(openClawModelIdSchema, normalizeSubmittedModelRef(model));
}

const inspectedModelReferenceMaximum = 8192;

interface ModelNormalizationInspection {
    count: number;
    rejectDynamicSources: boolean;
    state: OpenClawConfigurationSnapshot["modelNormalizationState"];
}

function markModelNormalizationUnknown(inspection: ModelNormalizationInspection): void {
    inspection.state = "unknown";
}

function inspectModelReference(
    inspection: ModelNormalizationInspection,
    value: unknown
): void {
    if (inspection.state === "unknown" || typeof value !== "string") return;
    if (inspection.rejectDynamicSources && value.includes("${")) {
        markModelNormalizationUnknown(inspection);
        return;
    }
    inspection.count += 1;
    if (inspection.count > inspectedModelReferenceMaximum) {
        markModelNormalizationUnknown(inspection);
        return;
    }
    if (normalizeSubmittedModelRef(value) !== value) inspection.state = "pending";
}

function inspectModelSelection(
    inspection: ModelNormalizationInspection,
    value: unknown
): void {
    if (typeof value === "string") {
        inspectModelReference(inspection, value);
        return;
    }
    if (!isUnknownRecord(value)) return;
    inspectModelReference(inspection, value.primary);
    if (Array.isArray(value.fallbacks)) {
        for (const fallback of value.fallbacks) {
            inspectModelReference(inspection, fallback);
        }
    }
}

function inspectModelMap(inspection: ModelNormalizationInspection, value: unknown): void {
    if (!isUnknownRecord(value) || inspection.state === "unknown") return;
    const normalizedKeys = new Set<string>();
    for (const key of Object.keys(value)) {
        inspection.count += 1;
        if (inspection.count > inspectedModelReferenceMaximum) {
            markModelNormalizationUnknown(inspection);
            return;
        }
        const normalized = normalizeSubmittedModelRef(key);
        if (inspection.rejectDynamicSources && key.includes("${")) {
            markModelNormalizationUnknown(inspection);
            return;
        }
        if (normalized !== key || normalizedKeys.has(normalized)) {
            inspection.state = "pending";
        }
        normalizedKeys.add(normalized);
    }
}

function inspectAgentModelScope(
    inspection: ModelNormalizationInspection,
    value: unknown
): void {
    if (!isUnknownRecord(value) || inspection.state === "unknown") return;
    for (const key of ["model", "imageModel", "voiceModel", "pdfModel"] as const) {
        if (Object.hasOwn(value, key)) inspectModelSelection(inspection, value[key]);
    }
    inspectModelReference(inspection, value.utilityModel);
    if (isUnknownRecord(value.mediaModels)) {
        for (const key of ["image", "video", "music"] as const) {
            if (Object.hasOwn(value.mediaModels, key)) {
                inspectModelSelection(inspection, value.mediaModels[key]);
            }
        }
    }
    if (isUnknownRecord(value.heartbeat)) {
        inspectModelReference(inspection, value.heartbeat.model);
    }
    if (isUnknownRecord(value.subagents)) {
        inspectModelSelection(inspection, value.subagents.model);
    }
    if (isUnknownRecord(value.compaction)) {
        inspectModelReference(inspection, value.compaction.model);
        if (isUnknownRecord(value.compaction.memoryFlush)) {
            inspectModelReference(inspection, value.compaction.memoryFlush.model);
        }
    }
    inspectModelMap(inspection, value.models);
}

function inspectAgentModelScopes(
    inspection: ModelNormalizationInspection,
    sourceConfig: UnknownRecord
): void {
    if (!isUnknownRecord(sourceConfig.agents)) return;
    inspectAgentModelScope(inspection, sourceConfig.agents.defaults);
    if (isUnknownRecord(sourceConfig.agents.entries)) {
        for (const entry of Object.values(sourceConfig.agents.entries)) {
            inspectAgentModelScope(inspection, entry);
        }
    }
    if (Array.isArray(sourceConfig.agents.list)) {
        for (const entry of sourceConfig.agents.list) {
            inspectAgentModelScope(inspection, entry);
        }
    }
}

function inspectProviderCatalogModelIds(
    inspection: ModelNormalizationInspection,
    sourceConfig: UnknownRecord,
    runtimeConfig: UnknownRecord
): void {
    const sourceModels = isUnknownRecord(sourceConfig.models)
        ? sourceConfig.models
        : undefined;
    const sourceProviders =
        sourceModels !== undefined && isUnknownRecord(sourceModels.providers)
            ? sourceModels.providers
            : undefined;
    if (sourceProviders === undefined) return;
    const runtimeModels = isUnknownRecord(runtimeConfig.models)
        ? runtimeConfig.models
        : undefined;
    const runtimeProviders =
        runtimeModels !== undefined && isUnknownRecord(runtimeModels.providers)
            ? runtimeModels.providers
            : undefined;
    if (runtimeProviders === undefined) {
        markModelNormalizationUnknown(inspection);
        return;
    }
    for (const [providerId, sourceProvider] of Object.entries(sourceProviders)) {
        if (!isUnknownRecord(sourceProvider) || !Array.isArray(sourceProvider.models)) {
            continue;
        }
        const runtimeProvider = runtimeProviders[providerId];
        if (!isUnknownRecord(runtimeProvider) || !Array.isArray(runtimeProvider.models)) {
            markModelNormalizationUnknown(inspection);
            return;
        }
        for (const [index, sourceModel] of sourceProvider.models.entries()) {
            if (!isUnknownRecord(sourceModel) || typeof sourceModel.id !== "string") {
                continue;
            }
            const trimmed = sourceModel.id.trim();
            if (trimmed.length === 0) continue;
            inspection.count += 1;
            if (inspection.count > inspectedModelReferenceMaximum) {
                markModelNormalizationUnknown(inspection);
                return;
            }
            const runtimeModel: unknown = runtimeProvider.models[index];
            if (!isUnknownRecord(runtimeModel) || typeof runtimeModel.id !== "string") {
                markModelNormalizationUnknown(inspection);
                return;
            }
            if (runtimeModel.id !== sourceModel.id) inspection.state = "pending";
        }
    }
}

function inspectProviderCatalogDynamicSources(
    inspection: ModelNormalizationInspection,
    parsedConfig: UnknownRecord
): void {
    const models = isUnknownRecord(parsedConfig.models) ? parsedConfig.models : undefined;
    const providers =
        models !== undefined && isUnknownRecord(models.providers)
            ? models.providers
            : undefined;
    if (providers === undefined) return;
    for (const provider of Object.values(providers)) {
        if (!isUnknownRecord(provider) || !Array.isArray(provider.models)) continue;
        for (const model of provider.models) {
            if (
                isUnknownRecord(model) &&
                typeof model.id === "string" &&
                model.id.includes("${")
            ) {
                markModelNormalizationUnknown(inspection);
                return;
            }
        }
    }
}

function inspectModelNormalizationState(
    sourceConfig: unknown,
    runtimeConfig: unknown,
    parsedConfig: unknown
): OpenClawConfigurationSnapshot["modelNormalizationState"] {
    if (
        !isUnknownRecord(sourceConfig) ||
        !isUnknownRecord(runtimeConfig) ||
        !isUnknownRecord(parsedConfig)
    ) {
        return "unknown";
    }
    const inspection: ModelNormalizationInspection = {
        count: 0,
        rejectDynamicSources: true,
        state: "clean",
    };
    inspectAgentModelScopes(inspection, parsedConfig);
    inspectProviderCatalogDynamicSources(inspection, parsedConfig);
    if (inspection.state === "unknown") return "unknown";
    inspection.rejectDynamicSources = false;
    inspectAgentModelScopes(inspection, sourceConfig);
    inspectProviderCatalogModelIds(inspection, sourceConfig, runtimeConfig);
    return inspection.state;
}

function rawChannelsWereTruncated(runtimeConfig: unknown): boolean {
    if (!isUnknownRecord(runtimeConfig) || !isUnknownRecord(runtimeConfig.channels)) {
        return false;
    }
    let supportedCount = 0;
    for (const id of Object.keys(runtimeConfig.channels)) {
        if (reservedOpenClawChannelKeys.has(id)) continue;
        if (!v.safeParse(openClawChannelIdSchema, id, { abortEarly: true }).success) {
            return true;
        }
        supportedCount += 1;
        if (supportedCount > openClawChannelMaximum) return true;
    }
    return false;
}

type ReviewedAgentToolId = (typeof openClawReviewedAgentToolIds)[number];

const reviewedAgentToolIdSet = new Set<string>(openClawReviewedAgentToolIds);
const reviewedAgentToolAliases: Readonly<Record<string, ReviewedAgentToolId>> =
    Object.freeze({ bash: "exec", cron: "automations" });

function reviewedAgentToolId(value: string): ReviewedAgentToolId | undefined {
    const normalized = value.trim().toLowerCase();
    const alias = reviewedAgentToolAliases[normalized];
    if (alias !== undefined) return alias;
    return reviewedAgentToolIdSet.has(normalized)
        ? (normalized as ReviewedAgentToolId)
        : undefined;
}

function toolPolicyEntryIsAmbiguous(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return (
        normalized.startsWith("group:") ||
        normalized.includes("*") ||
        normalized.includes("?") ||
        normalized.includes("[") ||
        normalized.includes("]")
    );
}

function projectAgentAccess(
    entries: v.InferOutput<typeof upstreamAgentEntriesSchema> | undefined
): Readonly<{
    agents: OpenClawConfigurationSnapshot["agentAccess"];
    truncated: boolean;
}> {
    if (entries === undefined) return { agents: [], truncated: false };
    const rawEntries = Object.entries(entries);
    const foldedCounts = new Map<string, number>();
    for (const [id] of rawEntries) {
        const folded = id.toLowerCase();
        foldedCounts.set(folded, (foldedCounts.get(folded) ?? 0) + 1);
    }
    let omitted = false;
    const projected = rawEntries.flatMap(([id, entry]) => {
        if (!v.safeParse(openClawAgentIdSchema, id, { abortEarly: true }).success) {
            omitted = true;
            return [];
        }
        const tools = entry.tools;
        const alsoAllow = tools?.alsoAllow ?? [];
        const deny = tools?.deny ?? [];
        const policyAmbiguous =
            (tools?.allow?.length ?? 0) > 0 ||
            [...alsoAllow, ...deny].some((value) => toolPolicyEntryIsAmbiguous(value)) ||
            (foldedCounts.get(id.toLowerCase()) ?? 0) !== 1;
        const projectedTools = openClawReviewedAgentToolIds.map((toolId) => {
            const explicitlyAllowed = alsoAllow.some(
                (value) => reviewedAgentToolId(value) === toolId
            );
            const explicitlyDenied = deny.some(
                (value) => reviewedAgentToolId(value) === toolId
            );
            let override: OpenClawAgentToolAccessValue["override"] = "inherit";
            if (explicitlyDenied) {
                override = "deny";
            } else if (explicitlyAllowed) {
                override = "allow";
            }
            return {
                editable: !policyAmbiguous && !(explicitlyAllowed && explicitlyDenied),
                id: toolId,
                override,
            } satisfies OpenClawAgentToolAccessValue;
        });
        const parsedName = v.safeParse(
            v.pipe(
                v.string(),
                v.minLength(1),
                v.maxLength(64),
                v.check((value) => /\S/u.test(value)),
                v.check(hasNoUnicodeControlOrFormat)
            ),
            entry.name,
            { abortEarly: true }
        );
        return [
            {
                id,
                ...(parsedName.success ? { name: parsedName.output } : {}),
                tools: projectedTools,
            },
        ];
    });
    const sorted = projected.toSorted((left, right) => {
        if (left.id === "main") return right.id === "main" ? 0 : -1;
        if (right.id === "main") return 1;
        return compareStrings(left.id, right.id);
    });
    const agents = sorted.slice(0, openClawAgentAccessMaximum);
    return {
        agents,
        truncated: omitted || agents.length !== rawEntries.length,
    };
}

function agentToolUpdateIsAdmitted(
    upstream: v.InferOutput<typeof upstreamConfigurationSchema>,
    update: Extract<
        OpenClawConfigurationUpdate,
        { readonly section: "agent-tool-access" }
    >
): boolean {
    const entries = upstream.agents?.entries;
    if (entries === undefined) return false;
    const defaults = Object.entries(entries).filter(
        ([, entry]) => entry.default === true
    );
    const configuredOwner =
        defaults.length === 1
            ? defaults[0]
            : Object.entries(entries).find(([agentId]) => agentId === "main");
    if (
        configuredOwner === undefined ||
        !v.safeParse(openClawAgentIdSchema, configuredOwner[0], {
            abortEarly: true,
        }).success
    ) {
        return false;
    }
    const access = projectAgentAccess(entries);
    return (
        access.agents
            .find(({ id }) => id === update.agentId)
            ?.tools.find(({ id }) => id === update.toolId)?.editable === true
    );
}

function configuredHeartbeat(
    agents: v.InferOutput<typeof upstreamConfigurationSchema>["agents"]
): Readonly<{
    heartbeat?: v.InferOutput<typeof upstreamHeartbeatSchema>;
    ownerAgentId?: string;
}> {
    if (agents?.defaults?.heartbeat !== undefined) {
        return { heartbeat: agents.defaults.heartbeat };
    }
    const candidates = Object.entries(agents?.entries ?? {}).filter(
        ([, entry]) => entry.heartbeat !== undefined
    );
    const selected =
        candidates.find(([id]) => id === "ops") ??
        candidates.find(([, entry]) => entry.default === true) ??
        (candidates.length === 1 ? candidates[0] : undefined);
    return selected === undefined
        ? {}
        : { heartbeat: selected[1].heartbeat, ownerAgentId: selected[0] };
}

function projectConfiguration(
    upstream: v.InferOutput<typeof upstreamConfigurationSchema>,
    hash: string,
    revisionHash: string,
    includesPresent: boolean,
    modelNormalizationState: OpenClawConfigurationSnapshot["modelNormalizationState"],
    rawChannelsTruncated: boolean,
    valid: boolean,
    issueCount: number,
    reason: "data-invalid" | "unknown-outcome" = "data-invalid"
): OpenClawConfigurationSnapshot {
    const rawModel = upstream.agents?.defaults?.model;
    const primary = typeof rawModel === "string" ? rawModel : rawModel?.primary;
    const fallbacks = typeof rawModel === "string" ? [] : (rawModel?.fallbacks ?? []);
    const rawImageModel = upstream.agents?.defaults?.imageModel;
    const imageModel =
        typeof rawImageModel === "string" ? rawImageModel : rawImageModel?.primary;
    const rawImageGenerationModel = upstream.agents?.defaults?.mediaModels?.image;
    const imageGenerationModel =
        typeof rawImageGenerationModel === "string"
            ? rawImageGenerationModel
            : rawImageGenerationModel?.primary;
    const { heartbeat } = configuredHeartbeat(upstream.agents);
    const heartbeatTarget = optionalNonBlankUpstreamText(heartbeat?.target);
    let channelsTruncated = rawChannelsTruncated;
    const allChannels = Object.entries(upstream.channels ?? {})
        .flatMap(([id, channel]) => {
            if (reservedOpenClawChannelKeys.has(id)) return [];
            if (!v.safeParse(openClawChannelIdSchema, id, { abortEarly: true }).success) {
                channelsTruncated = true;
                return [];
            }
            return [{ enabled: channel.enabled !== false, id }];
        })
        .toSorted((left, right) => compareStrings(left.id, right.id));
    const channels = allChannels.slice(0, openClawChannelMaximum);
    channelsTruncated ||= allChannels.length > channels.length;
    const agentAccess = projectAgentAccess(upstream.agents?.entries);
    return parseBoundary(
        openClawConfigurationSnapshotSchema,
        {
            agentAccess: agentAccess.agents,
            agentAccessTruncated: agentAccess.truncated,
            channels,
            channelsTruncated,
            hash,
            heartbeat: {
                ...(heartbeat?.every === undefined
                    ? {}
                    : {
                          everySeconds: heartbeatSeconds(heartbeat.every, reason),
                      }),
                ...(heartbeatTarget === undefined ? {} : { target: heartbeatTarget }),
            },
            includesPresent,
            issueCount,
            ...((upstream.meta?.lastTouchedAt ?? upstream.wizard?.lastRunAt) === undefined
                ? {}
                : {
                      lastTouchedAt:
                          upstream.meta?.lastTouchedAt ?? upstream.wizard?.lastRunAt,
                  }),
            ...((upstream.meta?.lastTouchedVersion ?? upstream.wizard?.lastRunVersion) ===
            undefined
                ? {}
                : {
                      lastTouchedVersion:
                          upstream.meta?.lastTouchedVersion ??
                          upstream.wizard?.lastRunVersion,
                  }),
            models: {
                fallbacks,
                ...(imageGenerationModel === undefined ? {} : { imageGenerationModel }),
                ...(imageModel === undefined ? {} : { imageModel }),
                ...(primary === undefined ? {} : { primary }),
            },
            modelNormalizationState,
            revisionHash,
            security: {
                authProfileCount: Object.keys(upstream.auth?.profiles ?? {}).length,
                commandRestartEnabled: upstream.commands?.restart ?? true,
                ownerAllowFromCount: upstream.commands?.ownerAllowFrom?.length ?? 0,
                ...(upstream.logging?.redactSensitive === undefined
                    ? {}
                    : { redactionMode: upstream.logging.redactSensitive }),
            },
            sessionReset: projectSessionReset(upstream.session?.reset),
            tools: projectToolSettings(upstream.tools),
            valid,
        },
        reason
    );
}

function projectSkills(
    response: v.InferOutput<typeof upstreamSkillsStatusResponseSchema>,
    configuredEntries:
        | v.InferOutput<typeof upstreamConfiguredSkillEntriesSchema>
        | undefined
): ListOpenClawSkillsResult {
    const sorted = response.skills.toSorted((left, right) =>
        compareStrings(left.skillKey, right.skillKey)
    );
    if (new Set(sorted.map(({ skillKey }) => skillKey)).size !== sorted.length) {
        throw new OpenClawSettingsProviderError("data-invalid");
    }
    const observedKeys = new Set(sorted.map(({ skillKey }) => skillKey));
    let omittedDiscoveredEntry = false;
    const discovered = sorted.flatMap((skill): OpenClawSkillValue[] => {
        if (
            !v.safeParse(openClawSkillKeySchema, skill.skillKey, {
                abortEarly: true,
            }).success
        ) {
            omittedDiscoveredEntry = true;
            return [];
        }
        const source = projectGatewaySkillSource(skill.source);
        if (source === undefined) {
            omittedDiscoveredEntry = true;
            return [];
        }
        const nameCandidate = v.safeParse(
            v.pipe(v.string(), v.maxLength(128), v.check(hasNoUnicodeControlOrFormat)),
            skill.name
        ).success
            ? skill.name
            : skill.skillKey;
        const description = skill.description;
        const includeDescription =
            description !== undefined &&
            description.length <= 1024 &&
            /\S/u.test(description) &&
            hasNoUnicodeControlOrFormat(description);
        return [
            {
                bundled: skill.bundled,
                ...(includeDescription ? { description } : {}),
                eligible: skill.eligible,
                enabled: !skill.disabled,
                installed: true,
                key: skill.skillKey,
                name: nameCandidate,
                source,
            },
        ];
    });
    const byKey = new Map(discovered.map((skill) => [skill.key, skill]));
    let omittedConfiguredEntry = false;
    for (const [key, entry] of Object.entries(configuredEntries ?? {})) {
        if (observedKeys.has(key)) continue;
        if (!v.safeParse(openClawSkillKeySchema, key, { abortEarly: true }).success) {
            omittedConfiguredEntry = true;
            continue;
        }
        byKey.set(key, {
            bundled: false,
            eligible: false,
            enabled: entry.enabled !== false,
            installed: false,
            key,
            name: key,
            source: "openclaw-configured",
        });
    }
    const combined = [...byKey.values()].toSorted((left, right) =>
        compareStrings(left.key, right.key)
    );
    const projected = combined.slice(0, openClawSkillMaximum);
    return parseBoundary(listOpenClawSkillsResultSchema, {
        skills: projected,
        truncated:
            omittedConfiguredEntry ||
            omittedDiscoveredEntry ||
            combined.length > projected.length,
    });
}

function configuredSkillsAgentId(
    entries: v.InferOutput<typeof upstreamAgentEntriesSchema> | undefined
): string {
    const configured = Object.entries(entries ?? {});
    if (configured.length === 0) return "main";
    const defaults = configured.filter(([, entry]) => entry.default === true);
    let selected = defaults.length === 1 ? defaults[0] : undefined;
    if (selected === undefined) {
        selected = configured.find(([agentId]) => agentId === "main");
    }
    if (selected === undefined && configured.length === 1) {
        selected = configured[0];
    }
    if (selected === undefined) {
        throw new OpenClawSettingsProviderError("data-invalid");
    }
    return selected[0];
}

function updatedAgentToolPolicyList(
    values: readonly string[],
    toolId: ReviewedAgentToolId,
    include: boolean
): readonly string[] {
    const preserved = values.filter((value) => reviewedAgentToolId(value) !== toolId);
    return include ? [...preserved, toolId] : preserved;
}

function buildPatch(
    update: OpenClawConfigurationUpdate,
    upstream: v.InferOutput<typeof upstreamConfigurationSchema>
): Readonly<{
    matches: (configuration: OpenClawConfigurationSnapshot) => boolean;
    raw: string;
    replacePaths?: readonly string[];
}> {
    let matches: (configuration: OpenClawConfigurationSnapshot) => boolean;
    let patch: Readonly<Record<string, unknown>>;
    let replacePaths: readonly string[] | undefined;
    switch (update.section) {
        case "agent-tool-access": {
            const entry = upstream.agents?.entries?.[update.agentId];
            if (entry === undefined) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            const alsoAllow = updatedAgentToolPolicyList(
                entry.tools?.alsoAllow ?? [],
                update.toolId,
                update.override === "allow"
            );
            const deny = updatedAgentToolPolicyList(
                entry.tools?.deny ?? [],
                update.toolId,
                update.override === "deny"
            );
            if (
                alsoAllow.length > upstreamAgentToolPolicyMaximum ||
                deny.length > upstreamAgentToolPolicyMaximum
            ) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            patch = {
                agents: {
                    entries: {
                        [update.agentId]: { tools: { alsoAllow, deny } },
                    },
                },
            };
            replacePaths = [
                `agents.entries.${update.agentId}.tools.alsoAllow`,
                `agents.entries.${update.agentId}.tools.deny`,
            ];
            matches = (configuration) =>
                configuration.agentAccess
                    .find(({ id }) => id === update.agentId)
                    ?.tools.find(({ id }) => id === update.toolId)?.override ===
                update.override;
            break;
        }
        case "channels": {
            const changedChannels = update.channels.filter(
                ({ enabled, id }) =>
                    (upstream.channels?.[id]?.enabled !== false) !== enabled
            );
            if (changedChannels.length === 0) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            patch = {
                channels: Object.fromEntries(
                    changedChannels.map(({ enabled, id }) => [id, { enabled }])
                ),
            };
            matches = (configuration) =>
                changedChannels.every(({ enabled, id }) =>
                    configuration.channels.some(
                        (channel) => channel.id === id && channel.enabled === enabled
                    )
                );
            break;
        }
        case "heartbeat": {
            const heartbeatConfiguration = configuredHeartbeat(upstream.agents);
            const currentEverySeconds = heartbeatSeconds(
                heartbeatConfiguration.heartbeat?.every
            );
            const currentTarget = optionalNonBlankUpstreamText(
                heartbeatConfiguration.heartbeat?.target
            );
            const target = update.target ?? undefined;
            const everyChanged = currentEverySeconds !== update.everySeconds;
            const targetChanged = currentTarget !== target;
            if (!everyChanged && !targetChanged) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            const heartbeatPatch = {
                ...(everyChanged ? { every: `${update.everySeconds}s` } : {}),
                ...(targetChanged ? { target: update.target } : {}),
            };
            patch =
                heartbeatConfiguration.ownerAgentId === undefined
                    ? { agents: { defaults: { heartbeat: heartbeatPatch } } }
                    : {
                          agents: {
                              entries: {
                                  [heartbeatConfiguration.ownerAgentId]: {
                                      heartbeat: heartbeatPatch,
                                  },
                              },
                          },
                      };
            matches = (configuration) =>
                (!everyChanged ||
                    configuration.heartbeat.everySeconds === update.everySeconds) &&
                (!targetChanged || configuration.heartbeat.target === target);
            break;
        }
        case "models": {
            const rawModel = upstream.agents?.defaults?.model;
            const currentPrimary =
                typeof rawModel === "string" ? rawModel : rawModel?.primary;
            const currentFallbacks =
                typeof rawModel === "string" ? [] : (rawModel?.fallbacks ?? []);
            const primaryChanged = currentPrimary !== update.primary;
            const fallbacksChanged = !isDeepStrictEqual(
                currentFallbacks,
                update.fallbacks
            );
            if (!primaryChanged && !fallbacksChanged) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            const writePrimary =
                primaryChanged || (typeof rawModel === "string" && fallbacksChanged);
            const primary = writePrimary
                ? validatedSubmittedModelRef(
                      primaryChanged ? update.primary : (currentPrimary ?? update.primary)
                  )
                : undefined;
            const fallbacks = fallbacksChanged
                ? update.fallbacks.map(validatedSubmittedModelRef)
                : undefined;
            if (fallbacks !== undefined && new Set(fallbacks).size !== fallbacks.length) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            patch = {
                agents: {
                    defaults: {
                        model: {
                            ...(fallbacks === undefined ? {} : { fallbacks }),
                            ...(primary === undefined ? {} : { primary }),
                        },
                    },
                },
            };
            if (fallbacksChanged) {
                replacePaths = ["agents.defaults.model.fallbacks"];
            }
            matches = (configuration) =>
                (!writePrimary || configuration.models.primary === primary) &&
                (!fallbacksChanged ||
                    isDeepStrictEqual(configuration.models.fallbacks, fallbacks));
            break;
        }
        case "session-reset": {
            const current = projectSessionReset(upstream.session?.reset);
            if (
                "idleMinutes" in current &&
                current.idleMinutes === update.idleMinutes &&
                "mode" in current &&
                current.mode === update.mode &&
                (update.mode !== "daily" ||
                    ("atHour" in current && current.atHour === (update.atHour ?? 0)))
            ) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            patch = {
                session: {
                    reset: {
                        atHour: update.mode === "daily" ? (update.atHour ?? 0) : null,
                        idleMinutes: update.idleMinutes,
                        mode: update.mode,
                    },
                },
            };
            matches = (configuration) =>
                "idleMinutes" in configuration.sessionReset &&
                configuration.sessionReset.idleMinutes === update.idleMinutes &&
                "mode" in configuration.sessionReset &&
                configuration.sessionReset.mode === update.mode &&
                (update.mode !== "daily" ||
                    ("atHour" in configuration.sessionReset &&
                        configuration.sessionReset.atHour === (update.atHour ?? 0)));
            break;
        }
        case "tools": {
            const current = projectToolSettings(upstream.tools);
            const toolsPatch: Record<string, unknown> = {};
            const agentToAgentChanged =
                current.agentToAgentEnabled !== update.settings.agentToAgentEnabled;
            const elevatedChanged =
                current.elevatedEnabled !== update.settings.elevatedEnabled;
            const execChanged = !isDeepStrictEqual(
                current.execPolicy,
                update.settings.execPolicy
            );
            const profileChanged = current.profile !== update.settings.profile;
            const visibilityChanged =
                current.sessionsVisibility !== update.settings.sessionsVisibility;
            const webFetchChanged =
                current.webFetchEnabled !== update.settings.webFetchEnabled;
            const webSearchEnabledChanged =
                current.webSearchEnabled !== update.settings.webSearchEnabled;
            const webSearchProviderChanged =
                current.webSearchProvider !== update.settings.webSearchProvider;
            if (agentToAgentChanged) {
                toolsPatch.agentToAgent = {
                    enabled: update.settings.agentToAgentEnabled,
                };
            }
            if (elevatedChanged) {
                toolsPatch.elevated = { enabled: update.settings.elevatedEnabled };
            }
            if (execChanged) {
                if (
                    current.execPolicy.state === "legacy-mode" &&
                    update.settings.execPolicy.state === "legacy-mode"
                ) {
                    toolsPatch.exec = { mode: update.settings.execPolicy.mode };
                } else if (
                    current.execPolicy.state === "explicit" &&
                    update.settings.execPolicy.state === "explicit"
                ) {
                    toolsPatch.exec = {
                        ask: update.settings.execPolicy.ask,
                        security: update.settings.execPolicy.security,
                    };
                } else {
                    throw new OpenClawSettingsProviderError("data-invalid");
                }
            }
            if (profileChanged) {
                toolsPatch.profile = update.settings.profile ?? null;
            }
            if (visibilityChanged) {
                toolsPatch.sessions = {
                    visibility: update.settings.sessionsVisibility ?? null,
                };
            }
            const webPatch: Record<string, unknown> = {};
            if (webFetchChanged) {
                webPatch.fetch = { enabled: update.settings.webFetchEnabled };
            }
            if (webSearchEnabledChanged || webSearchProviderChanged) {
                webPatch.search = {
                    ...(webSearchEnabledChanged
                        ? { enabled: update.settings.webSearchEnabled }
                        : {}),
                    ...(webSearchProviderChanged
                        ? {
                              provider: update.settings.webSearchProvider ?? null,
                          }
                        : {}),
                };
            }
            if (Object.keys(webPatch).length > 0) toolsPatch.web = webPatch;
            if (Object.keys(toolsPatch).length === 0) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            patch = { tools: toolsPatch };
            matches = (configuration) =>
                (!agentToAgentChanged ||
                    configuration.tools.agentToAgentEnabled ===
                        update.settings.agentToAgentEnabled) &&
                (!elevatedChanged ||
                    configuration.tools.elevatedEnabled ===
                        update.settings.elevatedEnabled) &&
                (!execChanged ||
                    isDeepStrictEqual(
                        configuration.tools.execPolicy,
                        update.settings.execPolicy
                    )) &&
                (!profileChanged ||
                    configuration.tools.profile === update.settings.profile) &&
                (!visibilityChanged ||
                    configuration.tools.sessionsVisibility ===
                        update.settings.sessionsVisibility) &&
                (!webFetchChanged ||
                    configuration.tools.webFetchEnabled ===
                        update.settings.webFetchEnabled) &&
                (!webSearchEnabledChanged ||
                    configuration.tools.webSearchEnabled ===
                        update.settings.webSearchEnabled) &&
                (!webSearchProviderChanged ||
                    configuration.tools.webSearchProvider ===
                        update.settings.webSearchProvider);
            break;
        }
    }
    const raw = JSON.stringify(patch);
    if (
        Buffer.byteLength(raw, "utf8") >
        persistentGatewayOpenClawSettingsPatchMaximumBytes
    ) {
        throw new OpenClawSettingsProviderError("data-invalid");
    }
    return {
        matches,
        raw,
        ...(replacePaths === undefined ? {} : { replacePaths }),
    };
}

function channelsMatchFreshConfiguration(
    configuration: OpenClawConfigurationSnapshot,
    update: Extract<OpenClawConfigurationUpdate, { readonly section: "channels" }>
): boolean {
    return (
        configuration.channels.length === update.channels.length &&
        configuration.channels.every(({ id }, index) => id === update.channels[index]?.id)
    );
}

function skillMutationResult(
    enabled: boolean,
    skillKey: string,
    reason: "data-invalid" | "unknown-outcome" = "unknown-outcome"
): OpenClawSettingsProviderSetSkillEnabledResult {
    return parseBoundary(
        setOpenClawSkillEnabledResultSchema,
        { enabled, skillKey },
        reason
    );
}

function skillPatchReadbackMatches(
    configuration: v.InferOutput<typeof upstreamConfigurationSchema>,
    skillKey: string,
    enabled: boolean
): boolean {
    return configuration.skills?.entries?.[skillKey]?.enabled === enabled;
}

function assertConfigPatchIsSafe(configuration: OpenClawConfigurationSnapshot): void {
    if (
        configuration.includesPresent ||
        configuration.modelNormalizationState !== "clean"
    ) {
        throw new OpenClawSettingsProviderError("data-invalid");
    }
}

/**
 * Creates the only raw-config-aware adapter for the OpenClaw Settings domain.
 * @param transport Dedicated, method-narrow Gateway Settings lanes.
 * @returns A secret-free high-level Settings provider.
 */
export function createPersistentGatewayOpenClawSettingsProvider(
    transport: PersistentGatewayOpenClawSettingsTransport
): OpenClawSettingsProvider {
    async function loadConfiguration(
        signal: AbortSignal | undefined
    ): Promise<InternalConfigurationSnapshot> {
        const bytes = createByteObservation(openClawConfigurationUpstreamMaximumBytes);
        const payload = await transport.requestOpenClawSettingsRead(
            "config.get",
            {},
            requestOptions(
                signal,
                persistentGatewayOpenClawSettingsReadTimeoutMs,
                bytes.observe
            )
        );
        bytes.assertWithinBudget("data-invalid");
        const response = parseBoundary(upstreamConfigGetResponseSchema, payload);
        const upstream = parseBoundary(upstreamConfigurationSchema, response.config);
        return Object.freeze({
            configuration: projectConfiguration(
                upstream,
                response.hash,
                response.configRevisionHash,
                response.includedPaths.length > 0,
                inspectModelNormalizationState(
                    response.sourceConfig,
                    response.config,
                    response.parsed
                ),
                rawChannelsWereTruncated(response.config),
                response.valid,
                response.issues.length + response.legacyIssues.length
            ),
            upstream,
        });
    }

    async function loadSkills(
        signal: AbortSignal | undefined,
        agentId: string,
        configuredEntries:
            | v.InferOutput<typeof upstreamConfiguredSkillEntriesSchema>
            | undefined
    ): Promise<ListOpenClawSkillsResult> {
        const bytes = createByteObservation(openClawSkillsUpstreamMaximumBytes);
        const payload = await transport.requestOpenClawSettingsRead(
            "skills.status",
            { agentId },
            requestOptions(
                signal,
                persistentGatewayOpenClawSettingsReadTimeoutMs,
                bytes.observe
            )
        );
        bytes.assertWithinBudget("data-invalid");
        return projectSkills(
            parseBoundary(upstreamSkillsStatusResponseSchema, payload),
            configuredEntries
        );
    }

    async function authorizeRevisionBoundDispatch(input: {
        readonly authorizeDispatch: () => Promise<void>;
        readonly baseHash: string;
        readonly baseRevisionHash: string;
        readonly requireSafeConfigPatch: boolean;
        readonly signal: AbortSignal | undefined;
    }): Promise<void> {
        const latest = await loadConfiguration(input.signal);
        if (!latest.configuration.valid) {
            throw new OpenClawSettingsProviderError("data-invalid");
        }
        if (
            latest.configuration.hash !== input.baseHash ||
            latest.configuration.revisionHash !== input.baseRevisionHash
        ) {
            throw new OpenClawSettingsProviderError("conflict");
        }
        if (input.requireSafeConfigPatch) {
            assertConfigPatchIsSafe(latest.configuration);
        }
        await input.authorizeDispatch();
    }

    async function loadMutationReadback(): Promise<InternalConfigurationSnapshot> {
        try {
            return await loadConfiguration(undefined);
        } catch {
            throw new OpenClawSettingsProviderError("unknown-outcome");
        }
    }

    async function getConfiguration(
        request: OpenClawSettingsProviderRequest
    ): Promise<OpenClawConfigurationSnapshot> {
        return await providerOperation(false, async () => {
            const snapshot = await loadConfiguration(request.signal);
            return snapshot.configuration;
        });
    }

    async function listSkills(
        request: OpenClawSettingsProviderRequest
    ): Promise<ListOpenClawSkillsResult> {
        return await providerOperation(false, async () => {
            const configuration = await loadConfiguration(request.signal);
            return await loadSkills(
                request.signal,
                configuredSkillsAgentId(configuration.upstream.agents?.entries),
                configuration.upstream.skills?.entries
            );
        });
    }

    async function updateConfiguration(
        request: OpenClawSettingsProviderUpdateConfigurationRequest
    ): Promise<UpdateOpenClawConfigurationResult> {
        return await providerOperation(true, async () => {
            const { authorizeDispatch, signal, ...rawInput } = request;
            const input = parseBoundary(updateOpenClawConfigurationInputSchema, rawInput);
            const current = await loadConfiguration(signal);
            if (!current.configuration.valid) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            if (
                current.configuration.hash !== input.baseHash ||
                current.configuration.revisionHash !== input.baseRevisionHash
            ) {
                throw new OpenClawSettingsProviderError("conflict");
            }
            assertConfigPatchIsSafe(current.configuration);
            if (
                input.update.section === "channels" &&
                !channelsMatchFreshConfiguration(current.configuration, input.update)
            ) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            if (
                input.update.section === "agent-tool-access" &&
                !agentToolUpdateIsAdmitted(current.upstream, input.update)
            ) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            const patch = buildPatch(input.update, current.upstream);
            const bytes = createByteObservation(
                openClawConfigurationUpstreamMaximumBytes
            );
            // A config.get readback cannot recover the ACK-only restart requirement and
            // scheduling fields. Preserve post-dispatch uncertainty so the browser keeps
            // controls locked until its explicit full-state reconciliation completes.
            let payload: unknown;
            try {
                payload = await transport.requestOpenClawSettingsWrite(
                    "config.patch",
                    {
                        baseHash: input.baseHash,
                        note: "Updated from Mira Dashboard settings",
                        raw: patch.raw,
                        ...(patch.replacePaths === undefined
                            ? {}
                            : { replacePaths: patch.replacePaths }),
                    },
                    {
                        ...requestOptions(
                            signal,
                            persistentGatewayOpenClawSettingsWriteTimeoutMs,
                            bytes.observe
                        ),
                        beforeDispatch: beforeMutationDispatch(() =>
                            authorizeRevisionBoundDispatch({
                                authorizeDispatch,
                                baseHash: input.baseHash,
                                baseRevisionHash: input.baseRevisionHash,
                                requireSafeConfigPatch: true,
                                signal,
                            })
                        ),
                    }
                );
            } catch (error) {
                if (configMutationOutcomeIsUncertain(error)) {
                    throw new OpenClawSettingsProviderError("unknown-outcome");
                }
                throw error;
            }
            bytes.assertWithinBudget("unknown-outcome");
            const acknowledgement = parseBoundary(
                upstreamConfigPatchResponseSchema,
                payload,
                "unknown-outcome"
            );
            if (acknowledgement.noop === true) {
                const readback = await loadMutationReadback();
                if (
                    !readback.configuration.valid ||
                    !patch.matches(readback.configuration)
                ) {
                    throw new OpenClawSettingsProviderError("unknown-outcome");
                }
                return parseBoundary(
                    updateOpenClawConfigurationResultSchema,
                    {
                        changed: false,
                        configuration: readback.configuration,
                        restartRequired: false,
                        restartScheduled: false,
                    },
                    "unknown-outcome"
                );
            }
            if (
                acknowledgement.hash === undefined ||
                acknowledgement.sentinel === undefined
            ) {
                throw new OpenClawSettingsProviderError("unknown-outcome");
            }
            const readback = await loadMutationReadback();
            if (
                !readback.configuration.valid ||
                readback.configuration.hash !== acknowledgement.hash ||
                (readback.configuration.hash === input.baseHash &&
                    readback.configuration.revisionHash === input.baseRevisionHash) ||
                !patch.matches(readback.configuration)
            ) {
                throw new OpenClawSettingsProviderError("unknown-outcome");
            }
            return parseBoundary(
                updateOpenClawConfigurationResultSchema,
                {
                    changed: true,
                    configuration: readback.configuration,
                    restartRequired:
                        acknowledgement.sentinel.payload.stats.requiresRestart,
                    restartScheduled: acknowledgement.restart !== undefined,
                },
                "unknown-outcome"
            );
        });
    }

    async function setSkillEnabled(
        request: OpenClawSettingsProviderSetSkillEnabledRequest
    ): Promise<OpenClawSettingsProviderSetSkillEnabledResult> {
        return await providerOperation(true, async () => {
            const { authorizeDispatch, signal, ...rawInput } = request;
            const input = parseBoundary(setOpenClawSkillEnabledInputSchema, rawInput);
            const current = await loadConfiguration(signal);
            if (!current.configuration.valid) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            if (
                current.configuration.hash !== input.baseHash ||
                current.configuration.revisionHash !== input.baseRevisionHash
            ) {
                throw new OpenClawSettingsProviderError("conflict");
            }
            const configuredEntries = current.upstream.skills?.entries ?? {};
            if (
                !Object.hasOwn(configuredEntries, input.skillKey) &&
                Object.keys(configuredEntries).length >= upstreamConfiguredSkillMaximum
            ) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            const skills = await loadSkills(
                signal,
                configuredSkillsAgentId(current.upstream.agents?.entries),
                current.upstream.skills?.entries
            );
            const installedSkill = skills.skills.find(
                ({ key }) => key === input.skillKey
            );
            if (installedSkill === undefined) {
                throw new OpenClawSettingsProviderError("not-found");
            }
            if (installedSkill.enabled === input.enabled) {
                return skillMutationResult(input.enabled, input.skillKey);
            }
            const bytes = createByteObservation(
                openClawConfigurationUpstreamMaximumBytes
            );
            let payload: unknown;
            try {
                payload = await transport.requestOpenClawSettingsWrite(
                    "skills.update",
                    {
                        enabled: input.enabled,
                        skillKey: input.skillKey,
                    },
                    {
                        ...requestOptions(
                            signal,
                            persistentGatewayOpenClawSettingsWriteTimeoutMs,
                            bytes.observe
                        ),
                        beforeDispatch: beforeMutationDispatch(() =>
                            authorizeRevisionBoundDispatch({
                                authorizeDispatch,
                                baseHash: input.baseHash,
                                baseRevisionHash: input.baseRevisionHash,
                                requireSafeConfigPatch: false,
                                signal,
                            })
                        ),
                    }
                );
            } catch (error) {
                if (!skillMutationNeedsReconciliation(error)) {
                    throw error;
                }
                try {
                    const reconciled = await loadConfiguration(undefined);
                    if (
                        reconciled.configuration.valid &&
                        skillPatchReadbackMatches(
                            reconciled.upstream,
                            input.skillKey,
                            input.enabled
                        )
                    ) {
                        return skillMutationResult(input.enabled, input.skillKey);
                    }
                } catch {
                    // No replay: an inconclusive reconciliation remains unknown.
                }
                throw new OpenClawSettingsProviderError("unknown-outcome");
            }
            bytes.assertWithinBudget("unknown-outcome");
            const acknowledgement = parseBoundary(
                upstreamSkillUpdateResponseSchema,
                payload,
                "unknown-outcome"
            );
            if (
                acknowledgement.skillKey !== input.skillKey ||
                acknowledgement.config.enabled !== input.enabled
            ) {
                throw new OpenClawSettingsProviderError("unknown-outcome");
            }
            const readback = await loadMutationReadback();
            if (
                !readback.configuration.valid ||
                !skillPatchReadbackMatches(
                    readback.upstream,
                    input.skillKey,
                    input.enabled
                )
            ) {
                throw new OpenClawSettingsProviderError("unknown-outcome");
            }
            return skillMutationResult(input.enabled, input.skillKey);
        });
    }

    return Object.freeze({
        getConfiguration,
        listSkills,
        setSkillEnabled,
        updateConfiguration,
    });
}
