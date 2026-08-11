/* oxlint-disable unicorn/max-nested-calls -- Valibot boundary schemas are declarative compositions. */
import { isDeepStrictEqual } from "node:util";

import * as v from "valibot";

import {
    listOpenClawSkillsResultSchema,
    openClawAgentAccessMaximum,
    openClawAgentIdSchema,
    openClawConfigurationSnapshotSchema,
    openClawConfigurationUpstreamMaximumBytes,
    openClawConfigHashSchema,
    openClawModelFallbackMaximum,
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
const upstreamConfiguredSkillEntriesSchema = v.pipe(
    v.record(v.string(), v.object({ enabled: v.optional(v.boolean()) })),
    v.check((entries) => Object.keys(entries).length <= 4096)
);
const upstreamAgentToolPolicyListSchema = v.pipe(
    v.array(upstreamControlSafeTextSchema(256)),
    v.maxLength(512)
);
const upstreamAgentEntriesSchema = v.pipe(
    v.record(
        v.string(),
        v.object({
            default: v.optional(v.boolean()),
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
                    heartbeat: v.optional(
                        v.object({
                            every: v.optional(upstreamControlSafeTextSchema(128)),
                            target: v.optional(upstreamControlSafeTextSchema(1024)),
                        })
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
                    idleMinutes: v.optional(
                        v.pipe(v.number(), v.safeInteger(), v.minValue(1))
                    ),
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
    config: upstreamConfigurationSchema,
    hash: openClawConfigHashSchema,
    issues: upstreamUnknownArraySchema,
    legacyIssues: upstreamUnknownArraySchema,
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

const upstreamSkillSchema = v.object({
    bundled: v.boolean(),
    description: v.optional(upstreamTextSchema(64 * 1024)),
    disabled: v.boolean(),
    eligible: v.boolean(),
    name: upstreamControlSafeTextSchema(16 * 1024),
    skillKey: openClawSkillKeySchema,
    source: upstreamControlSafeTextSchema(256),
});
const upstreamSkillsStatusResponseSchema = v.object({
    skills: v.pipe(v.array(upstreamSkillSchema), v.maxLength(4096)),
});

interface InternalConfigurationSnapshot {
    readonly configuration: OpenClawConfigurationSnapshot;
    readonly upstream: v.InferOutput<typeof upstreamConfigurationSchema>;
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

function heartbeatSeconds(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const normalized = value.trim().toLowerCase();
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
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            const amount = match[1];
            const unit = match[2] as DurationUnit | undefined;
            if (amount === undefined || unit === undefined) {
                throw new OpenClawSettingsProviderError("data-invalid");
            }
            milliseconds += Number(amount) * unitMilliseconds[unit];
            consumed += match[0].length;
        }
        if (consumed !== normalized.length || consumed === 0) {
            throw new OpenClawSettingsProviderError("data-invalid");
        }
    } else {
        const amount = single[1];
        const unit = (single[2] ?? "m") as DurationUnit;
        if (amount === undefined) {
            throw new OpenClawSettingsProviderError("data-invalid");
        }
        milliseconds = Number(amount) * unitMilliseconds[unit];
    }
    const seconds = milliseconds / 1000;
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
        throw new OpenClawSettingsProviderError("data-invalid");
    }
    return seconds;
}

function projectExecSettings(
    exec:
        | NonNullable<
              NonNullable<
                  v.InferOutput<typeof upstreamConfigurationSchema>["tools"]
              >["exec"]
          >
        | undefined
): Readonly<{
    execAsk: "off" | "on-miss" | "always";
    execSecurity: "allowlist" | "deny" | "full";
}> {
    switch (exec?.mode) {
        case "deny": {
            return { execAsk: "off", execSecurity: "deny" };
        }
        case "allowlist": {
            return { execAsk: "off", execSecurity: "allowlist" };
        }
        case "ask":
        case "auto": {
            return { execAsk: "on-miss", execSecurity: "allowlist" };
        }
        case "full": {
            return { execAsk: "off", execSecurity: "full" };
        }
        default: {
            return {
                execAsk: exec?.ask ?? "always",
                execSecurity: exec?.security ?? "deny",
            };
        }
    }
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
            (foldedCounts.get(id) ?? 0) !== 1;
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
            v.pipe(v.string(), v.maxLength(64), v.check(hasNoUnicodeControlOrFormat)),
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
    const sorted = projected.toSorted((left, right) => compareStrings(left.id, right.id));
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
    if (
        defaults.length !== 1 ||
        !v.safeParse(openClawAgentIdSchema, defaults[0]?.[0], {
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

function projectConfiguration(
    upstream: v.InferOutput<typeof upstreamConfigurationSchema>,
    hash: string,
    valid: boolean,
    issueCount: number,
    reason: "data-invalid" | "unknown-outcome" = "data-invalid"
): OpenClawConfigurationSnapshot {
    const rawModel = upstream.agents?.defaults?.model;
    const primary = typeof rawModel === "string" ? rawModel : rawModel?.primary;
    const fallbacks = typeof rawModel === "string" ? [] : (rawModel?.fallbacks ?? []);
    const exec = projectExecSettings(upstream.tools?.exec);
    const visibility = upstream.tools?.sessions?.visibility;
    const channels = Object.entries(upstream.channels ?? {})
        .map(([id, channel]) => ({ enabled: channel.enabled === true, id }))
        .toSorted((left, right) => compareStrings(left.id, right.id));
    const agentAccess = projectAgentAccess(upstream.agents?.entries);
    return parseBoundary(
        openClawConfigurationSnapshotSchema,
        {
            agentAccess: agentAccess.agents,
            agentAccessTruncated: agentAccess.truncated,
            channels,
            hash,
            heartbeat: {
                ...(upstream.agents?.defaults?.heartbeat?.every === undefined
                    ? {}
                    : {
                          everySeconds: heartbeatSeconds(
                              upstream.agents.defaults.heartbeat.every
                          ),
                      }),
                ...(upstream.agents?.defaults?.heartbeat?.target === undefined
                    ? {}
                    : { target: upstream.agents.defaults.heartbeat.target }),
            },
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
                ...(primary === undefined ? {} : { primary }),
            },
            security: {
                authProfileCount: Object.keys(upstream.auth?.profiles ?? {}).length,
                commandRestartEnabled: upstream.commands?.restart ?? true,
                ownerAllowFromCount: upstream.commands?.ownerAllowFrom?.length ?? 0,
                ...(upstream.logging?.redactSensitive === undefined
                    ? {}
                    : { redactionMode: upstream.logging.redactSensitive }),
            },
            sessionReset:
                upstream.session?.reset?.idleMinutes === undefined
                    ? {}
                    : { idleMinutes: upstream.session.reset.idleMinutes },
            tools: {
                agentToAgentEnabled: upstream.tools?.agentToAgent?.enabled ?? false,
                elevatedEnabled: upstream.tools?.elevated?.enabled ?? false,
                ...exec,
                ...(upstream.tools?.profile === undefined
                    ? {}
                    : { profile: upstream.tools.profile }),
                ...(visibility === undefined ? {} : { sessionsVisibility: visibility }),
                webFetchEnabled: upstream.tools?.web?.fetch?.enabled ?? true,
                webSearchEnabled: upstream.tools?.web?.search?.enabled ?? true,
                ...(upstream.tools?.web?.search?.provider === undefined
                    ? {}
                    : { webSearchProvider: upstream.tools.web.search.provider }),
            },
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
    const discovered = sorted.map((skill) => {
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
        return {
            bundled: skill.bundled,
            ...(includeDescription ? { description } : {}),
            eligible: skill.eligible,
            enabled: !skill.disabled,
            installed: true,
            key: skill.skillKey,
            name: nameCandidate,
            source: skill.source,
        };
    });
    const byKey = new Map(discovered.map((skill) => [skill.key, skill]));
    let omittedConfiguredEntry = false;
    for (const [key, entry] of Object.entries(configuredEntries ?? {})) {
        if (!v.safeParse(openClawSkillKeySchema, key, { abortEarly: true }).success) {
            omittedConfiguredEntry = true;
            continue;
        }
        if (byKey.has(key)) continue;
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
        truncated: omittedConfiguredEntry || combined.length > projected.length,
    });
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
    raw: string;
    replacePaths?: readonly string[];
}> {
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
            break;
        }
        case "channels": {
            patch = {
                channels: Object.fromEntries(
                    update.channels.map(({ enabled, id }) => [id, { enabled }])
                ),
            };
            break;
        }
        case "heartbeat": {
            patch = {
                agents: {
                    defaults: {
                        heartbeat: {
                            every: `${update.everySeconds}s`,
                            target: update.target,
                        },
                    },
                },
            };
            break;
        }
        case "models": {
            patch = {
                agents: {
                    defaults: {
                        model: {
                            fallbacks: update.fallbacks,
                            primary: update.primary,
                        },
                    },
                },
            };
            replacePaths = ["agents.defaults.model.fallbacks"];
            break;
        }
        case "session-reset": {
            patch = { session: { reset: { idleMinutes: update.idleMinutes } } };
            break;
        }
        case "tools": {
            patch = {
                tools: {
                    agentToAgent: { enabled: update.settings.agentToAgentEnabled },
                    elevated: { enabled: update.settings.elevatedEnabled },
                    exec: {
                        ask: update.settings.execAsk,
                        mode: null,
                        security: update.settings.execSecurity,
                    },
                    profile: update.settings.profile ?? null,
                    sessions: {
                        visibility: update.settings.sessionsVisibility ?? null,
                    },
                    web: {
                        fetch: { enabled: update.settings.webFetchEnabled },
                        search: {
                            enabled: update.settings.webSearchEnabled,
                            provider: update.settings.webSearchProvider ?? null,
                        },
                    },
                },
            };
            break;
        }
    }
    return {
        raw: JSON.stringify(patch),
        ...(replacePaths === undefined ? {} : { replacePaths }),
    };
}

function configurationMatchesUpdate(
    configuration: OpenClawConfigurationSnapshot,
    update: OpenClawConfigurationUpdate
): boolean {
    switch (update.section) {
        case "agent-tool-access": {
            return (
                configuration.agentAccess
                    .find(({ id }) => id === update.agentId)
                    ?.tools.find(({ id }) => id === update.toolId)?.override ===
                update.override
            );
        }
        case "channels": {
            return isDeepStrictEqual(configuration.channels, update.channels);
        }
        case "heartbeat": {
            return isDeepStrictEqual(configuration.heartbeat, {
                everySeconds: update.everySeconds,
                ...(update.target === null ? {} : { target: update.target }),
            });
        }
        case "models": {
            return isDeepStrictEqual(configuration.models, {
                fallbacks: update.fallbacks,
                primary: update.primary,
            });
        }
        case "session-reset": {
            return isDeepStrictEqual(configuration.sessionReset, {
                idleMinutes: update.idleMinutes,
            });
        }
        case "tools": {
            return isDeepStrictEqual(configuration.tools, update.settings);
        }
    }
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
        const upstream = parseBoundary(upstreamConfigGetResponseSchema, payload);
        return Object.freeze({
            configuration: projectConfiguration(
                upstream.config,
                upstream.hash,
                upstream.valid,
                upstream.issues.length + upstream.legacyIssues.length
            ),
            upstream: upstream.config,
        });
    }

    async function loadSkills(
        signal: AbortSignal | undefined,
        configuredEntries:
            | v.InferOutput<typeof upstreamConfiguredSkillEntriesSchema>
            | undefined
    ): Promise<ListOpenClawSkillsResult> {
        const bytes = createByteObservation(openClawSkillsUpstreamMaximumBytes);
        const payload = await transport.requestOpenClawSettingsRead(
            "skills.status",
            {},
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
            if (current.configuration.hash !== input.baseHash) {
                throw new OpenClawSettingsProviderError("conflict");
            }
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
            const payload = await transport.requestOpenClawSettingsWrite(
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
                    beforeDispatch: beforeMutationDispatch(authorizeDispatch),
                }
            );
            bytes.assertWithinBudget("unknown-outcome");
            const acknowledgement = parseBoundary(
                upstreamConfigPatchResponseSchema,
                payload,
                "unknown-outcome"
            );
            if (acknowledgement.noop === true) {
                if (!configurationMatchesUpdate(current.configuration, input.update)) {
                    throw new OpenClawSettingsProviderError("unknown-outcome");
                }
                return parseBoundary(
                    updateOpenClawConfigurationResultSchema,
                    {
                        changed: false,
                        configuration: current.configuration,
                        restartRequired: false,
                        restartScheduled: false,
                    },
                    "unknown-outcome"
                );
            }
            if (
                acknowledgement.hash === undefined ||
                acknowledgement.hash === input.baseHash ||
                acknowledgement.sentinel === undefined
            ) {
                throw new OpenClawSettingsProviderError("unknown-outcome");
            }
            const configuration = projectConfiguration(
                acknowledgement.config,
                acknowledgement.hash,
                true,
                0,
                "unknown-outcome"
            );
            if (!configurationMatchesUpdate(configuration, input.update)) {
                throw new OpenClawSettingsProviderError("unknown-outcome");
            }
            return parseBoundary(
                updateOpenClawConfigurationResultSchema,
                {
                    changed: true,
                    configuration,
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
            if (current.configuration.hash !== input.baseHash) {
                throw new OpenClawSettingsProviderError("conflict");
            }
            const skills = await loadSkills(signal, current.upstream.skills?.entries);
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
                    "config.patch",
                    {
                        baseHash: input.baseHash,
                        note: "Updated from Mira Dashboard settings",
                        raw: JSON.stringify({
                            skills: {
                                entries: {
                                    [input.skillKey]: { enabled: input.enabled },
                                },
                            },
                        }),
                    },
                    {
                        ...requestOptions(
                            signal,
                            persistentGatewayOpenClawSettingsWriteTimeoutMs,
                            bytes.observe
                        ),
                        beforeDispatch: beforeMutationDispatch(authorizeDispatch),
                    }
                );
            } catch (error) {
                if (!(error instanceof PersistentGatewayUnknownOutcomeError)) {
                    throw error;
                }
                try {
                    const reconciled = await loadConfiguration(undefined);
                    if (
                        reconciled.configuration.valid &&
                        reconciled.configuration.hash !== input.baseHash &&
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
                upstreamConfigPatchResponseSchema,
                payload,
                "unknown-outcome"
            );
            if (
                !skillPatchReadbackMatches(
                    acknowledgement.config,
                    input.skillKey,
                    input.enabled
                )
            ) {
                throw new OpenClawSettingsProviderError("unknown-outcome");
            }
            if (
                acknowledgement.noop !== true &&
                (acknowledgement.hash === undefined ||
                    acknowledgement.hash === input.baseHash ||
                    acknowledgement.sentinel === undefined)
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
