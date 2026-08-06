import * as v from "valibot";

const fixtureSchemaVersion = v.literal(1);
const positiveSafeIntegerSchema = v.pipe(
    v.number(),
    v.integer(),
    v.safeInteger(),
    v.minValue(1)
);
const boundedStringSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const methodOrEventNameSchema = v.pipe(
    v.string(),
    v.regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)*$/u)
);
const sourcePathSchema = v.pipe(
    v.string(),
    v.regex(/^(?:package\.json|dist\/[A-Za-z0-9._/-]+)$/u),
    v.check((value) => !value.includes(".."), "Source paths cannot traverse directories")
);
const sha256Schema = v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u));
const versionSchema = v.pipe(
    v.string(),
    v.regex(/^\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
);
const commitSchema = v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u));
const timestampSchema = v.pipe(
    v.string(),
    v.check((value) => {
        const parsed = new Date(value);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
    }, "Expected a canonical UTC timestamp")
);

function isSortedAndUnique(values: string[]): boolean {
    return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

const sortedUniqueNamesSchema = v.pipe(
    v.array(methodOrEventNameSchema),
    v.minLength(1),
    v.maxLength(128),
    v.check(isSortedAndUnique, "Names must be sorted and unique")
);

const agentDeltaEventSchema = v.strictObject({
    delta: boundedStringSchema,
    kind: v.literal("agent-delta"),
    seq: positiveSafeIntegerSchema,
    stream: v.union([v.literal("assistant"), v.literal("thinking")]),
    text: boundedStringSchema,
});
const toolStartEventSchema = v.strictObject({
    kind: v.literal("tool-start"),
    seq: positiveSafeIntegerSchema,
    toolCallId: boundedStringSchema,
    toolName: boundedStringSchema,
});
const toolResultEventSchema = v.strictObject({
    kind: v.literal("tool-result"),
    outcome: v.union([v.literal("ok"), v.literal("error")]),
    seq: positiveSafeIntegerSchema,
    toolCallId: boundedStringSchema,
    toolName: boundedStringSchema,
});
const chatDeltaEventSchema = v.strictObject({
    deltaText: boundedStringSchema,
    kind: v.literal("chat-delta"),
    seq: positiveSafeIntegerSchema,
});
const chatTerminalStateSchema = v.union([
    v.literal("final"),
    v.literal("aborted"),
    v.literal("error"),
]);
const chatTerminalEventSchema = v.strictObject({
    kind: v.literal("chat-terminal"),
    seq: positiveSafeIntegerSchema,
    state: chatTerminalStateSchema,
    stopReason: boundedStringSchema,
});
const syntheticChatEventSchema = v.variant("kind", [
    agentDeltaEventSchema,
    toolStartEventSchema,
    toolResultEventSchema,
    chatDeltaEventSchema,
    chatTerminalEventSchema,
]);
const syntheticScenarioEventsSchema = v.pipe(
    v.array(syntheticChatEventSchema),
    v.minLength(2),
    v.maxLength(32)
);
const syntheticScenarioIdSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{2,63}$/u));
const syntheticScenarioObjectSchema = v.strictObject({
    events: syntheticScenarioEventsSchema,
    id: syntheticScenarioIdSchema,
});
const syntheticScenarioSchema = v.pipe(
    syntheticScenarioObjectSchema,
    v.check(
        (scenario) => scenario.events.every((event, index) => event.seq === index + 1),
        "Synthetic event sequences must use contiguous sequence numbers"
    )
);

const gatewayFrameTypesSchema = v.tuple([
    v.literal("event"),
    v.literal("req"),
    v.literal("res"),
]);
const coalescedAgentStreamsSchema = v.tuple([
    v.literal("assistant"),
    v.literal("thinking"),
]);
const flushBeforeBoundariesSchema = v.tuple([
    v.literal("item.start"),
    v.literal("tool.start"),
]);
const terminalStatesSchema = v.tuple([
    v.literal("final"),
    v.literal("aborted"),
    v.literal("error"),
]);

const syntheticScenariosSchema = v.pipe(
    v.array(syntheticScenarioSchema),
    v.length(2),
    v.check(
        (scenarios) => isSortedAndUnique(scenarios.map((scenario) => scenario.id)),
        "Synthetic scenario ids must be sorted and unique"
    )
);

const domainFixtureEntries = {
    gatewayEvents: sortedUniqueNamesSchema,
    methods: sortedUniqueNamesSchema,
    schemaVersion: fixtureSchemaVersion,
};

const operatorScopeSchema = v.union([
    v.literal("operator.read"),
    v.literal("operator.write"),
]);
const methodPermissionSchema = v.strictObject({
    controlPlaneWrite: v.boolean(),
    name: methodOrEventNameSchema,
    scope: operatorScopeSchema,
});
const methodPermissionsSchema = v.pipe(
    v.array(methodPermissionSchema),
    v.minLength(1),
    v.maxLength(16),
    v.check(
        (entries) => isSortedAndUnique(entries.map((entry) => entry.name)),
        "Method permissions must be sorted and unique"
    )
);
const taskStatusSchema = v.picklist([
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
]);
export const gatewayFixtureSchema = v.strictObject({
    challengeEvent: v.literal("connect.challenge"),
    frameTypes: gatewayFrameTypesSchema,
    gatewayEvents: sortedUniqueNamesSchema,
    helloType: v.literal("hello-ok"),
    limits: v.strictObject({
        authenticatedFrameBytes: positiveSafeIntegerSchema,
        preauthenticationFrameBytes: positiveSafeIntegerSchema,
    }),
    method: v.literal("connect"),
    minimumClientProtocolVersion: positiveSafeIntegerSchema,
    minimumNodeProtocolVersion: positiveSafeIntegerSchema,
    minimumProbeProtocolVersion: positiveSafeIntegerSchema,
    protocolVersion: positiveSafeIntegerSchema,
    schemaVersion: fixtureSchemaVersion,
});

export const chatFixtureSchema = v.strictObject({
    ...domainFixtureEntries,
    domain: v.literal("chat"),
    streamingPolicy: v.strictObject({
        coalescedAgentStreams: coalescedAgentStreamsSchema,
        deltaThrottleMs: positiveSafeIntegerSchema,
        flushBeforeBoundaries: flushBeforeBoundariesSchema,
        flushBufferedDeltaBeforeTerminal: v.literal(true),
        terminalStates: terminalStatesSchema,
    }),
    syntheticScenarios: syntheticScenariosSchema,
});

/*
 * The declarations below intentionally remain domain-specific so a fixture
 * cannot acquire fields from another OpenClaw surface by accident.
 */
const companionAuthoritySchema = v.strictObject({
    askResultDelivery: v.literal("requester-only"),
    dedicatedGatewayEvent: v.literal(false),
    stateStorage: v.literal("process-memory"),
});
const companionLifecycleSchema = v.strictObject({
    firstFailedAskRemovesEmptyThread: v.literal(true),
    resetAbortsActiveAsk: v.literal(true),
    sessionResetClearsThread: v.literal(true),
    serviceDisposeAbortsAll: v.literal(true),
});
const companionLimitsSchema = v.strictObject({
    answerChars: positiveSafeIntegerSchema,
    connectionAsksPerMinute: positiveSafeIntegerSchema,
    exchangeBytes: positiveSafeIntegerSchema,
    exchanges: positiveSafeIntegerSchema,
    globalAsksPerMinute: positiveSafeIntegerSchema,
    globalConcurrentAsks: positiveSafeIntegerSchema,
    idleTtlMs: positiveSafeIntegerSchema,
    perSeedMessageChars: positiveSafeIntegerSchema,
    perSessionConcurrentAsks: positiveSafeIntegerSchema,
    questionChars: positiveSafeIntegerSchema,
    seedBytes: positiveSafeIntegerSchema,
    seedTranscriptMessages: positiveSafeIntegerSchema,
    sweepIntervalMs: positiveSafeIntegerSchema,
    timeoutMs: positiveSafeIntegerSchema,
});
const companionToolsSchema = v.tuple([
    v.literal("read"),
    v.literal("sessions_history"),
    v.literal("sessions_search"),
]);
const companionRuntimePolicySchema = v.strictObject({
    askStartsUtilityModelInference: v.literal(true),
    messageToolDisabled: v.literal(true),
    sessionsVisibility: v.literal("self"),
    toolSearchDisabled: v.literal(true),
    tools: companionToolsSchema,
    workspaceOnly: v.literal(true),
});
const companionUiProjectionSchema = v.strictObject({
    busyCode: v.literal("SESSION_COMPANION_BUSY"),
    hydrationIsRevisionGuarded: v.literal(true),
    localPendingPerSession: v.literal(true),
    retainedExchanges: positiveSafeIntegerSchema,
});
const companionSchema = v.strictObject({
    authority: companionAuthoritySchema,
    lifecycle: companionLifecycleSchema,
    limits: companionLimitsSchema,
    methodPermissions: methodPermissionsSchema,
    runtimePolicy: companionRuntimePolicySchema,
    uiProjection: companionUiProjectionSchema,
});
const planAuthoritySchema = v.strictObject({
    dedicatedGatewayEvent: v.literal(false),
    dedicatedRpcMethod: v.literal(false),
    gatewayEvent: v.literal("agent"),
    phase: v.literal("update"),
    producerTool: v.literal("update_plan"),
    stream: v.literal("plan"),
});
const planStatusesSchema = v.tuple([
    v.literal("pending"),
    v.literal("in_progress"),
    v.literal("completed"),
]);
const planContractSchema = v.strictObject({
    legacyStringStepsBecomePending: v.literal(true),
    maximumInProgressSteps: v.literal(1),
    minimumSteps: v.literal(1),
    statuses: planStatusesSchema,
});
const planLifecycleSchema = v.strictObject({
    clearedOnOwningRunTerminal: v.literal(true),
    durableAfterTerminal: v.literal(false),
    historyRecovery: v.literal("in-flight-run-only"),
    runOwned: v.literal(true),
});
const planUiProjectionSchema = v.strictObject({
    activeOnly: v.literal(true),
    composerChecklist: v.literal(true),
    messageStreamCard: v.literal(true),
    sessionRailStepLimit: positiveSafeIntegerSchema,
});
const planSchema = v.strictObject({
    authority: planAuthoritySchema,
    contract: planContractSchema,
    lifecycle: planLifecycleSchema,
    uiProjection: planUiProjectionSchema,
});

export const sessionsFixtureSchema = v.strictObject({
    ...domainFixtureEntries,
    companion: companionSchema,
    domain: v.literal("sessions"),
    plan: planSchema,
});

export const agentsFixtureSchema = v.strictObject({
    ...domainFixtureEntries,
    domain: v.literal("agents"),
});

export const cronFixtureSchema = v.strictObject({
    ...domainFixtureEntries,
    domain: v.literal("cron"),
});

const taskRuntimeMappingSchema = v.strictObject({
    internal: v.picklist([
        "cancelled",
        "failed",
        "lost",
        "queued",
        "running",
        "succeeded",
        "timed_out",
    ]),
    wire: taskStatusSchema,
});
const taskCancellationSchema = v.strictObject({
    canonicalCompletionCanWinRace: v.literal(true),
    cascadesSubagentDescendants: v.literal(true),
    notFoundIsRpcSuccess: v.literal(true),
    operatorControlBypassesCallerSessionOwnership: v.literal(true),
    refusalIsRpcSuccess: v.literal(true),
    subagentCancellationIsProvisional: v.literal(true),
    terminalTaskIsNotCancelled: v.literal(true),
});
const taskAuthoritySchema = v.strictObject({
    cancelTarget: v.literal("task-id"),
    ledgerScope: v.literal("global-with-optional-filters"),
    sessionFilterRequired: v.literal(false),
});
const taskEventActionsSchema = v.tuple([
    v.literal("deleted"),
    v.literal("restored"),
    v.literal("upserted"),
]);
const taskEventSchema = v.strictObject({
    actions: taskEventActionsSchema,
    delivery: v.literal("best-effort-drop-if-slow"),
    name: v.literal("task"),
});
const taskFiltersSchema = v.tuple([
    v.literal("agentId"),
    v.literal("sessionKey"),
    v.literal("status"),
]);
const taskListSchema = v.strictObject({
    cursor: v.literal("decimal-offset"),
    defaultLimit: positiveSafeIntegerSchema,
    filters: taskFiltersSchema,
    maximumLimit: positiveSafeIntegerSchema,
    ordering: v.literal("last-activity-descending"),
});
const taskMethodsSchema = v.tuple([
    v.literal("tasks.cancel"),
    v.literal("tasks.get"),
    v.literal("tasks.list"),
]);
const taskPromptVisibilitySchema = v.strictObject({
    getIncludesBoundedPrompt: v.literal(true),
    listAndEventsOmitPrompt: v.literal(true),
    promptChars: positiveSafeIntegerSchema,
});
const taskRuntimeMappingsSchema = v.pipe(
    v.array(taskRuntimeMappingSchema),
    v.length(7),
    v.check(
        (mappings) => isSortedAndUnique(mappings.map((mapping) => mapping.internal)),
        "Task runtime mappings must be sorted and unique"
    )
);
const taskStatusesSchema = v.tuple([
    v.literal("queued"),
    v.literal("running"),
    v.literal("completed"),
    v.literal("failed"),
    v.literal("cancelled"),
    v.literal("timed_out"),
]);
const taskUiProjectionSchema = v.strictObject({
    activeSnapshotLimit: positiveSafeIntegerSchema,
    cancelledAndTimedOutUseFailedGroup: v.literal(true),
    detailUsesTasksGet: v.literal(true),
    eventBufferDuringSnapshot: v.literal(true),
    finishedSnapshotLimit: positiveSafeIntegerSchema,
    nonSubagentOpenSessionLink: v.literal(true),
    reconnectRefetch: v.literal(true),
    restoredEventRefetch: v.literal(true),
    stopRequiresOperatorWrite: v.literal(true),
    subagentOpenSessionLink: v.literal(false),
});

export const tasksFixtureSchema = v.strictObject({
    authority: taskAuthoritySchema,
    cancellation: taskCancellationSchema,
    domain: v.literal("tasks"),
    event: taskEventSchema,
    gatewayEvents: v.tuple([v.literal("task")]),
    list: taskListSchema,
    methodPermissions: methodPermissionsSchema,
    methods: taskMethodsSchema,
    promptVisibility: taskPromptVisibilitySchema,
    runtimeMappings: taskRuntimeMappingsSchema,
    schemaVersion: fixtureSchemaVersion,
    statuses: taskStatusesSchema,
    uiProjection: taskUiProjectionSchema,
});

export const sourceIdentitySchema = v.strictObject({
    builtAt: timestampSchema,
    commit: commitSchema,
    packageName: v.literal("openclaw"),
    protocolVersion: positiveSafeIntegerSchema,
    version: versionSchema,
});

export const sourceArtifactSchema = v.strictObject({
    bytes: positiveSafeIntegerSchema,
    path: sourcePathSchema,
    role: v.picklist([
        "build-info",
        "chat-run-projection",
        "chat-streaming",
        "control-ui-chat",
        "control-ui-plan-renderer",
        "control-ui-plan-rail",
        "gateway-events",
        "gateway-limits",
        "gateway-methods",
        "gateway-websocket",
        "method-descriptors",
        "package-metadata",
        "plan-tool",
        "protocol-declarations",
        "protocol-schemas",
        "protocol-version",
        "runtime-subscriptions",
        "session-companion-rpc",
        "session-companion-runtime",
        "subagent-control",
        "task-registry",
        "task-summary",
        "tasks-handlers",
    ]),
    sha256: sha256Schema,
});

const sourceArtifactsSchema = v.pipe(
    v.array(sourceArtifactSchema),
    v.length(23),
    v.check(
        (artifacts) => isSortedAndUnique(artifacts.map((artifact) => artifact.role)),
        "Source artifact roles must be sorted and unique"
    ),
    v.check(
        (artifacts) =>
            new Set(artifacts.map((artifact) => artifact.path)).size === artifacts.length,
        "Source artifact paths must be unique"
    )
);

const fixtureManifestEntrySchema = v.strictObject({
    file: v.picklist([
        "agents.json",
        "chat.json",
        "cron.json",
        "gateway.json",
        "sessions.json",
        "tasks.json",
    ]),
    sha256: sha256Schema,
});

export const fixtureManifestSchema = v.strictObject({
    components: v.pipe(
        v.array(fixtureManifestEntrySchema),
        v.length(6),
        v.check(
            (components) =>
                isSortedAndUnique(components.map((component) => component.file)),
            "Manifest component files must be sorted and unique"
        )
    ),
    contentPolicy: v.strictObject({
        containsHostConfiguration: v.literal(false),
        containsRuntimeState: v.literal(false),
        containsSecrets: v.literal(false),
        sourceArtifacts: v.literal("hashes-only"),
        syntheticPayloadsOnly: v.literal(true),
    }),
    schemaVersion: fixtureSchemaVersion,
    source: sourceIdentitySchema,
    sourceArtifacts: sourceArtifactsSchema,
});

export const sourceAuditResultSchema = v.pipe(
    v.strictObject({
        agents: agentsFixtureSchema,
        chat: chatFixtureSchema,
        cron: cronFixtureSchema,
        gateway: gatewayFixtureSchema,
        sessions: sessionsFixtureSchema,
        tasks: tasksFixtureSchema,
        source: sourceIdentitySchema,
        sourceArtifacts: sourceArtifactsSchema,
    }),
    v.check(
        (audit) => audit.gateway.protocolVersion === audit.source.protocolVersion,
        "Source and Gateway protocol versions must match"
    )
);

export type AgentsFixture = v.InferOutput<typeof agentsFixtureSchema>;
export type ChatFixture = v.InferOutput<typeof chatFixtureSchema>;
export type CronFixture = v.InferOutput<typeof cronFixtureSchema>;
export type FixtureManifest = v.InferOutput<typeof fixtureManifestSchema>;
export type GatewayFixture = v.InferOutput<typeof gatewayFixtureSchema>;
export type SessionsFixture = v.InferOutput<typeof sessionsFixtureSchema>;
export type TasksFixture = v.InferOutput<typeof tasksFixtureSchema>;
export type SourceArtifact = v.InferOutput<typeof sourceArtifactSchema>;
export type SourceAuditResult = v.InferOutput<typeof sourceAuditResultSchema>;

/**
 * Parses one strict fixture document without accepting unknown fields.
 * @param schema Strict component schema.
 * @param serialized Serialized fixture bytes decoded as UTF-8.
 * @returns Parsed component data.
 */
export function parseFixtureDocument<
    TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, serialized: string): v.InferOutput<TSchema> {
    return v.parse(schema, JSON.parse(serialized) as unknown);
}

/**
 * Applies every strict schema to a source-derived audit result.
 * @param value Unknown source-derived candidate.
 * @returns Strict audit facts safe to compare or serialize.
 */
export function parseSourceAuditResult(value: unknown): SourceAuditResult {
    return v.parse(sourceAuditResultSchema, value);
}

/**
 * Applies the strict reviewed-fixture manifest schema.
 * @param serialized Serialized manifest bytes decoded as UTF-8.
 * @returns Strict reviewed fixture manifest.
 */
export function parseFixtureManifest(serialized: string): FixtureManifest {
    return parseFixtureDocument(fixtureManifestSchema, serialized);
}
