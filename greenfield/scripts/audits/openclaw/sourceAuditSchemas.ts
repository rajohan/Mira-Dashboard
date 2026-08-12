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
    broadcastSequence: v.strictObject({
        dropIfSlowAdvances: v.literal(true),
        firstSequence: v.literal(1),
        scope: v.literal("per-client"),
        targetedOmitsSequence: v.literal(true),
    }),
    challengeEvent: v.literal("connect.challenge"),
    frameTypes: gatewayFrameTypesSchema,
    gatewayEvents: sortedUniqueNamesSchema,
    helloType: v.literal("hello-ok"),
    limits: v.strictObject({
        authenticatedFrameBytes: positiveSafeIntegerSchema,
        bufferedAmountBytes: positiveSafeIntegerSchema,
        preauthenticationFrameBytes: positiveSafeIntegerSchema,
    }),
    method: v.literal("connect"),
    minimumClientProtocolVersion: positiveSafeIntegerSchema,
    minimumNodeProtocolVersion: positiveSafeIntegerSchema,
    minimumProbeProtocolVersion: positiveSafeIntegerSchema,
    protocolVersion: positiveSafeIntegerSchema,
    schemaVersion: fixtureSchemaVersion,
    sessionScopedEvents: v.strictObject({
        backendModeAccepted: v.literal(true),
        capability: v.literal("session-scoped-events"),
        connectParameter: v.strictObject({
            defaultEmptyArray: v.literal(true),
            element: v.literal("non-empty-string"),
            optional: v.literal(true),
        }),
        filteredEvents: v.tuple([
            v.literal("agent"),
            v.literal("chat"),
            v.literal("chat.side_result"),
            v.literal("session.observer"),
        ]),
        requiresSessionMessageSubscription: v.literal(true),
    }),
});

const localHistoryMediaFixtureSchema = v.strictObject({
    canonical: v.strictObject({
        fields: v.tuple([
            v.literal("contentType"),
            v.literal("durationMs"),
            v.literal("fileName"),
            v.literal("height"),
            v.literal("hydrationSuppressed"),
            v.literal("kind"),
            v.literal("messageId"),
            v.literal("path"),
            v.literal("sizeBytes"),
            v.literal("staged"),
            v.literal("transcribed"),
            v.literal("url"),
            v.literal("width"),
            v.literal("workspaceDir"),
        ]),
        persistedPath: v.literal("__openclaw.media"),
        retiredTopLevelMediaMigrated: v.literal(true),
    }),
    directives: v.strictObject({
        fencedBlocksPreserved: v.literal(true),
        fileUrlPrefixStripped: v.literal(true),
        invalidLocalPathDirectiveRemovedFromVisibleText: v.literal(true),
        lineLeadingAfterWhitespace: v.literal(true),
        maximumCandidateCharacters: v.literal(4096),
        scope: v.literal("outbound-reply-output"),
        token: v.literal("MEDIA:"),
        traversalSegmentsRejected: v.literal(true),
    }),
    legacy: v.strictObject({
        pluralFields: v.tuple([
            v.literal("MediaPaths"),
            v.literal("MediaTypes"),
            v.literal("MediaUrls"),
        ]),
        singularFields: v.tuple([
            v.literal("MediaPath"),
            v.literal("MediaType"),
            v.literal("MediaUrl"),
        ]),
    }),
    persistence: v.strictObject({
        ambiguousSparseLegacyAlignmentRejected: v.literal(true),
        canonicalizedBeforeSqliteWrite: v.literal(true),
        retiredFieldsDeleted: v.literal(true),
        underCardinalLegacyTypesDroppedWhenUnambiguous: v.literal(true),
    }),
    precedence: v.strictObject({
        contentType: v.tuple([
            v.literal("canonical.contentType"),
            v.literal("MediaTypes[index]"),
            v.literal("MediaType[index=0]"),
        ]),
        path: v.tuple([
            v.literal("canonical.path"),
            v.literal("MediaPaths[index]"),
            v.literal("MediaPath[index=0]"),
        ]),
        slotCount: v.literal("maximum-canonical-paths-urls-types-or-singular"),
        url: v.tuple([
            v.literal("canonical.url"),
            v.literal("MediaUrls[index]"),
            v.literal("MediaUrl[index=0-or-MediaPaths-present]"),
        ]),
    }),
    projection: v.strictObject({
        canonicalEnvelopeOnly: v.literal(true),
        mediaOnlyUserMessagesRetained: v.literal(true),
    }),
    root: v.strictObject({
        mediaStore: v.literal("config-directory/media"),
    }),
});

export const chatFixtureSchema = v.strictObject({
    ...domainFixtureEntries,
    adapter: v.strictObject({
        lanes: v.strictObject({
            abort: v.literal("one-shot-write"),
            companionAsk: v.literal("one-shot-read-mutation"),
            companionReset: v.literal("one-shot-write"),
            companionState: v.literal("persistent-read"),
            history: v.literal("persistent-read"),
            messageGet: v.literal("persistent-read"),
            modelsList: v.literal("persistent-read"),
            send: v.literal("one-shot-write"),
            settings: v.literal("one-shot-admin"),
            subscription: v.literal("private-session-scoped"),
        }),
        media: v.strictObject({
            attachmentId: v.literal("uuidv4"),
            bearerServerSide: v.literal(true),
            localHistory: localHistoryMediaFixtureSchema,
            ownerRequired: v.literal(true),
            rangeRequests: v.literal(true),
            routePrefix: v.literal("/api/chat/media/outgoing"),
            transcriptAssociationRequired: v.literal(true),
            variant: v.literal("full"),
        }),
        methods: v.strictObject({
            abort: v.strictObject({
                method: v.literal("chat.abort"),
                requestParams: v.tuple([
                    v.literal("preserveSideRuns"),
                    v.literal("runId"),
                    v.literal("sessionKey"),
                ]),
                resultFields: v.tuple([
                    v.literal("aborted"),
                    v.literal("ok"),
                    v.literal("runIds"),
                ]),
            }),
            companionAsk: v.strictObject({
                connectionRequired: v.literal(true),
                method: v.literal("sessions.companion.ask"),
                requestParams: v.tuple([v.literal("question"), v.literal("sessionKey")]),
                resultFields: v.tuple([v.literal("answer"), v.literal("ts")]),
            }),
            companionReset: v.strictObject({
                method: v.literal("sessions.companion.reset"),
                requestParams: v.tuple([v.literal("sessionKey")]),
                resetCancelsActiveAsk: v.literal(true),
                resultFields: v.tuple([v.literal("ok")]),
            }),
            companionState: v.strictObject({
                connectionIndependent: v.literal(true),
                exchangeFields: v.tuple([
                    v.literal("answer"),
                    v.literal("question"),
                    v.literal("ts"),
                ]),
                method: v.literal("sessions.companion.state"),
                requestParams: v.tuple([v.literal("sessionKey")]),
                resultFields: v.tuple([v.literal("exchanges")]),
            }),
            history: v.strictObject({
                defaultLimit: v.literal(200),
                inFlightRun: v.strictObject({
                    boundedAgainstPageMessages: v.literal(true),
                    exactValueStableAcrossPages: v.literal(false),
                    multipleActiveRunsPossible: v.literal(true),
                    recomputedPerRequest: v.literal(true),
                    selection: v.literal("newest-visible-run"),
                    tieBreak: v.literal("runId-descending"),
                }),
                maximumLimit: v.literal(1000),
                messageIdentityPath: v.literal("__openclaw.id"),
                messageOrder: v.literal("chronological"),
                method: v.literal("chat.history"),
                pagination: v.strictObject({
                    hasMoreRequiresNextOffset: v.literal(true),
                    nextOffsetOnlyWhenHasMore: v.literal(true),
                    offsetDirection: v.literal("older-from-recent-tail"),
                }),
                possibleResponseFields: v.tuple([
                    v.literal("completeSnapshot"),
                    v.literal("defaults"),
                    v.literal("fastMode"),
                    v.literal("hasMore"),
                    v.literal("inFlightRun"),
                    v.literal("messages"),
                    v.literal("nextOffset"),
                    v.literal("offset"),
                    v.literal("sessionId"),
                    v.literal("sessionInfo"),
                    v.literal("sessionKey"),
                    v.literal("thinkingLevel"),
                    v.literal("toolOverrides"),
                    v.literal("totalMessages"),
                    v.literal("verboseLevel"),
                ]),
                requestParams: v.tuple([
                    v.literal("agentId"),
                    v.literal("limit"),
                    v.literal("maxChars"),
                    v.literal("messageId"),
                    v.literal("offset"),
                    v.literal("sessionId"),
                    v.literal("sessionKey"),
                ]),
                sessionIdentity: v.strictObject({
                    requestedKeyEchoed: v.literal(true),
                    sessionIdOptional: v.literal(true),
                }),
            }),
            messageGet: v.strictObject({
                messageIdentityPath: v.literal("__openclaw.id"),
                method: v.literal("chat.message.get"),
                requestParams: v.tuple([
                    v.literal("agentId"),
                    v.literal("maxChars"),
                    v.literal("messageId"),
                    v.literal("sessionKey"),
                ]),
                successFields: v.tuple([v.literal("message"), v.literal("ok")]),
                unavailableFields: v.tuple([
                    v.literal("ok"),
                    v.literal("unavailableReason"),
                ]),
                unavailableReasons: v.tuple([
                    v.literal("not_found"),
                    v.literal("not_visible"),
                    v.literal("oversized"),
                ]),
            }),
            modelsList: v.strictObject({
                method: v.literal("models.list"),
                requestParams: v.tuple([
                    v.literal("includeProviderCapabilities"),
                    v.literal("view"),
                ]),
                rowFields: v.tuple([
                    v.literal("id"),
                    v.literal("name"),
                    v.literal("provider"),
                    v.literal("reasoning"),
                ]),
            }),
            send: v.strictObject({
                acknowledgedStatuses: v.tuple([
                    v.literal("in_flight"),
                    v.literal("ok"),
                    v.literal("started"),
                ]),
                attachmentFields: v.tuple([
                    v.literal("content"),
                    v.literal("fileName"),
                    v.literal("mimeType"),
                    v.literal("sizeBytes"),
                    v.literal("type"),
                ]),
                idempotencyKeyIsRunId: v.literal(true),
                method: v.literal("chat.send"),
            }),
            settings: v.strictObject({
                generationAcknowledgement: v.strictObject({
                    requestField: v.literal("expectedSessionId"),
                    requiredOnFencedMutation: v.literal(true),
                    responseField: v.literal("entry.sessionId"),
                }),
                method: v.literal("sessions.patch"),
                requestParams: v.tuple([
                    v.literal("expectedSessionId"),
                    v.literal("fastMode"),
                    v.literal("key"),
                    v.literal("model"),
                    v.literal("thinkingLevel"),
                ]),
                requiredScope: v.literal("operator.admin"),
            }),
        }),
        subscription: v.strictObject({
            eventNames: v.tuple([v.literal("agent"), v.literal("chat")]),
            methods: v.tuple([
                v.literal("sessions.messages.subscribe"),
                v.literal("sessions.messages.unsubscribe"),
            ]),
            requiresSessionMessageSubscription: v.literal(true),
            slowDeltaPolicy: v.literal("drop-event"),
            slowTerminalPolicy: v.literal("close-socket"),
            states: v.tuple([
                v.literal("aborted"),
                v.literal("delta"),
                v.literal("error"),
                v.literal("final"),
                v.literal("status"),
            ]),
        }),
    }),
    domain: v.literal("chat"),
    methodAccess: v.tuple([
        v.strictObject({
            controlPlaneWrite: v.literal(false),
            name: v.literal("chat.abort"),
            scope: v.literal("operator.write"),
        }),
        v.strictObject({
            controlPlaneWrite: v.literal(false),
            name: v.literal("chat.history"),
            scope: v.literal("operator.read"),
        }),
        v.strictObject({
            controlPlaneWrite: v.literal(false),
            name: v.literal("chat.message.get"),
            scope: v.literal("operator.read"),
        }),
        v.strictObject({
            controlPlaneWrite: v.literal(false),
            name: v.literal("chat.send"),
            scope: v.literal("operator.write"),
        }),
        v.strictObject({
            controlPlaneWrite: v.literal(false),
            name: v.literal("models.list"),
            scope: v.literal("operator.read"),
        }),
        v.strictObject({
            controlPlaneWrite: v.literal(false),
            name: v.literal("sessions.companion.ask"),
            scope: v.literal("operator.read"),
        }),
        v.strictObject({
            controlPlaneWrite: v.literal(true),
            name: v.literal("sessions.companion.reset"),
            scope: v.literal("operator.write"),
        }),
        v.strictObject({
            controlPlaneWrite: v.literal(false),
            name: v.literal("sessions.companion.state"),
            scope: v.literal("operator.read"),
        }),
        v.strictObject({
            controlPlaneWrite: v.literal(false),
            name: v.literal("sessions.messages.subscribe"),
            scope: v.literal("operator.read"),
        }),
        v.strictObject({
            controlPlaneWrite: v.literal(false),
            name: v.literal("sessions.messages.unsubscribe"),
            scope: v.literal("operator.read"),
        }),
    ]),
    streamingPolicy: v.strictObject({
        coalescedAgentStreams: coalescedAgentStreamsSchema,
        deltaThrottleMs: positiveSafeIntegerSchema,
        flushBeforeBoundaries: flushBeforeBoundariesSchema,
        flushBufferedDeltaBeforeTerminal: v.literal(true),
        terminalStates: terminalStatesSchema,
    }),
    syntheticScenarios: syntheticScenariosSchema,
    taskNotificationSend: v.strictObject({
        acknowledgedStatuses: v.tuple([
            v.literal("in_flight"),
            v.literal("ok"),
            v.literal("started"),
        ]),
        idempotencyKeyIsRunId: v.literal(true),
        requiredParams: v.tuple([
            v.literal("idempotencyKey"),
            v.literal("message"),
            v.literal("sessionKey"),
        ]),
    }),
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

const phase4AdapterLaneSchema = v.union([
    v.literal("persistent"),
    v.literal("one-shot-admin"),
]);
const phase4AdapterScopeSchema = v.union([
    v.literal("dynamic"),
    v.literal("operator.admin"),
    v.literal("operator.read"),
]);
const phase4AdapterMethodAccess = (
    method: string,
    lane: v.InferOutput<typeof phase4AdapterLaneSchema>,
    scope: v.InferOutput<typeof phase4AdapterScopeSchema>
) =>
    v.strictObject({
        lane: v.literal(lane),
        method: v.literal(method),
        scope: v.literal(scope),
    });

const sessionsAdapterSchema = v.strictObject({
    acknowledgements: v.strictObject({
        compact: v.strictObject({
            optionalFields: v.tuple([
                v.literal("archived"),
                v.literal("kept"),
                v.literal("reason"),
                v.literal("result"),
            ]),
            requiredFields: v.tuple([
                v.literal("compacted"),
                v.literal("key"),
                v.literal("ok"),
            ]),
            successfulRpcCanReportOkFalse: v.literal(true),
        }),
        delete: v.strictObject({
            okLiteral: v.literal(true),
            optionalFields: v.tuple([v.literal("worktreePreserved")]),
            requiredFields: v.tuple([
                v.literal("archived"),
                v.literal("deleted"),
                v.literal("key"),
                v.literal("ok"),
            ]),
            worktreePreservedFields: v.tuple([
                v.literal("branch"),
                v.literal("id"),
                v.literal("path"),
            ]),
        }),
        reset: v.strictObject({
            okLiteral: v.literal(true),
            optionalFields: v.tuple([
                v.literal("deleted"),
                v.literal("entry"),
                v.literal("resolved"),
            ]),
            requiredFields: v.tuple([v.literal("key"), v.literal("ok")]),
        }),
    }),
    deleteLifecycle: v.strictObject({
        acceptedParams: v.tuple([
            v.literal("agentId"),
            v.literal("archivedOnly"),
            v.literal("deleteTranscript"),
            v.literal("emitLifecycleHooks"),
            v.literal("expectedLifecycleRevision"),
            v.literal("expectedSessionId"),
            v.literal("expectedSessionUpdatedAt"),
            v.literal("key"),
        ]),
        conflict: v.strictObject({
            code: v.literal("INVALID_REQUEST"),
            reason: v.literal("session-changed"),
        }),
        generationFields: v.tuple([
            v.literal("expectedLifecycleRevision"),
            v.literal("expectedSessionId"),
            v.literal("expectedSessionUpdatedAt"),
        ]),
        generationGuardedScope: v.literal("operator.admin"),
        mainSessionProtection: v.strictObject({
            canonicalKeyComparison: v.literal(true),
            configuredKeyResolver: v.literal("resolveMainSessionKey"),
            errorCode: v.literal("INVALID_REQUEST"),
            selectedNonDefaultGlobalException: v.literal(true),
        }),
        requestParams: v.tuple([
            v.literal("deleteTranscript"),
            v.literal("expectedSessionId"),
            v.literal("expectedSessionUpdatedAt"),
            v.literal("key"),
        ]),
    }),
    event: v.strictObject({
        backpressurePaths: v.tuple([
            v.strictObject({
                event: v.literal("sessions.changed"),
                path: v.literal("session-change"),
                slowClient: v.literal("drop-event"),
            }),
            v.strictObject({
                event: v.literal("sessions.changed"),
                path: v.literal("transcript-fallback"),
                slowClient: v.literal("drop-event"),
            }),
            v.strictObject({
                event: v.literal("session.message"),
                path: v.literal("transcript-message"),
                slowClient: v.literal("close-socket"),
            }),
            v.strictObject({
                event: v.literal("sessions.changed"),
                path: v.literal("transcript-snapshot"),
                slowClient: v.literal("close-socket"),
            }),
        ]),
        delivery: v.literal("path-dependent-drop-or-close"),
        lifecycleProjection: v.strictObject({
            compactIsDestructiveOnlyWhenTrue: v.literal(true),
            fields: v.tuple([
                v.literal("compacted"),
                v.literal("reason"),
                v.literal("sessionId"),
                v.literal("sessionKey"),
                v.literal("ts"),
                v.literal("updatedAt"),
            ]),
            lossRequiresReconciliation: v.literal(true),
            reasons: v.tuple([
                v.literal("compact"),
                v.literal("delete"),
                v.literal("new"),
                v.literal("reset"),
            ]),
            resetPreservesSessionId: v.literal(true),
            resetRotatesLifecycleRevision: v.literal(true),
        }),
        name: v.literal("sessions.changed"),
        sequence: v.literal("omitted"),
        targeted: v.literal(true),
    }),
    list: v.strictObject({
        acceptedParams: v.tuple([
            v.literal("activeMinutes"),
            v.literal("agentId"),
            v.literal("archived"),
            v.literal("boardFace"),
            v.literal("configuredAgentsOnly"),
            v.literal("creatorId"),
            v.literal("includeDerivedTitles"),
            v.literal("includeGlobal"),
            v.literal("includeLastMessage"),
            v.literal("includeUnknown"),
            v.literal("label"),
            v.literal("limit"),
            v.literal("offset"),
            v.literal("requireLastInteraction"),
            v.literal("search"),
            v.literal("sortBy"),
            v.literal("spawnedBy"),
        ]),
        derivedRowFields: v.tuple([v.literal("activeRunIds"), v.literal("hasActiveRun")]),
        requestParams: v.tuple([
            v.literal("archived"),
            v.literal("includeGlobal"),
            v.literal("includeUnknown"),
            v.literal("limit"),
            v.literal("sortBy"),
        ]),
        responseMetadata: v.tuple([
            v.literal("count"),
            v.literal("creators"),
            v.literal("defaults"),
            v.literal("hasMore"),
            v.literal("limitApplied"),
            v.literal("nextOffset"),
            v.literal("offset"),
            v.literal("path"),
            v.literal("totalCount"),
            v.literal("ts"),
        ]),
        rowFields: v.tuple([
            v.literal("activeRunIds"),
            v.literal("channel"),
            v.literal("contextTokens"),
            v.literal("createdAt"),
            v.literal("createdVia"),
            v.literal("displayName"),
            v.literal("effectiveFastMode"),
            v.literal("elevatedLevel"),
            v.literal("endedAt"),
            v.literal("fastMode"),
            v.literal("hasActiveRun"),
            v.literal("key"),
            v.literal("kind"),
            v.literal("label"),
            v.literal("model"),
            v.literal("modelProvider"),
            v.literal("parentSessionKey"),
            v.literal("reasoningLevel"),
            v.literal("runtimeMs"),
            v.literal("sessionId"),
            v.literal("spawnedBy"),
            v.literal("startedAt"),
            v.literal("status"),
            v.literal("thinkingDefault"),
            v.literal("thinkingLevel"),
            v.literal("thinkingLevels"),
            v.literal("thinkingOptions"),
            v.literal("totalTokens"),
            v.literal("totalTokensFresh"),
            v.literal("updatedAt"),
            v.literal("verboseLevel"),
        ]),
    }),
    methodAccess: v.tuple([
        phase4AdapterMethodAccess("sessions.compact", "one-shot-admin", "operator.admin"),
        phase4AdapterMethodAccess("sessions.delete", "one-shot-admin", "dynamic"),
        phase4AdapterMethodAccess("sessions.list", "persistent", "operator.read"),
        phase4AdapterMethodAccess("sessions.reset", "one-shot-admin", "operator.admin"),
        phase4AdapterMethodAccess("sessions.subscribe", "persistent", "operator.read"),
    ]),
    subscription: v.strictObject({
        acknowledgementField: v.literal("subscribed"),
        acknowledgementValue: v.literal("Boolean(connId)"),
        connectionIdSource: v.literal("client.connId.trim"),
        effectiveWithSessionScopedCap: v.tuple([
            v.literal("session.message"),
            v.literal("session.operation"),
            v.literal("session.tool"),
            v.literal("sessions.changed"),
        ]),
        registration: v.literal("subscribeSessionEvents"),
        registryTargetedEvents: v.tuple([
            v.literal("session.message"),
            v.literal("session.observer"),
            v.literal("session.operation"),
            v.literal("session.tool"),
            v.literal("sessions.changed"),
        ]),
        requestParams: v.tuple([]),
        requiredAcknowledgement: v.literal(true),
    }),
});

export const sessionsFixtureSchema = v.strictObject({
    ...domainFixtureEntries,
    adapter: sessionsAdapterSchema,
    companion: companionSchema,
    domain: v.literal("sessions"),
    plan: planSchema,
});

export const agentsFixtureSchema = v.strictObject({
    ...domainFixtureEntries,
    domain: v.literal("agents"),
});

const cronRunEnqueuedAcknowledgementSchema = v.strictObject({
    fields: v.tuple([
        v.literal("enqueued"),
        v.literal("ok"),
        v.literal("processInstanceId"),
        v.literal("runId"),
    ]),
    kind: v.literal("enqueued"),
});
const cronRunInvalidSpecFallbackAcknowledgementSchema = v.strictObject({
    fields: v.tuple([v.literal("ok"), v.literal("ran"), v.literal("reason")]),
    kind: v.literal("invalid-spec-fallback"),
});
const cronRunNotRunAcknowledgementSchema = v.strictObject({
    fields: v.tuple([
        v.literal("ok"),
        v.literal("processInstanceId"),
        v.literal("ran"),
        v.literal("reason"),
    ]),
    kind: v.literal("not-run"),
});
const cronRunAcknowledgementVariantsSchema = v.tuple([
    cronRunEnqueuedAcknowledgementSchema,
    cronRunInvalidSpecFallbackAcknowledgementSchema,
    cronRunNotRunAcknowledgementSchema,
]);

const cronDeliveryAuditSchema = v.strictObject({
    full: v.strictObject({
        completionDestination: v.strictObject({
            mode: v.literal("webhook"),
            requiredFields: v.tuple([v.literal("mode"), v.literal("to")]),
        }),
        failureDestination: v.strictObject({
            modes: v.tuple([v.literal("announce"), v.literal("webhook")]),
            optionalFields: v.tuple([
                v.literal("accountId"),
                v.literal("channel"),
                v.literal("mode"),
                v.literal("to"),
            ]),
        }),
        modes: v.tuple([v.literal("announce"), v.literal("none"), v.literal("webhook")]),
        sharedFields: v.tuple([
            v.literal("accountId"),
            v.literal("bestEffort"),
            v.literal("channel"),
            v.literal("failureDestination"),
            v.literal("threadId"),
        ]),
        variantFields: v.strictObject({
            announce: v.tuple([v.literal("completionDestination"), v.literal("to")]),
            none: v.tuple([v.literal("to")]),
            webhookRequired: v.tuple([v.literal("to")]),
        }),
    }),
    merge: v.strictObject({
        explicitNullClears: v.tuple([
            v.literal("accountId"),
            v.literal("channel"),
            v.literal("completionDestination"),
            v.literal("failureDestination"),
            v.literal("threadId"),
            v.literal("to"),
        ]),
        failureDestinationNullClearsWholeDestination: v.literal(true),
        modeSwitchAcrossWebhookBoundaryClearsTo: v.literal(true),
        noneOrWebhookModeClearsOmittedCompletionDestination: v.literal(true),
        webhookModeClears: v.tuple([
            v.literal("accountId"),
            v.literal("channel"),
            v.literal("threadId"),
        ]),
    }),
    patch: v.strictObject({
        fields: v.tuple([
            v.literal("accountId"),
            v.literal("bestEffort"),
            v.literal("channel"),
            v.literal("completionDestination"),
            v.literal("failureDestination"),
            v.literal("mode"),
            v.literal("threadId"),
            v.literal("to"),
        ]),
        failureDestinationNullableFields: v.tuple([
            v.literal("accountId"),
            v.literal("channel"),
            v.literal("mode"),
            v.literal("to"),
        ]),
        nonNullableFields: v.tuple([v.literal("bestEffort"), v.literal("mode")]),
        nullableFields: v.tuple([
            v.literal("accountId"),
            v.literal("channel"),
            v.literal("completionDestination"),
            v.literal("failureDestination"),
            v.literal("threadId"),
            v.literal("to"),
        ]),
    }),
});

const cronAdapterSchema = v.strictObject({
    delivery: cronDeliveryAuditSchema,
    event: v.strictObject({
        delivery: v.literal("best-effort-drop-if-slow"),
        name: v.literal("cron"),
    }),
    jobProjection: v.strictObject({
        deliveryFields: v.tuple([
            v.literal("accountId"),
            v.literal("bestEffort"),
            v.literal("channel"),
            v.literal("completionDestination"),
            v.literal("failureDestination"),
            v.literal("mode"),
            v.literal("threadId"),
            v.literal("to"),
        ]),
        fields: v.tuple([
            v.literal("agentId"),
            v.literal("configRevision"),
            v.literal("createdAtMs"),
            v.literal("delivery"),
            v.literal("description"),
            v.literal("enabled"),
            v.literal("id"),
            v.literal("name"),
            v.literal("payload"),
            v.literal("schedule"),
            v.literal("sessionTarget"),
            v.literal("state"),
            v.literal("updatedAtMs"),
            v.literal("wakeMode"),
        ]),
        payloadFields: v.tuple([
            v.literal("argv"),
            v.literal("kind"),
            v.literal("lightContext"),
            v.literal("message"),
            v.literal("model"),
            v.literal("script"),
            v.literal("text"),
            v.literal("thinking"),
            v.literal("timeoutSeconds"),
        ]),
        scheduleFields: v.tuple([
            v.literal("anchorMs"),
            v.literal("at"),
            v.literal("batchMs"),
            v.literal("command"),
            v.literal("cwd"),
            v.literal("everyMs"),
            v.literal("expr"),
            v.literal("kind"),
            v.literal("match"),
            v.literal("maxBatchBytes"),
            v.literal("mode"),
            v.literal("staggerMs"),
            v.literal("tz"),
        ]),
        stateFields: v.tuple([
            v.literal("consecutiveErrors"),
            v.literal("lastDeliveryStatus"),
            v.literal("lastDurationMs"),
            v.literal("lastErrorReason"),
            v.literal("lastRunAtMs"),
            v.literal("lastRunStatus"),
            v.literal("nextRunAtMs"),
            v.literal("runningAtMs"),
            v.literal("streamStatus"),
        ]),
    }),
    methodAccess: v.tuple([
        phase4AdapterMethodAccess("cron.get", "persistent", "operator.read"),
        phase4AdapterMethodAccess("cron.list", "persistent", "operator.read"),
        phase4AdapterMethodAccess("cron.remove", "one-shot-admin", "operator.admin"),
        phase4AdapterMethodAccess("cron.run", "one-shot-admin", "operator.admin"),
        phase4AdapterMethodAccess("cron.runs", "persistent", "operator.read"),
        phase4AdapterMethodAccess("cron.update", "one-shot-admin", "operator.admin"),
        phase4AdapterMethodAccess("system.info", "persistent", "operator.read"),
    ]),
    operations: v.strictObject({
        get: v.strictObject({
            acceptedParams: v.tuple([v.literal("id"), v.literal("jobId")]),
            method: v.literal("cron.get"),
            requestParams: v.tuple([v.literal("id")]),
            result: v.literal("job-projection"),
        }),
        list: v.strictObject({
            acceptedParams: v.tuple([
                v.literal("agentId"),
                v.literal("compact"),
                v.literal("enabled"),
                v.literal("includeDeliveryPreviews"),
                v.literal("includeDisabled"),
                v.literal("lastRunStatus"),
                v.literal("limit"),
                v.literal("offset"),
                v.literal("query"),
                v.literal("scheduleKind"),
                v.literal("sortBy"),
                v.literal("sortDir"),
            ]),
            compactJobFields: v.tuple([
                v.literal("declarationKey"),
                v.literal("displayName"),
                v.literal("enabled"),
                v.literal("id"),
                v.literal("lastDelivered"),
                v.literal("lastDeliveryError"),
                v.literal("lastDeliveryStatus"),
                v.literal("lastFailureNotificationDelivered"),
                v.literal("lastFailureNotificationDeliveryError"),
                v.literal("lastFailureNotificationDeliveryStatus"),
                v.literal("lastRunAtMs"),
                v.literal("lastRunError"),
                v.literal("lastRunStatus"),
                v.literal("name"),
                v.literal("nextRunAtMs"),
                v.literal("owner"),
                v.literal("scheduleKind"),
                v.literal("trigger"),
            ]),
            compactOmittedJobFields: v.tuple([
                v.literal("agentId"),
                v.literal("configRevision"),
                v.literal("createdAtMs"),
                v.literal("delivery"),
                v.literal("description"),
                v.literal("payload"),
                v.literal("schedule"),
                v.literal("sessionTarget"),
                v.literal("state"),
                v.literal("updatedAtMs"),
                v.literal("wakeMode"),
            ]),
            fullJobProjectionRequiresCompactFalse: v.literal(true),
            method: v.literal("cron.list"),
            requestLiterals: v.strictObject({
                compact: v.literal(false),
                includeDeliveryPreviews: v.literal(false),
            }),
            requestParams: v.tuple([
                v.literal("compact"),
                v.literal("enabled"),
                v.literal("includeDeliveryPreviews"),
                v.literal("lastRunStatus"),
                v.literal("limit"),
                v.literal("offset"),
                v.literal("query"),
                v.literal("scheduleKind"),
                v.literal("sortBy"),
                v.literal("sortDir"),
            ]),
            resultFields: v.tuple([
                v.literal("hasMore"),
                v.literal("jobs"),
                v.literal("limit"),
                v.literal("nextOffset"),
                v.literal("offset"),
                v.literal("snapshotRevision"),
                v.literal("total"),
            ]),
        }),
        remove: v.strictObject({
            acknowledgement: v.strictObject({ removed: v.literal(true) }),
            acceptedParams: v.tuple([v.literal("id"), v.literal("jobId")]),
            method: v.literal("cron.remove"),
            requestParams: v.tuple([v.literal("id")]),
            resultFields: v.tuple([v.literal("removed")]),
        }),
        run: v.strictObject({
            acceptedParams: v.tuple([
                v.literal("expectedProcessInstanceId"),
                v.literal("id"),
                v.literal("jobId"),
                v.literal("mode"),
            ]),
            acknowledgementVariants: cronRunAcknowledgementVariantsSchema,
            method: v.literal("cron.run"),
            requestLiterals: v.strictObject({ mode: v.literal("force") }),
            requestParams: v.tuple([
                v.literal("expectedProcessInstanceId"),
                v.literal("id"),
                v.literal("mode"),
            ]),
        }),
        runs: v.strictObject({
            acceptedParams: v.tuple([
                v.literal("agentId"),
                v.literal("deliveryStatus"),
                v.literal("deliveryStatuses"),
                v.literal("id"),
                v.literal("jobId"),
                v.literal("limit"),
                v.literal("offset"),
                v.literal("query"),
                v.literal("runId"),
                v.literal("scope"),
                v.literal("sortDir"),
                v.literal("status"),
                v.literal("statuses"),
            ]),
            entryFields: v.tuple([
                v.literal("deliveryStatus"),
                v.literal("durationMs"),
                v.literal("errorReason"),
                v.literal("jobId"),
                v.literal("model"),
                v.literal("provider"),
                v.literal("runAtMs"),
                v.literal("runId"),
                v.literal("status"),
                v.literal("summary"),
                v.literal("ts"),
                v.literal("usage"),
            ]),
            method: v.literal("cron.runs"),
            requestLiterals: v.strictObject({ scope: v.literal("job") }),
            requestParams: v.tuple([
                v.literal("deliveryStatuses"),
                v.literal("id"),
                v.literal("limit"),
                v.literal("offset"),
                v.literal("scope"),
                v.literal("sortDir"),
                v.literal("statuses"),
            ]),
            resultFields: v.tuple([
                v.literal("entries"),
                v.literal("hasMore"),
                v.literal("limit"),
                v.literal("nextOffset"),
                v.literal("offset"),
                v.literal("total"),
            ]),
            usageFields: v.tuple([
                v.literal("cache_read_tokens"),
                v.literal("cache_write_tokens"),
                v.literal("input_tokens"),
                v.literal("output_tokens"),
                v.literal("total_tokens"),
            ]),
        }),
        systemInfo: v.strictObject({
            method: v.literal("system.info"),
            processInstanceId: v.strictObject({
                minimumCharacters: v.literal(1),
                optional: v.literal(true),
            }),
            requestParams: v.tuple([]),
            responseFields: v.tuple([
                v.literal("arch"),
                v.literal("cpuCount"),
                v.literal("cpuModel"),
                v.literal("defaultAgentUtilityModel"),
                v.literal("diskAvailableBytes"),
                v.literal("diskPath"),
                v.literal("diskTotalBytes"),
                v.literal("hostname"),
                v.literal("lanAddress"),
                v.literal("loadAverage"),
                v.literal("machineName"),
                v.literal("memoryFreeBytes"),
                v.literal("memoryTotalBytes"),
                v.literal("nodeVersion"),
                v.literal("osLabel"),
                v.literal("pid"),
                v.literal("platform"),
                v.literal("port"),
                v.literal("processInstanceId"),
                v.literal("release"),
                v.literal("uptimeMs"),
            ]),
            responseSchema: v.literal("closed-object"),
        }),
        update: v.strictObject({
            acceptedParams: v.tuple([
                v.literal("expectedConfigRevision"),
                v.literal("id"),
                v.literal("jobId"),
                v.literal("patch"),
            ]),
            acceptedPatchFields: v.tuple([
                v.literal("agentId"),
                v.literal("deleteAfterRun"),
                v.literal("delivery"),
                v.literal("description"),
                v.literal("displayName"),
                v.literal("enabled"),
                v.literal("failureAlert"),
                v.literal("name"),
                v.literal("pacing"),
                v.literal("payload"),
                v.literal("schedule"),
                v.literal("sessionKey"),
                v.literal("sessionTarget"),
                v.literal("state"),
                v.literal("trigger"),
                v.literal("wakeMode"),
            ]),
            method: v.literal("cron.update"),
            requestParams: v.tuple([
                v.literal("expectedConfigRevision"),
                v.literal("id"),
                v.literal("patch"),
            ]),
            requestPatchFields: v.tuple([
                v.literal("delivery"),
                v.literal("description"),
                v.literal("enabled"),
                v.literal("name"),
                v.literal("payload"),
                v.literal("schedule"),
                v.literal("wakeMode"),
            ]),
            result: v.literal("job-projection"),
        }),
    }),
});

export const cronFixtureSchema = v.strictObject({
    ...domainFixtureEntries,
    adapter: cronAdapterSchema,
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
const taskAdapterSchema = v.strictObject({
    cancel: v.strictObject({
        method: v.literal("tasks.cancel"),
        notFoundIsRpcSuccess: v.literal(true),
        requestParams: v.tuple([v.literal("reason"), v.literal("taskId")]),
        resultFields: v.tuple([
            v.literal("cancelled"),
            v.literal("found"),
            v.literal("reason"),
            v.literal("task"),
        ]),
        taskOptional: v.literal(true),
    }),
    event: v.strictObject({
        deletedFields: v.tuple([v.literal("action"), v.literal("taskId")]),
        delivery: v.literal("best-effort-drop-if-slow"),
        restoredFields: v.tuple([v.literal("action")]),
        summariesOmitPrompt: v.literal(true),
        upsertedFields: v.tuple([v.literal("action"), v.literal("task")]),
    }),
    get: v.strictObject({
        method: v.literal("tasks.get"),
        notFound: v.literal("invalid-request-rpc-error"),
        promptIncluded: v.literal(true),
        requestParams: v.tuple([v.literal("taskId")]),
        resultFields: v.tuple([v.literal("task")]),
    }),
    list: v.strictObject({
        cursor: v.literal("decimal-offset"),
        cursorIncrement: v.literal("returned-row-count"),
        method: v.literal("tasks.list"),
        nextCursorOnlyWhenHasMore: v.literal(true),
        promptIncluded: v.literal(false),
        requestParams: v.tuple([
            v.literal("agentId"),
            v.literal("cursor"),
            v.literal("limit"),
            v.literal("sessionKey"),
            v.literal("status"),
        ]),
        resultFields: v.tuple([v.literal("nextCursor"), v.literal("tasks")]),
        statusAcceptsScalarOrArray: v.literal(true),
    }),
    summary: v.strictObject({
        endedAtOptionalForEveryStatus: v.literal(true),
        fields: v.tuple([
            v.literal("agentId"),
            v.literal("childSessionKey"),
            v.literal("createdAt"),
            v.literal("endedAt"),
            v.literal("error"),
            v.literal("flowId"),
            v.literal("id"),
            v.literal("kind"),
            v.literal("lastToolName"),
            v.literal("ownerKey"),
            v.literal("parentTaskId"),
            v.literal("progressSummary"),
            v.literal("prompt"),
            v.literal("runId"),
            v.literal("runtime"),
            v.literal("sessionKey"),
            v.literal("sourceId"),
            v.literal("startedAt"),
            v.literal("status"),
            v.literal("taskId"),
            v.literal("terminalSummary"),
            v.literal("title"),
            v.literal("toolUseCount"),
            v.literal("updatedAt"),
        ]),
        promptOptional: v.literal(true),
        timestampFields: v.tuple([
            v.literal("createdAt"),
            v.literal("endedAt"),
            v.literal("startedAt"),
            v.literal("updatedAt"),
        ]),
        timestampRepresentations: v.tuple([v.literal("integer"), v.literal("string")]),
    }),
});

export const tasksFixtureSchema = v.strictObject({
    adapter: taskAdapterSchema,
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

const settingsMethodAccessSchema = v.tuple([
    v.strictObject({
        controlPlaneWrite: v.literal(false),
        name: v.literal("config.get"),
        scope: v.literal("operator.read"),
    }),
    v.strictObject({
        controlPlaneWrite: v.literal(true),
        name: v.literal("config.patch"),
        scope: v.literal("operator.admin"),
    }),
    v.strictObject({
        controlPlaneWrite: v.literal(false),
        name: v.literal("skills.status"),
        scope: v.literal("operator.read"),
    }),
    v.strictObject({
        controlPlaneWrite: v.literal(false),
        name: v.literal("skills.update"),
        scope: v.literal("operator.admin"),
    }),
]);

/** Exact installed-OpenClaw settings, agent-access, and RPC source facts. */
export const settingsFixtureSchema = v.strictObject({
    agentAccess: v.strictObject({
        configPatchArrayReplacement: v.strictObject({
            destructiveRemovalRequiresDeclaredPath: v.literal(true),
            exactPathTemplates: v.tuple([
                v.literal("agents.entries.<agentId>.tools.alsoAllow"),
                v.literal("agents.entries.<agentId>.tools.deny"),
            ]),
            listedPathReplacesArray: v.literal(true),
            pathComparison: v.literal("normalized-exact"),
        }),
        coreCatalog: v.strictObject({
            canonicalSchedulerTool: v.literal("automations"),
            legacySchedulerAliases: v.tuple([v.literal("cron")]),
            reviewedToolIds: v.tuple([
                v.literal("automations"),
                v.literal("browser"),
                v.literal("edit"),
                v.literal("exec"),
                v.literal("gateway"),
                v.literal("image"),
                v.literal("image_generate"),
                v.literal("memory_search"),
                v.literal("message"),
                v.literal("music_generate"),
                v.literal("nodes"),
                v.literal("read"),
                v.literal("sessions_history"),
                v.literal("sessions_list"),
                v.literal("tts"),
                v.literal("video_generate"),
                v.literal("web_fetch"),
                v.literal("web_search"),
                v.literal("write"),
            ]),
        }),
        entries: v.strictObject({
            blockedObjectKeysRejected: v.literal(true),
            defaultEntryCount: v.literal(1),
            idCaseInsensitive: v.literal(true),
            idMaximumLength: v.literal(64),
            idMinimumLength: v.literal(1),
            idPattern: v.literal("^[a-z0-9_][a-z0-9_-]{0,63}$"),
            inlineIdOmitted: v.literal(true),
            storagePath: v.literal("agents.entries"),
            storageShape: v.literal("record-by-id"),
        }),
        toolsPolicy: v.strictObject({
            aliases: v.tuple([v.literal("bash=>exec"), v.literal("cron=>automations")]),
            nonEmptyAllowAndAlsoAllowConflictRejected: v.literal(true),
            optionalStringArrayFields: v.tuple([
                v.literal("allow"),
                v.literal("alsoAllow"),
                v.literal("deny"),
            ]),
        }),
    }),
    channels: v.strictObject({
        providerEntriesArePassthrough: v.literal(true),
        providerEntryEnabledUnlessExplicitlyFalse: v.literal(true),
        reservedConfigKeys: v.tuple([v.literal("defaults"), v.literal("modelByChannel")]),
    }),
    configGet: v.strictObject({
        cache: v.strictObject({
            bypassedUnlessHotReloadActive: v.literal(true),
            explicitWriteInvalidation: v.literal(true),
            keyFields: v.tuple([
                v.literal("getHotReloadStatus-identity"),
                v.literal("appliedConfigHash"),
                v.literal("pluginRegistryVersion"),
            ]),
            rejectedPromiseEvicted: v.literal(true),
            sharedInFlightPromise: v.literal(true),
        }),
        handlerValidatesParams: v.literal(true),
        method: v.literal("config.get"),
        requestParams: v.tuple([]),
        response: v.strictObject({
            authoredParsedPrecedesEnvironmentResolution: v.literal(true),
            invalidSnapshotClearsConfigPayloads: v.literal(true),
            pluginMetadataOmitted: v.literal(true),
            redactedSnapshotFields: v.tuple([
                v.literal("config"),
                v.literal("parsed"),
                v.literal("raw"),
                v.literal("resolved"),
                v.literal("runtimeConfig"),
                v.literal("sourceConfig"),
            ]),
            revisionHashFields: v.tuple([
                v.literal("appliedConfigHash"),
                v.literal("configRevisionHash"),
            ]),
            snapshotHashPreserved: v.literal(true),
            uiHintsDriveRedaction: v.literal(true),
        }),
    }),
    configPatch: v.strictObject({
        baseHash: v.strictObject({
            blankIsAbsent: v.literal(true),
            generalWritesRequireHash: v.literal(true),
            hashlessLastWriterWinsPaths: v.tuple([v.literal("ui.prefs")]),
            mismatchRejected: v.literal(true),
            protocolOptional: v.literal(true),
            writeUsesSnapshotHash: v.literal(true),
        }),
        handlerValidatesParams: v.literal(true),
        method: v.literal("config.patch"),
        modelNormalization: v.strictObject({
            agentScopeCollections: v.tuple([
                v.literal("defaults"),
                v.literal("entries"),
                v.literal("list"),
            ]),
            agentSelectionFields: v.tuple([
                v.literal("imageModel"),
                v.literal("model"),
                v.literal("pdfModel"),
                v.literal("utilityModel"),
                v.literal("voiceModel"),
            ]),
            appliedBeforeMerge: v.literal(true),
            dynamicEnvironmentRefs: v.strictObject({
                canonicalizedResolvedValueDoesNotRestoreOriginalReference:
                    v.literal(true),
                resolvedBeforeSnapshotValidation: v.literal(true),
                restoredOnlyWhenResolvedValueUnchanged: v.literal(true),
            }),
            googleAliases: v.tuple([
                v.literal("gemini-3-pro=>gemini-3.1-pro-preview"),
                v.literal("gemini-3-pro-preview=>gemini-3.1-pro-preview"),
                v.literal("gemini-3-flash=>gemini-3-flash-preview"),
                v.literal("gemini-3.1-pro=>gemini-3.1-pro-preview"),
                v.literal("gemini-3.1-flash-lite-preview=>gemini-3.1-flash-lite"),
                v.literal("gemini-3.1-flash=>gemini-3-flash-preview"),
                v.literal("gemini-3.1-flash-preview=>gemini-3-flash-preview"),
                v.literal("gemma-4-26b=>gemma-4-26b-a4b-it"),
            ]),
            googleProviderIds: v.tuple([
                v.literal("google"),
                v.literal("google-gemini-cli"),
                v.literal("google-vertex"),
            ]),
            mediaSelectionFields: v.tuple([
                v.literal("image"),
                v.literal("music"),
                v.literal("video"),
            ]),
            modelSelectionShapes: v.tuple([
                v.literal("fallbacks[]"),
                v.literal("primary"),
                v.literal("string"),
            ]),
            nestedAgentModelPaths: v.tuple([
                v.literal("compaction.memoryFlush.model"),
                v.literal("compaction.model"),
                v.literal("heartbeat.model"),
                v.literal("models.<key>"),
                v.literal("subagents.fallbacks[]"),
                v.literal("subagents.model"),
                v.literal("subagents.primary"),
            ]),
            nestedGoogleModelIdsNormalized: v.literal(true),
            normalizesAgentScopes: v.literal(true),
            normalizesProviderCatalogs: v.literal(true),
            providerCatalogModelPath: v.literal("models.providers[].models[].id"),
            togetherAliases: v.tuple([
                v.literal("moonshotai/Kimi-K2.5=>moonshotai/Kimi-K2.6"),
            ]),
            togetherProviderId: v.literal("together"),
            wholeMergedCandidateNormalizedBeforeValidation: v.literal(true),
        }),
        redaction: v.strictObject({
            getAndWriteResponsesRedacted: v.literal(true),
            patchRestoresSensitiveValuesFromSnapshot: v.literal(true),
            reservedOrUnrestorableSentinelRejected: v.literal(true),
            sentinel: v.literal("__OPENCLAW_REDACTED__"),
        }),
        requestParams: v.tuple([
            v.literal("baseHash"),
            v.literal("deliveryContext"),
            v.literal("note"),
            v.literal("raw"),
            v.literal("replacePaths"),
            v.literal("restartDelayMs"),
            v.literal("sessionKey"),
        ]),
        restart: v.strictObject({
            changedPathsDriveRequirement: v.literal(true),
            directRestartConditional: v.literal(true),
            schedulerSuccess: v.strictObject({
                ok: v.literal(true),
                resultFields: v.tuple([
                    v.literal("coalesced"),
                    v.literal("cooldownMsApplied"),
                    v.literal("delayMs"),
                    v.literal("emitHooksQueued"),
                    v.literal("mode"),
                    v.literal("ok"),
                    v.literal("pid"),
                    v.literal("reason"),
                    v.literal("signal"),
                ]),
            }),
            sentinelPersistenceBestEffort: v.literal(true),
            sentinelRequiresRestartPath: v.literal(
                "sentinel.payload.stats.requiresRestart"
            ),
            sentinelResultFields: v.tuple([v.literal("payload"), v.literal("persisted")]),
        }),
        write: v.strictObject({
            arraysMergeById: v.literal(true),
            heartbeatTargetPath: v.literal("agents.defaults.heartbeat.target"),
            heartbeatTargetSchema: v.literal("optional-string"),
            noChangeReturnsNoop: v.literal(true),
            nullDeletesObjectKeys: v.literal(true),
            rawFormat: v.literal("json5-object"),
            replacePathsSupported: v.literal(true),
        }),
    }),
    domain: v.literal("settings"),
    exec: v.strictObject({
        approvalFileConstrainsNonSandbox: v.literal(true),
        defaultAsk: v.literal("off"),
        defaultConfiguredHost: v.literal("auto"),
        defaultSecurityByEffectiveHost: v.strictObject({
            nonSandbox: v.literal("full"),
            sandbox: v.literal("deny"),
        }),
        modePolicies: v.tuple([
            v.literal("allowlist:allowlist:off:no-auto-review"),
            v.literal("ask:allowlist:on-miss:no-auto-review"),
            v.literal("auto:allowlist:on-miss:auto-review"),
            v.literal("deny:deny:off:no-auto-review"),
            v.literal("full:full:off:no-auto-review"),
        ]),
        omittedModeDerivedFromSecurityAndAsk: v.literal(true),
        policyLayerOrder: v.tuple([
            v.literal("global"),
            v.literal("agent"),
            v.literal("session-legacy"),
            v.literal("request-overrides"),
        ]),
    }),
    io: v.strictObject({
        snapshot: v.strictObject({
            configAlias: v.literal("runtimeConfig"),
            includedPathsSource: v.literal("sorted-resolved-include-watch-paths"),
            parsedSource: v.literal("authored-root-before-environment-resolution"),
            resolvedAlias: v.literal("sourceConfig"),
            runtimeConfigSource: v.literal("validated-materialized-source-config"),
            snapshotHashSource: v.literal("root-raw-bytes"),
            sourceConfigSource: v.literal(
                "include-resolved-environment-resolved-migrated-config"
            ),
        }),
        write: v.strictObject({
            includeTargetPersistedConfigSource: v.literal(
                "refreshed-resolved-source-config"
            ),
            includeTargetPersistedHashSource: v.literal("refreshed-root-snapshot-hash"),
            jsonFormat: v.literal("json-two-space-trailing-newline"),
            json5CommentsWarnedAndStripped: v.literal(true),
            rootPersistedHashSource: v.literal("serialized-root-json-bytes"),
            settlement: v.strictObject({
                canonicalRereadBeforeRuntimeRefresh: v.literal(true),
                persistedBeforeCanonicalReread: v.literal(true),
                postCommitFailureCanBeMutationOutcomeUnknown: v.literal(true),
                rollbackFailureSurfaced: v.literal(true),
                rollbackFalseCanLeaveCommittedBytes: v.literal(true),
                runtimeRefreshFailureAttemptsHashGuardedRollback: v.literal(true),
            }),
        }),
    }),
    methodAccess: settingsMethodAccessSchema,
    schemaVersion: fixtureSchemaVersion,
    sessionReset: v.strictObject({
        absentPolicyMode: v.literal("none"),
        defaultAtHour: v.literal(4),
        explicitIdleModePreserved: v.literal(true),
        explicitNoneModePreserved: v.literal(true),
        idleWithoutMinutesDefaultsToZero: v.literal(true),
        presentPolicyWithoutMode: v.literal("daily"),
    }),
    toolActivationDefaults: v.strictObject({
        agentToAgentRequiresExplicitTrue: v.literal(true),
        elevatedEnabledUnlessExplicitlyFalse: v.literal(true),
        webFetchEnabledWhenOmitted: v.literal(true),
        webSearchEnabledWhenOmitted: v.literal(true),
    }),
    skillsStatus: v.strictObject({
        row: v.strictObject({
            disabledFrom: v.literal("skills.entries[skillKey].enabled-equals-false"),
            eligibleRequiresNotDisabled: v.literal(true),
            reviewedFields: v.tuple([
                v.literal("baseDir"),
                v.literal("bundled"),
                v.literal("description"),
                v.literal("disabled"),
                v.literal("eligible"),
                v.literal("filePath"),
                v.literal("name"),
                v.literal("skillKey"),
                v.literal("source"),
            ]),
        }),
        handlerValidatesParams: v.literal(true),
        method: v.literal("skills.status"),
        requestParams: v.tuple([v.literal("agentId")]),
        source: v.strictObject({
            bundling: v.strictObject({
                canonicalBundledSource: v.literal("openclaw-bundled"),
                unknownSourceUsesBundledNameFallback: v.literal(true),
            }),
            fallback: v.strictObject({
                canonicalField: v.literal("skill.source"),
                compatibilityField: v.literal("skill.sourceInfo.source"),
                missingSource: v.literal("unknown"),
            }),
            keyResolution: v.strictObject({
                canonicalField: v.literal("entry.metadata.skillKey"),
                fallbackField: v.literal("skill.name"),
                indexUsesResolver: v.literal(true),
                statusUsesIndexedKey: v.literal(true),
            }),
            taxonomy: v.tuple([
                v.literal("agents-skills-personal"),
                v.literal("agents-skills-project"),
                v.literal("openclaw-bundled"),
                v.literal("openclaw-extra"),
                v.literal("openclaw-managed"),
                v.literal("openclaw-node"),
                v.literal("openclaw-workspace"),
                v.literal("unknown"),
            ]),
        }),
        workspace: v.strictObject({
            defaultAgentResolved: v.literal(true),
            remoteEligibilityIncluded: v.literal(true),
            unknownExplicitAgentRejected: v.literal(true),
            upstreamHostPathFields: v.tuple([
                v.literal("managedSkillsDir"),
                v.literal("skills[].baseDir"),
                v.literal("skills[].filePath"),
                v.literal("workspaceDir"),
            ]),
        }),
    }),
    skillsUpdate: v.strictObject({
        handler: v.strictObject({
            apiKeySemantics: v.tuple([
                v.literal("redacted-sentinel-preserves"),
                v.literal("blank-deletes"),
                v.literal("nonblank-sets"),
            ]),
            afterWriteMode: v.literal("auto"),
            configMutationUsesRetry: v.literal(true),
            enabledBooleanOnly: v.literal(true),
            envSemantics: v.tuple([
                v.literal("blank-key-ignored"),
                v.literal("redacted-sentinel-preserves"),
                v.literal("blank-value-deletes"),
                v.literal("nonblank-value-sets"),
            ]),
            localEntryPath: v.literal("skills.entries[skillKey]"),
            mutationBase: v.literal("source-config-default"),
            responseConfigRedacted: v.literal(true),
            resultFields: v.tuple([
                v.literal("config"),
                v.literal("ok"),
                v.literal("skillKey"),
            ]),
            wholeConfigModelNormalization: v.literal(false),
        }),
        handlerValidatesParams: v.literal(true),
        method: v.literal("skills.update"),
        request: v.strictObject({
            baseHashAccepted: v.literal(false),
            localParams: v.tuple([
                v.literal("apiKey"),
                v.literal("enabled"),
                v.literal("env"),
                v.literal("skillKey"),
            ]),
            unpatchableConfigEntryKeys: v.tuple([
                v.literal("constructor"),
                v.literal("prototype"),
            ]),
        }),
    }),
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
        "agent-config-schema",
        "agent-to-agent-runtime",
        "agent-tools-schema",
        "automations-tool-name",
        "build-info",
        "chat-display-projection",
        "chat-run-projection",
        "chat-send-handler",
        "chat-streaming",
        "channel-config-schema",
        "channel-enabled-default",
        "config-base-hash",
        "config-get-response",
        "config-handlers",
        "config-io",
        "config-merge-patch",
        "config-mutation",
        "config-redaction",
        "control-ui-chat",
        "control-ui-plan-renderer",
        "control-ui-plan-rail",
        "core-tool-catalog",
        "cron-delivery-merge",
        "cron-delivery-normalization",
        "cron-events",
        "cron-handlers",
        "cron-run-history",
        "cron-service",
        "elevated-tool-runtime",
        "exec-defaults-runtime",
        "exec-mode-policy",
        "gateway-broadcaster",
        "gateway-client-caps",
        "gateway-client-modes",
        "gateway-connect-handler",
        "gateway-events",
        "gateway-limits",
        "gateway-methods",
        "gateway-restart-scheduler",
        "gateway-websocket",
        "managed-outgoing-media",
        "media-facts",
        "media-output-directives",
        "media-store-root",
        "method-descriptors",
        "method-scopes",
        "models-handlers",
        "model-input-normalization",
        "model-ref-normalization",
        "package-metadata",
        "plan-tool",
        "protocol-declarations",
        "protocol-schemas",
        "protocol-version",
        "provider-model-id-normalization",
        "runtime-subscriptions",
        "session-companion-rpc",
        "session-companion-runtime",
        "session-change-event",
        "session-event-payload",
        "session-lifecycle",
        "session-list-projection",
        "session-operation-event",
        "session-reset-policy",
        "session-reset-service",
        "session-row-projection",
        "session-subscription-events",
        "sessions-handlers",
        "skills-handlers",
        "skill-key-resolution",
        "skills-discovery",
        "skills-index",
        "skills-source-resolution",
        "skills-status",
        "subagent-control",
        "system-info-handler",
        "task-registry",
        "task-summary",
        "tasks-handlers",
        "tool-policy-normalization",
        "transcript-media-persistence",
        "web-fetch-runtime",
        "web-search-runtime",
    ]),
    sha256: sha256Schema,
});

const sourceArtifactsSchema = v.pipe(
    v.array(sourceArtifactSchema),
    v.length(83),
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
        "settings.json",
        "tasks.json",
    ]),
    sha256: sha256Schema,
});

export const fixtureManifestSchema = v.strictObject({
    components: v.pipe(
        v.array(fixtureManifestEntrySchema),
        v.length(7),
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
        settings: settingsFixtureSchema,
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
export type SettingsFixture = v.InferOutput<typeof settingsFixtureSchema>;
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
