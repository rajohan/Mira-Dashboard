import * as v from "valibot";

import {
    type GatewaySession,
    type GatewaySessionKind,
    type GatewaySessionOmissibleMetadataField,
    gatewaySessionChannelMaximum,
    gatewaySessionDisplayNameMaximum,
    gatewaySessionIdSchema,
    gatewaySessionKeySchema,
    gatewaySessionModelMaximum,
    gatewaySessionOmissibleMetadataFields,
    gatewaySessionPreferenceMaximum,
    gatewaySessionProjectionMaximum,
    gatewaySessionProviderMaximum,
    gatewaySessionSchema,
    gatewaySessionThinkingLevelLabelMaximum,
} from "../../../contracts/gatewaySessions.ts";
import { timestampMillisecondsSchema } from "../../../shared/dateTime.ts";
import {
    hasNoUnicodeControlOrFormat,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import {
    GatewaySessionProviderAbortError,
    GatewaySessionProviderConflictError,
    GatewaySessionProviderNotFoundError,
    GatewaySessionProviderUnknownOutcomeError,
    GatewaySessionProviderUnavailableError,
    type GatewaySessionProviderActionRequest,
    type GatewaySessionProviderCompactOutcome,
    type GatewaySessionProviderDeleteRequest,
    type GatewaySessionProviderRequest,
    type GatewaySessionProviderSnapshot,
    type GatewaySessionsProvider,
} from "../../domains/gatewaySessions/provider.ts";
import {
    PersistentGatewayAbortError,
    PersistentGatewayRequestError,
    PersistentGatewayUnknownOutcomeError,
    persistentGatewaySessionChangedReason,
    type PersistentGatewayRequestOptions,
    type PersistentGatewayTransport,
} from "./persistentGatewayTransport.ts";

/** Read deadline for one bounded current-session projection. */
export const persistentGatewaySessionsListTimeoutMs = 15_000;

/** Control deadline for reset and transcript deletion. */
export const persistentGatewaySessionControlTimeoutMs = 60_000;

/** Manual compaction can include a provider turn and receives the transport maximum. */
export const persistentGatewaySessionCompactionTimeoutMs = 5 * 60_000;

export type PersistentGatewaySessionsTransport = Pick<
    PersistentGatewayTransport,
    "request" | "requestAdmin"
>;

const upstreamTextSchema = (maximumLength: number, message: string) =>
    v.pipe(
        v.string(message),
        v.check((value) => codePointLength(value) <= maximumLength, message),
        v.check(hasNoUnicodeControlOrFormat, message)
    );

/** Wider than every browser projection field while retaining a finite read budget. */
const upstreamMetadataTextMaximum = 16 * 1024;
const upstreamOptionalLabelSchema = v.optional(
    upstreamTextSchema(upstreamMetadataTextMaximum, "Gateway session label is invalid")
);
const upstreamOptionalModelSchema = v.optional(
    upstreamTextSchema(upstreamMetadataTextMaximum, "Gateway session model is invalid")
);
const upstreamOptionalProviderSchema = v.optional(
    upstreamTextSchema(upstreamMetadataTextMaximum, "Gateway session provider is invalid")
);
const upstreamOptionalChannelSchema = v.optional(
    upstreamTextSchema(upstreamMetadataTextMaximum, "Gateway session channel is invalid")
);
const upstreamOptionalKeySchema = v.optional(gatewaySessionKeySchema);
const upstreamOptionalPreferenceSchema = v.optional(
    upstreamTextSchema(
        upstreamMetadataTextMaximum,
        "Gateway session preference is invalid"
    )
);
const upstreamNonnegativeIntegerSchema = nonnegativeSafeIntegerSchema(
    "Gateway session response count is invalid"
);
const upstreamPositiveIntegerSchema = v.pipe(
    upstreamNonnegativeIntegerSchema,
    v.minValue(1, "Gateway session response limit is invalid")
);
const providerLimitSchema = v.pipe(
    upstreamPositiveIntegerSchema,
    v.maxValue(
        gatewaySessionProjectionMaximum,
        "Gateway session projection is outside its budget"
    )
);
const upstreamPathSchema = upstreamTextSchema(
    4096,
    "Gateway session response path is invalid"
);
const upstreamCompactReasonSchema = upstreamTextSchema(
    512,
    "Gateway session compaction reason is invalid"
);

const upstreamSessionRowSchema = v.object({
    activeRunIds: v.optional(
        v.pipe(
            v.array(upstreamTextSchema(256, "Gateway active run id is invalid")),
            v.maxLength(32, "Gateway active run ids are outside their budget")
        )
    ),
    channel: upstreamOptionalChannelSchema,
    contextTokens: v.optional(
        positiveSafeIntegerSchema("Gateway session context-token count is invalid")
    ),
    createdAt: v.optional(
        timestampMillisecondsSchema("Gateway session creation timestamp is invalid")
    ),
    createdVia: v.optional(
        v.picklist([
            "operator",
            "spawn",
            "channel",
            "cron",
            "talk",
            "run",
            "plugin",
            "internal",
        ])
    ),
    displayName: upstreamOptionalLabelSchema,
    effectiveFastMode: v.optional(v.union([v.boolean(), v.literal("auto")])),
    elevatedLevel: upstreamOptionalPreferenceSchema,
    endedAt: v.optional(
        timestampMillisecondsSchema("Gateway session end timestamp is invalid")
    ),
    fastMode: v.optional(v.union([v.boolean(), v.literal("auto")])),
    hasActiveRun: v.optional(v.boolean()),
    key: gatewaySessionKeySchema,
    kind: v.picklist(["direct", "group", "global", "unknown"]),
    label: upstreamOptionalLabelSchema,
    model: upstreamOptionalModelSchema,
    modelProvider: upstreamOptionalProviderSchema,
    parentSessionKey: upstreamOptionalKeySchema,
    reasoningLevel: upstreamOptionalPreferenceSchema,
    runtimeMs: v.optional(
        nonnegativeSafeIntegerSchema("Gateway session runtime is invalid")
    ),
    sessionId: v.optional(gatewaySessionIdSchema),
    spawnedBy: upstreamOptionalKeySchema,
    startedAt: v.optional(
        timestampMillisecondsSchema("Gateway session start timestamp is invalid")
    ),
    status: v.optional(v.picklist(["running", "done", "failed", "killed", "timeout"])),
    thinkingDefault: upstreamOptionalPreferenceSchema,
    thinkingLevel: upstreamOptionalPreferenceSchema,
    thinkingLevels: v.optional(
        v.pipe(
            v.array(
                v.strictObject({
                    id: upstreamTextSchema(
                        upstreamMetadataTextMaximum,
                        "Gateway thinking-level id is invalid"
                    ),
                    label: upstreamTextSchema(
                        upstreamMetadataTextMaximum,
                        "Gateway thinking-level label is invalid"
                    ),
                })
            ),
            v.maxLength(32, "Gateway thinking levels are outside their budget")
        )
    ),
    thinkingOptions: v.optional(
        v.pipe(
            v.array(
                upstreamTextSchema(
                    upstreamMetadataTextMaximum,
                    "Gateway thinking option is invalid"
                )
            ),
            v.maxLength(32, "Gateway thinking options are outside their budget")
        )
    ),
    totalTokens: v.optional(
        nonnegativeSafeIntegerSchema("Gateway session token count is invalid")
    ),
    totalTokensFresh: v.optional(v.boolean()),
    updatedAt: v.optional(
        v.nullable(timestampMillisecondsSchema("Gateway session timestamp is invalid"))
    ),
    verboseLevel: upstreamOptionalPreferenceSchema,
});

const upstreamSessionsListResponseSchema = v.strictObject({
    count: upstreamNonnegativeIntegerSchema,
    creators: v.array(v.unknown()),
    defaults: v.unknown(),
    hasMore: v.boolean(),
    limitApplied: upstreamPositiveIntegerSchema,
    nextOffset: v.nullable(upstreamNonnegativeIntegerSchema),
    offset: v.optional(v.nullable(upstreamNonnegativeIntegerSchema)),
    path: upstreamPathSchema,
    sessions: v.pipe(
        v.array(upstreamSessionRowSchema),
        v.maxLength(
            gatewaySessionProjectionMaximum,
            "Gateway session projection is outside its budget"
        )
    ),
    totalCount: upstreamNonnegativeIntegerSchema,
    ts: timestampMillisecondsSchema("Gateway session response timestamp is invalid"),
});

const upstreamCompactResponseSchema = v.strictObject({
    archived: v.optional(upstreamPathSchema),
    compacted: v.boolean(),
    kept: v.optional(upstreamNonnegativeIntegerSchema),
    key: gatewaySessionKeySchema,
    ok: v.boolean(),
    reason: v.optional(upstreamCompactReasonSchema),
    result: v.optional(v.unknown()),
});

const upstreamResetResponseSchema = v.strictObject({
    deleted: v.optional(v.boolean()),
    entry: v.optional(v.unknown()),
    key: gatewaySessionKeySchema,
    ok: v.literal(true),
    resolved: v.optional(v.unknown()),
});

const upstreamDeleteResponseSchema = v.strictObject({
    archived: v.array(upstreamPathSchema),
    deleted: v.boolean(),
    key: gatewaySessionKeySchema,
    ok: v.literal(true),
    worktreePreserved: v.optional(
        v.strictObject({
            branch: upstreamTextSchema(
                512,
                "Gateway preserved worktree branch is invalid"
            ),
            id: upstreamTextSchema(512, "Gateway preserved worktree id is invalid"),
            path: upstreamPathSchema,
        })
    ),
});

function optionalNonblank(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function codePointLength(value: string): number {
    let length = 0;
    for (const _codePoint of value) length += 1;
    return length;
}

function codePointArray(value: string): string[] {
    const codePoints: string[] = [];
    for (const codePoint of value) codePoints.push(codePoint);
    return codePoints;
}

function projectOptionalMetadata(
    value: string | undefined,
    maximum: number,
    field: GatewaySessionOmissibleMetadataField,
    omissions: Set<GatewaySessionOmissibleMetadataField>
): string | undefined {
    const normalized = optionalNonblank(value);
    if (normalized === undefined) return undefined;
    if (codePointLength(normalized) <= maximum) return normalized;
    omissions.add(field);
    return undefined;
}

function projectDisplayName(session: {
    readonly displayName?: string;
    readonly key: string;
    readonly label?: string;
}): Readonly<{ displayName: string; displayNameTruncated?: true }> {
    const candidate =
        optionalNonblank(session.displayName) ??
        optionalNonblank(session.label) ??
        session.key;
    const codePoints = codePointArray(candidate);
    if (codePoints.length <= gatewaySessionDisplayNameMaximum) {
        return { displayName: candidate };
    }
    return {
        displayName: `${codePoints
            .slice(0, gatewaySessionDisplayNameMaximum - 1)
            .join("")}…`,
        displayNameTruncated: true,
    };
}

function projectThinkingLevels(
    levels: v.InferOutput<typeof upstreamSessionRowSchema>["thinkingLevels"],
    omissions: Set<GatewaySessionOmissibleMetadataField>
): GatewaySession["thinkingLevels"] {
    if (levels === undefined) return undefined;
    const projected = levels.map(({ id, label }) => ({
        id: optionalNonblank(id),
        label: optionalNonblank(label),
    }));
    if (
        projected.some(
            ({ id, label }) =>
                id === undefined ||
                label === undefined ||
                codePointLength(id) > gatewaySessionPreferenceMaximum ||
                codePointLength(label) > gatewaySessionThinkingLevelLabelMaximum
        )
    ) {
        omissions.add("thinkingLevels");
        return undefined;
    }
    return projected as GatewaySession["thinkingLevels"];
}

function projectThinkingOptions(
    options: v.InferOutput<typeof upstreamSessionRowSchema>["thinkingOptions"],
    omissions: Set<GatewaySessionOmissibleMetadataField>
): GatewaySession["thinkingOptions"] {
    if (options === undefined) return undefined;
    const projected = options.map((option) => optionalNonblank(option));
    if (
        projected.some(
            (option) =>
                option === undefined ||
                codePointLength(option) > gatewaySessionPreferenceMaximum
        )
    ) {
        omissions.add("thinkingOptions");
        return undefined;
    }
    return projected as GatewaySession["thinkingOptions"];
}

function projectSessionKind(
    session: v.InferOutput<typeof upstreamSessionRowSchema>
): GatewaySessionKind {
    const key = session.key.toLowerCase();
    if (key.startsWith("hook:") || key.includes(":hook:")) return "hook";
    if (
        key.startsWith("cron:") ||
        key.includes(":cron:") ||
        session.createdVia === "cron"
    ) {
        return "cron";
    }
    if (
        key.includes(":subagent:") ||
        session.createdVia === "spawn" ||
        session.spawnedBy !== undefined ||
        session.parentSessionKey !== undefined
    ) {
        return "subagent";
    }
    if (key === "global" || key === "main" || key.startsWith("agent:main:")) {
        return "main";
    }
    if (key.startsWith("agent:")) return "subagent";
    return "unknown";
}

function projectSession(
    session: v.InferOutput<typeof upstreamSessionRowSchema>
): GatewaySession {
    const omissions = new Set<GatewaySessionOmissibleMetadataField>();
    const display = projectDisplayName(session);
    const channel = projectOptionalMetadata(
        session.channel,
        gatewaySessionChannelMaximum,
        "channel",
        omissions
    );
    const elevatedLevel = projectOptionalMetadata(
        session.elevatedLevel,
        gatewaySessionPreferenceMaximum,
        "elevatedLevel",
        omissions
    );
    const model = projectOptionalMetadata(
        session.model,
        gatewaySessionModelMaximum,
        "model",
        omissions
    );
    const modelProvider = projectOptionalMetadata(
        session.modelProvider,
        gatewaySessionProviderMaximum,
        "modelProvider",
        omissions
    );
    const reasoningLevel = projectOptionalMetadata(
        session.reasoningLevel,
        gatewaySessionPreferenceMaximum,
        "reasoningLevel",
        omissions
    );
    const thinkingDefault = projectOptionalMetadata(
        session.thinkingDefault,
        gatewaySessionPreferenceMaximum,
        "thinkingDefault",
        omissions
    );
    const thinkingLevel = projectOptionalMetadata(
        session.thinkingLevel,
        gatewaySessionPreferenceMaximum,
        "thinkingLevel",
        omissions
    );
    const thinkingLevels = projectThinkingLevels(session.thinkingLevels, omissions);
    const thinkingOptions = projectThinkingOptions(session.thinkingOptions, omissions);
    const verboseLevel = projectOptionalMetadata(
        session.verboseLevel,
        gatewaySessionPreferenceMaximum,
        "verboseLevel",
        omissions
    );
    const omittedMetadataFields = gatewaySessionOmissibleMetadataFields.filter((field) =>
        omissions.has(field)
    );
    return v.parse(gatewaySessionSchema, {
        ...(session.activeRunIds === undefined
            ? {}
            : { activeRunIds: session.activeRunIds }),
        ...(channel === undefined ? {} : { channel }),
        ...(session.contextTokens === undefined
            ? {}
            : { contextTokens: session.contextTokens }),
        ...(session.createdAt === undefined ? {} : { createdAtMs: session.createdAt }),
        ...display,
        ...(session.effectiveFastMode === undefined
            ? {}
            : { effectiveFastMode: session.effectiveFastMode }),
        ...(elevatedLevel === undefined ? {} : { elevatedLevel }),
        ...(session.endedAt === undefined ? {} : { endedAtMs: session.endedAt }),
        ...(session.fastMode === undefined ? {} : { fastMode: session.fastMode }),
        hasActiveRun: session.hasActiveRun ?? false,
        key: session.key,
        kind: projectSessionKind(session),
        ...(model === undefined ? {} : { model }),
        ...(modelProvider === undefined ? {} : { modelProvider }),
        ...(omittedMetadataFields.length === 0 ? {} : { omittedMetadataFields }),
        ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
        ...(session.runtimeMs === undefined ? {} : { runtimeMs: session.runtimeMs }),
        ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
        ...(session.startedAt === undefined ? {} : { startedAtMs: session.startedAt }),
        ...(session.status === undefined ? {} : { status: session.status }),
        ...(thinkingDefault === undefined ? {} : { thinkingDefault }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        ...(thinkingLevels === undefined ? {} : { thinkingLevels }),
        ...(thinkingOptions === undefined ? {} : { thinkingOptions }),
        ...(session.totalTokens === undefined
            ? {}
            : { totalTokens: session.totalTokens }),
        totalTokensFresh: session.totalTokensFresh ?? false,
        ...(session.updatedAt === undefined || session.updatedAt === null
            ? {}
            : { updatedAtMs: session.updatedAt }),
        ...(verboseLevel === undefined ? {} : { verboseLevel }),
    });
}

function requestOptions(
    signal: AbortSignal | undefined,
    timeoutMs: number
): PersistentGatewayRequestOptions {
    return signal === undefined ? { timeoutMs } : { signal, timeoutMs };
}

function throwSafeProviderFailure(error: unknown, signal?: AbortSignal): never {
    if (error instanceof GatewaySessionProviderNotFoundError) throw error;
    if (error instanceof GatewaySessionProviderConflictError) throw error;
    if (error instanceof GatewaySessionProviderUnknownOutcomeError) throw error;
    if (error instanceof GatewaySessionProviderUnavailableError) throw error;
    if (error instanceof PersistentGatewayUnknownOutcomeError) {
        throw new GatewaySessionProviderUnknownOutcomeError();
    }
    if (
        error instanceof PersistentGatewayRequestError &&
        error.code === "INVALID_REQUEST" &&
        error.reason === persistentGatewaySessionChangedReason
    ) {
        throw new GatewaySessionProviderConflictError();
    }
    if (error instanceof PersistentGatewayRequestError) {
        throw new GatewaySessionProviderUnavailableError();
    }
    if (signal?.aborted === true || error instanceof PersistentGatewayAbortError) {
        throw new GatewaySessionProviderAbortError();
    }
    throw new GatewaySessionProviderUnavailableError();
}

async function runProviderRequest<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
): Promise<T> {
    if (signal?.aborted === true) throw new GatewaySessionProviderAbortError();
    try {
        return await operation();
    } catch (error) {
        throwSafeProviderFailure(error, signal);
    }
}

function parseListResponse(
    rawResponse: unknown,
    requestedLimit: number
): GatewaySessionProviderSnapshot {
    const response = v.parse(upstreamSessionsListResponseSchema, rawResponse);
    if (
        response.limitApplied !== requestedLimit ||
        (response.offset ?? 0) !== 0 ||
        response.count > requestedLimit ||
        response.sessions.length !== response.count ||
        response.totalCount < response.count ||
        response.hasMore !== response.totalCount > response.count ||
        response.nextOffset !== (response.hasMore ? response.count : null)
    ) {
        throw new GatewaySessionProviderUnavailableError();
    }
    const sessions = response.sessions.map(projectSession);
    if (new Set(sessions.map(({ key }) => key)).size !== sessions.length) {
        throw new GatewaySessionProviderUnavailableError();
    }
    return Object.freeze({
        sessions: Object.freeze(sessions),
        truncated: response.hasMore,
    });
}

function parseActionKey(request: GatewaySessionProviderActionRequest): string {
    return v.parse(gatewaySessionKeySchema, request.key);
}

function assertAcknowledgedKey(actual: string, expected: string): void {
    if (actual !== expected) throw new GatewaySessionProviderUnknownOutcomeError();
}

/**
 * Adapts the reviewed persistent Gateway transport to the narrow sessions domain port.
 * Every upstream payload is validated and projected before it crosses the provider boundary.
 * @param transport Process-owned persistent and one-shot admin transport lanes.
 * @returns The frozen, narrow sessions provider adapter.
 */
export function createPersistentGatewaySessionsProvider(
    transport: PersistentGatewaySessionsTransport
): GatewaySessionsProvider {
    async function listCurrentSessions(
        request: GatewaySessionProviderRequest
    ): Promise<GatewaySessionProviderSnapshot> {
        return runProviderRequest(request.signal, async () => {
            const limit = v.parse(providerLimitSchema, request.limit);
            const response = await transport.request(
                "sessions.list",
                {
                    archived: false,
                    includeGlobal: true,
                    includeUnknown: true,
                    limit,
                    sortBy: "updatedAt",
                },
                requestOptions(request.signal, persistentGatewaySessionsListTimeoutMs)
            );
            return parseListResponse(response, limit);
        });
    }

    async function compactSession(
        request: GatewaySessionProviderActionRequest
    ): Promise<GatewaySessionProviderCompactOutcome> {
        return runProviderRequest(request.signal, async () => {
            const key = parseActionKey(request);
            const parsed = v.safeParse(
                upstreamCompactResponseSchema,
                await transport.requestAdmin(
                    "sessions.compact",
                    { key },
                    requestOptions(
                        request.signal,
                        persistentGatewaySessionCompactionTimeoutMs
                    )
                )
            );
            if (!parsed.success) throw new GatewaySessionProviderUnknownOutcomeError();
            const response = parsed.output;
            assertAcknowledgedKey(response.key, key);
            if (!response.compacted) return "unchanged";
            if (!response.ok) throw new GatewaySessionProviderUnknownOutcomeError();
            return "compacted";
        });
    }

    async function resetSession(
        request: GatewaySessionProviderActionRequest
    ): Promise<void> {
        return runProviderRequest(request.signal, async () => {
            const key = parseActionKey(request);
            const parsed = v.safeParse(
                upstreamResetResponseSchema,
                await transport.requestAdmin(
                    "sessions.reset",
                    { key, reason: "reset" },
                    requestOptions(
                        request.signal,
                        persistentGatewaySessionControlTimeoutMs
                    )
                )
            );
            if (!parsed.success) throw new GatewaySessionProviderUnknownOutcomeError();
            const response = parsed.output;
            assertAcknowledgedKey(response.key, key);
        });
    }

    async function deleteSessionTranscript(
        request: GatewaySessionProviderDeleteRequest
    ): Promise<void> {
        return runProviderRequest(request.signal, async () => {
            const key = parseActionKey(request);
            const parsed = v.safeParse(
                upstreamDeleteResponseSchema,
                await transport.requestAdmin(
                    "sessions.delete",
                    {
                        deleteTranscript: true,
                        expectedSessionId: v.parse(
                            gatewaySessionIdSchema,
                            request.expectedSessionId
                        ),
                        ...(request.expectedUpdatedAtMs === undefined
                            ? {}
                            : {
                                  expectedSessionUpdatedAt: v.parse(
                                      timestampMillisecondsSchema(
                                          "Gateway expected session timestamp is invalid"
                                      ),
                                      request.expectedUpdatedAtMs
                                  ),
                              }),
                        key,
                    },
                    requestOptions(
                        request.signal,
                        persistentGatewaySessionControlTimeoutMs
                    )
                )
            );
            if (!parsed.success) throw new GatewaySessionProviderUnknownOutcomeError();
            const response = parsed.output;
            assertAcknowledgedKey(response.key, key);
            if (!response.deleted) throw new GatewaySessionProviderNotFoundError();
        });
    }

    return Object.freeze({
        compactSession,
        deleteSessionTranscript,
        listCurrentSessions,
        resetSession,
    });
}
