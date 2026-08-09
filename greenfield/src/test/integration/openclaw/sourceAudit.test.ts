import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    assertOpenClawAuditMatchesReviewed,
    defaultReviewedOpenClawFixtureRoot,
    loadReviewedOpenClawFixtures,
    writeOpenClawAuditCandidate,
} from "../../../../scripts/audits/openclaw/reviewedFixtures.ts";
import { parseSourceAuditCliArguments } from "../../../../scripts/audits/openclaw/runSourceAudit.ts";
import { auditInstalledOpenClaw } from "../../../../scripts/audits/openclaw/sourceAudit.ts";
import {
    chatFixtureSchema,
    parseFixtureDocument,
} from "../../../../scripts/audits/openclaw/sourceAuditSchemas.ts";

const sourceVersion = "2026.7.2-beta.7";
const sourceCommit = "dabe1915362e20c25704af91612a32a8f4c96e83";
const sourceBuiltAt = "2026-08-01T19:22:56.002Z";

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
    const result = await operation.catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    return result as Error;
}

async function writeSyntheticOpenClawPackage(sourceRoot: string): Promise<void> {
    const dist = path.join(sourceRoot, "dist");
    const controlUiAssets = path.join(dist, "control-ui", "assets");
    await mkdir(dist, { recursive: true });
    await mkdir(controlUiAssets, { recursive: true });
    const artifacts: Record<string, string> = {
        "build-info.json": `${JSON.stringify({
            builtAt: sourceBuiltAt,
            commit: sourceCommit,
            version: sourceVersion,
        })}\n`,
        "index-fixture.d.ts": `
            declare const PROTOCOL_VERSION: 4;
            declare const ChatEventSchema: unknown;
            state: Type.TLiteral<"status">;
            state: Type.TLiteral<"delta">;
            state: Type.TLiteral<"final">;
            state: Type.TLiteral<"aborted">;
            state: Type.TLiteral<"error">;
            type: Type.TLiteral<"hello-ok">;
            type: Type.TLiteral<"req">;
            type: Type.TLiteral<"res">;
            type: Type.TLiteral<"event">;
        `,
        "server-chat-fixture.js": `
            function flushBufferedChatDeltaIfNeeded() {}
            if (now - (run.deltaSentAt ?? 0) < 150) return;
            if (now - last < 150) return;
            if (evt.stream === "assistant") return "assistant";
            if (evt.stream === "thinking") return "thinking";
            if (toolPhase === "start") flushBufferedChatDeltaIfNeeded();
            if (phase === "start" && (isControlUiVisible || hasSessionMessageSubscribers)) {}
            const emitChatTerminal = (sessionKey, payload, opts) => {
                flushBufferedChatDeltaIfNeeded(sessionKey, opts?.agentId);
                chatRunState.clearRun(clientRunId);
                const terminal = {
                    state: jobState === "done" ? "final" : "aborted"
                };
                const failed = { state: "error" };
                sendChatPayload(sessionKey, payload, opts);
            };
            const sendAgentPayload = () => {};
            if (evt.stream === "plan" && evt.data?.phase === "update") {
                chatRunState.getOrCreate(clientRunId).planSnapshot = {};
            }
            const sessionSubscribers = excludeConnIds(
                sessionEventSubscribers.getAll(),
                runToolRecipients
            );
            broadcastToConnIds("session.tool", payload, sessionSubscribers, {
                dropIfSlow: true
            });
            const flushPayload = {
                state: "delta"
            };
            sendChatPayload(sessionKey, flushPayload, {
                dropIfSlow: true
            });
            run.deltaLastBroadcastLen = text.length;
        `,
        "chat-abort-fixture.js": `
            function resolveInFlightRunSnapshot(params) {
                let best;
                for (const [runId, entry] of params.chatAbortControllers) {
                    if (entry.kind === "agent") continue;
                    const newer = best === undefined || entry.startedAtMs > best.startedAtMs;
                    const tie = best !== undefined && entry.startedAtMs === best.startedAtMs && runId > best.runId;
                    if (newer || tie) best = { runId, startedAtMs: entry.startedAtMs };
                }
                const run = params.chatRunState.runs.get(best.runId);
            }
            function boundInFlightRunSnapshotForChatHistory(params) {
                const messagesBytes = jsonUtf8Bytes(params.messages);
                if (messagesBytes + jsonUtf8Bytes(params.snapshot) <= params.maxBytes) return params.snapshot;
                if (messagesBytes + jsonUtf8Bytes(withoutText) <= params.maxBytes) return withoutText;
                if (messagesBytes + jsonUtf8Bytes(withoutPlan) <= params.maxBytes) return withoutPlan;
            }
            const plan = run?.planSnapshot;
            const withoutText = params.snapshot.plan ? { plan: params.snapshot.plan } : {};
            const droppedPlan = { plan: { steps: [] } };
        `,
        "chat-fixture.js": `
            function loadChatSendSessionContext(params) {
                const { p } = params.request;
                const clientRunId = p.idempotencyKey;
                return { clientRunId };
            }
            /** Load and validate the session/model facts shared by later admission and dispatch phases. */
            async function runChatSendPreAdmission(params) {
                const { clientRunId, pendingChatSendKey } = params.session;
                const cached = context.dedupe.get(\`chat:\${clientRunId}\`);
                if (cached) return cached;
                if (context.dedupe.get(pendingChatSendKey)) {
                    return { runId: clientRunId, status: "in_flight" };
                }
                if (durableClaim.kind === "accepted") {
                    return { runId: clientRunId, status: "ok" };
                }
                return true;
            }
            //#endregion
            //#region src/gateway/server-methods/chat-send-admission.ts
            const ackPayload = {
                runId: clientRunId,
                status: "started"
            };
            respond(true, ackPayload, void 0, { runId: clientRunId });
            const max = Math.min(1e3, typeof limit === "number" ? limit : 200);
            function readChatHistoryMessageId(message) {
                const metadata = message.__openclaw;
                return typeof metadata?.id === "string" ? metadata.id : void 0;
            }
            const nextOffset = hasMore ? candidateNextOffset : void 0;
            sessionInfo.activeRunIds = activeRunState.runIds;
            const boundedInFlightRun = boundInFlightRunSnapshotForChatHistory({
                snapshot: resolveInFlightRunSnapshot({}),
                messages: bounded.messages
            });
            respond(true, {
                sessionKey,
                sessionId,
                messages: bounded.messages,
                ...hasMore ? { nextOffset } : {},
                ...hasMore !== void 0 ? { hasMore } : {},
                ...boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {}
            });
            unavailableReason: "not_found";
            unavailableReason: "not_visible";
            unavailableReason: "oversized";
            assertValidParams(params, validateChatAbortParams, "chat.abort", respond);
            const abortAck = { aborted: runIds.length > 0, runIds };
        `,
        "managed-image-attachments-fixture.js": `
            const OUTGOING_IMAGE_ROUTE_PREFIX = "/api/chat/media/outgoing";
            const MANAGED_OUTGOING_ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f-]+$/i;
            function buildOutgoingVariantUrl(sessionKey, attachmentId, variant) {
                return \`\${OUTGOING_IMAGE_ROUTE_PREFIX}/\${encodeURIComponent(sessionKey)}/\${attachmentId}/\${variant}\`;
            }
            async function recordMatchesTranscriptMessage(record) { return true; }
            async function handleManagedOutgoingMediaHttpRequest(req, res, opts) {
                if (req.method !== "GET" && req.method !== "HEAD") return true;
                MANAGED_OUTGOING_ATTACHMENT_ID_RE.test(attachmentId);
                authorizeGatewayHttpRequestOrReply({ req, res });
                authorizeOperatorScopesForMethod("chat.history", scopes);
                resolveOpenAiCompatibleHttpSenderIsOwner(req, requestAuth);
                if (record.sessionKey !== sessionKey) return true;
                await recordMatchesTranscriptMessage(record);
                await openLocalFileSafely({ filePath });
                resolveByteResponse({
                    rangeHeader: req.headers.range
                });
            }
            //#endregion
        `,
        "models-fixture.js": `
            function buildModelsListResult() {}
            const modelsHandlers = { "models.list": async ({ params, respond }) => {
                if (!assertValidParams(params, validateModelsListParams, "models.list", respond)) return;
                respond(true, await buildModelsListResult({ context, params }));
            } };
        `,
        "system-fixture.js": `
            async function collectSystemInfo(context) {
                return {
                    machineName: await getMachineDisplayName(),
                    hostname: os.hostname(),
                    platform: os.platform(),
                    release: os.release(),
                    arch: os.arch(),
                    osLabel: resolveRuntimeOsLabel(),
                    port: resolveGatewayPort(context.getRuntimeConfig()),
                    nodeVersion: process.version,
                    pid: process.pid,
                    processInstanceId: getGatewayProcessInstanceId(),
                    uptimeMs: Math.round(process.uptime() * 1e3),
                    cpuCount: os.cpus().length,
                    memoryTotalBytes: os.totalmem(),
                    memoryFreeBytes: os.freemem(),
                };
            }
            /** Gateway handlers for identity, host information, heartbeat toggles, and presence events. */
            const systemHandlers = {
                "system.info": async ({ params, respond, context }) => {
                    if (!assertValidParams(params, validateSystemInfoParams, "system.info", respond)) return;
                    respond(true, await collectSystemInfo(context), void 0);
                },
                "system-event": () => {},
            };
        `,
        "core-descriptors-fixture.js": `
            { name: "chat.abort", scope: "operator.write" },
            { name: "chat.history", scope: "operator.read" },
            { name: "chat.message.get", scope: "operator.read" },
            { name: "chat.send", scope: "operator.write" },
            { name: "models.list", scope: "operator.read" },
            { name: "system.info", scope: "operator.read" },
            { name: "tasks.list", scope: "operator.read" },
            { name: "tasks.get", scope: "operator.read" },
            { name: "tasks.cancel", scope: "operator.write" },
            { name: "sessions.companion.ask", scope: "operator.read" },
            { name: "sessions.companion.state", scope: "operator.read" },
            { name: "sessions.companion.reset", scope: "operator.write", controlPlaneWrite: true },
            { name: "sessions.messages.subscribe", scope: "operator.read" },
            { name: "sessions.messages.unsubscribe", scope: "operator.read" },
            { name: "sessions.patch", scope: "dynamic" },
            { name: "sessions.compact", scope: "operator.admin" },
            { name: "sessions.delete", scope: "dynamic" },
            { name: "sessions.list", scope: "operator.read" },
            { name: "sessions.reset", scope: "operator.admin" },
            { name: "sessions.subscribe", scope: "operator.read" },
            { name: "cron.get", scope: "operator.read" },
            { name: "cron.list", scope: "operator.read" },
            { name: "cron.remove", scope: "operator.admin" },
            { name: "cron.run", scope: "operator.admin" },
            { name: "cron.runs", scope: "operator.read" },
            { name: "cron.update", scope: "operator.admin" },
        `,
        "method-scopes-fixture.js": `
            /**
            * sessions.patch fields a write-scoped operator may mutate: user-level chat
            * organization only. Any other field (model, sendPolicy, tool inheritance,
            * exec routing, ...) keeps requiring operator.admin — fail closed on unknowns.
            */
            const SESSIONS_PATCH_WRITE_SCOPE_FIELDS = new Set([
                "key",
                "agentId",
                "label",
                "category",
                "boardFace",
                "icon",
                "pinned",
                "archived",
                "unread"
            ]);
            function resolveSessionsPatchRequiredScopes(params) {
                return Object.keys(params).every((key) =>
                    SESSIONS_PATCH_WRITE_SCOPE_FIELDS.has(key))
                    ? [WRITE_SCOPE] : [ADMIN_SCOPE];
            }
            function resolveSessionsCreateRequiredScopes(params) {}
            // Internal controls (emitLifecycleHooks, expected* CAS guards) stay admin-only
            const SESSIONS_DELETE_WRITE_SCOPE_FIELDS = new Set([
                "key", "agentId", "deleteTranscript", "archivedOnly"
            ]);
            function resolveSessionsDeleteRequiredScopes(params) {
                if (params.archivedOnly !== true) return [ADMIN_SCOPE];
                return Object.keys(params).every((key) =>
                    SESSIONS_DELETE_WRITE_SCOPE_FIELDS.has(key))
                    ? [WRITE_SCOPE] : [ADMIN_SCOPE];
            }
        `,
        "openclaw-tools-fixture.js": `
            const PLAN_STEP_STATUSES = [
                "pending",
                "in_progress",
                "completed"
            ];
            const schema = { minItems: 1 };
            status === "in_progress";
            throw new Error("plan can contain at most one in_progress step");
            const tool = { name: "update_plan", status: "updated" };
        `,
        "src-fixture.js": `
            const ConnectParamsSchema = closedObject({
                minProtocol: Type.Integer({ minimum: 1 }),
                maxProtocol: Type.Integer({ minimum: 1 }),
                client: closedObject({ mode: GatewayClientModeSchema }),
                caps: Type.Optional(Type.Array(NonEmptyString, { default: [] }))
            });
            const HelloOkSchema = closedObject({});
            const TaskLedgerStatusSchema = [
                Type.Literal("queued"), Type.Literal("running"),
                Type.Literal("completed"), Type.Literal("failed"),
                Type.Literal("cancelled"), Type.Literal("timed_out")
            ];
            const TimestampSchema = Type.Union([Type.String(), Type.Integer({ minimum: 0 })]);
            const TaskSummarySchema = closedObject({
\tid: NonEmptyString,
\tkind: Type.Optional(Type.String()),
\truntime: Type.Optional(Type.String()),
\tstatus: TaskLedgerStatusSchema,
\ttitle: Type.Optional(Type.String()),
\tagentId: Type.Optional(Type.String()),
\tsessionKey: Type.Optional(Type.String()),
\tchildSessionKey: Type.Optional(Type.String()),
\townerKey: Type.Optional(Type.String()),
\trunId: Type.Optional(Type.String()),
\ttaskId: Type.Optional(Type.String()),
\tflowId: Type.Optional(Type.String()),
\tparentTaskId: Type.Optional(Type.String()),
\tsourceId: Type.Optional(Type.String()),
\tcreatedAt: Type.Optional(TimestampSchema),
\tupdatedAt: Type.Optional(TimestampSchema),
\tstartedAt: Type.Optional(TimestampSchema),
\tendedAt: Type.Optional(TimestampSchema),
\ttoolUseCount: Type.Optional(Type.Integer({ minimum: 0 })),
\tlastToolName: Type.Optional(Type.String()),
\tprogressSummary: Type.Optional(Type.String()),
\tterminalSummary: Type.Optional(Type.String()),
\terror: Type.Optional(Type.String()),
\tprompt: Type.Optional(Type.String())
            });
            /** Task list filters with bounded pagination. */
            const TasksListParamsSchema = closedObject({
\tstatus: Type.Optional(Type.Union([TaskLedgerStatusSchema, Type.Array(TaskLedgerStatusSchema)])),
\tagentId: Type.Optional(NonEmptyString),
\tsessionKey: Type.Optional(NonEmptyString),
\tlimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
\tcursor: Type.Optional(Type.String())
            });
            /** Task list page response. */
            const TasksListResultSchema = closedObject({
\ttasks: Type.Array(TaskSummarySchema),
\tnextCursor: Type.Optional(Type.String())
            });
            /** Lookup request for one task id. */
            const TasksGetParamsSchema = closedObject({ taskId: NonEmptyString });
            const TasksGetResultSchema = closedObject({ task: TaskSummarySchema });
            const TasksCancelParamsSchema = closedObject({
\ttaskId: NonEmptyString,
\treason: Type.Optional(Type.String())
            });
            /** Cancel result, including the task snapshot when it was found. */
            const TasksCancelResultSchema = closedObject({
\tfound: Type.Boolean(),
\tcancelled: Type.Boolean(),
\treason: Type.Optional(Type.String()),
\ttask: Type.Optional(TaskSummarySchema)
            });
            /** Approval request raised by a plugin before a sensitive tool action proceeds. */

            const SessionCompanionExchangeSchema = closedObject({
\tquestion: Type.String({ minLength: 1, maxLength: 400 }),
\tanswer: Type.String({ minLength: 1, maxLength: 1200 }),
\tts: Type.Integer({ minimum: 0 })
            });
            /** Asks the read-only companion about one session and its workspace. */
            const SessionsCompanionAskParamsSchema = closedObject({
\tsessionKey: NonEmptyString,
\tquestion: Type.String({ minLength: 1, maxLength: 400 })
            });
            /** Companion answer returned only to the requesting operator. */
            const SessionsCompanionAskResultSchema = closedObject({
\tanswer: Type.String({ minLength: 1, maxLength: 1200 }),
\tts: Type.Integer({ minimum: 0 })
            });
            /** Selects the in-memory companion thread for one session. */
            const SessionsCompanionStateParamsSchema = closedObject({ sessionKey: NonEmptyString });
            const SessionsCompanionStateResultSchema = closedObject({ exchanges: Type.Array(SessionCompanionExchangeSchema, { maxItems: 24 }) });
            const SessionsCompanionResetParamsSchema = closedObject({ sessionKey: NonEmptyString });
            const SessionsCompanionResetResultSchema = closedObject({ ok: Type.Literal(true) });
            // Companion answer returned only to the requesting operator.
            // Returned by tasks.get; omitted from list/event summaries.

            const ChatHistoryParamsSchema = closedObject({
\tsessionKey: NonEmptyString,
\tagentId: Type.Optional(NonEmptyString),
\tlimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1e3 })),
\toffset: Type.Optional(Type.Integer({ minimum: 0 })),
\tmessageId: Type.Optional(NonEmptyString),
\tsessionId: Type.Optional(NonEmptyString),
\tmaxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 5e5 }))
            });
            /** Lightweight chat metadata request; optional agent scope keeps selector state explicit. */
            const ChatMetadataParamsSchema = closedObject({});
            /** Fetches one stored chat message without forcing history callers to request huge payloads. */
            const ChatMessageGetParamsSchema = closedObject({
\tsessionKey: NonEmptyString,
\tagentId: Type.Optional(NonEmptyString),
\tmessageId: NonEmptyString,
\tmaxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 2e6 }))
            });
            closedObject({
\tok: Type.Boolean(),
\tmessage: Type.Optional(Type.Unknown()),
\tunavailableReason: Type.Optional(Type.Union([
                    Type.Literal("not_found"),
                    Type.Literal("oversized"),
                    Type.Literal("not_visible")
                ]))
            });
            /** Permissive attachment envelope shared by chat and session entrypoints. */
            const ChatAttachmentSchema = Type.Object({
\ttype: Type.Optional(Type.String()),
\tmimeType: Type.Optional(Type.String()),
\tfileName: Type.Optional(Type.String()),
\tcontent: Type.Optional(Type.Unknown()),
\tsizeBytes: Type.Optional(Type.Number())
            }, { additionalProperties: true });
            /** Attachment list shared by chat.send and session creation's initial turn. */
            const ChatAttachmentsSchema = Type.Array(ChatAttachmentSchema);
            const ChatSendParamsSchema = closedObject({
\tsessionKey: ChatSendSessionKeyString,
\tmessage: Type.String(),
\tthinking: Type.Optional(Type.String()),
\tfastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
\tqueueMode: Type.Optional(Type.String({ enum: ["steer", "followup", "collect", "interrupt"] })),
\tattachments: Type.Optional(ChatAttachmentsSchema),
\tidempotencyKey: NonEmptyString
            });
            /** Cancels the active or named run for a chat session. */

            const ChatAbortParamsSchema = closedObject({
\tsessionKey: NonEmptyString,
\tagentId: Type.Optional(NonEmptyString),
\trunId: Type.Optional(NonEmptyString),
\tpreserveSideRuns: Type.Optional(Type.Boolean())
            });
            /** Inserts an operator-visible synthetic message into an existing chat transcript. */
            const ChatInjectParamsSchema = closedObject({});

            const ChatEventBaseSchema = {
\trunId: NonEmptyString,
\tsessionKey: NonEmptyString,
\tseq: Type.Integer({ minimum: 0 })
            };
            const ChatStatusEventSchema = closedObject({
                ...ChatEventBaseSchema, state: Type.Literal("status")
            });
            const ChatDeltaEventSchema = closedObject({
                ...ChatEventBaseSchema, state: Type.Literal("delta")
            });
            const ChatFinalEventSchema = closedObject({
                ...ChatEventBaseSchema, state: Type.Literal("final")
            });
            const ChatAbortedEventSchema = closedObject({
                ...ChatEventBaseSchema, state: Type.Literal("aborted")
            });
            const ChatErrorEventSchema = closedObject({
                ...ChatEventBaseSchema, state: Type.Literal("error")
            });
            const ChatEventSchema = Type.Union([
                ChatStatusEventSchema,
                ChatDeltaEventSchema,
                ChatFinalEventSchema,
                ChatAbortedEventSchema,
                ChatErrorEventSchema
            ]);
            //#endregion
            //#region packages/gateway-protocol/src/schema/sessions-create.ts

            /** Empty request payload for Gateway host system information. */
            const SystemInfoParamsSchema = closedObject({});
            const UtilityModelStatusSchema = Type.Union([]);
            const SystemInfoResultSchema = closedObject({
\tmachineName: Type.String(),
\thostname: Type.String(),
\tplatform: Type.String(),
\trelease: Type.String(),
\tarch: Type.String(),
\tosLabel: Type.String(),
\tlanAddress: Type.Optional(Type.String()),
\tport: Type.Optional(Type.Integer()),
\tnodeVersion: Type.String(),
\tpid: Type.Integer(),
\tprocessInstanceId: Type.Optional(Type.String({ minLength: 1 })),
\tuptimeMs: Type.Integer(),
\tcpuCount: Type.Integer(),
\tcpuModel: Type.Optional(Type.String()),
\tloadAverage: Type.Optional(Type.Tuple([])),
\tmemoryTotalBytes: Type.Integer(),
\tmemoryFreeBytes: Type.Integer(),
\tdiskTotalBytes: Type.Optional(Type.Integer()),
\tdiskAvailableBytes: Type.Optional(Type.Integer()),
\tdiskPath: Type.Optional(Type.String()),
\tdefaultAgentUtilityModel: Type.Optional(UtilityModelStatusSchema)
            });
            //#endregion
            //#region packages/gateway-protocol/src/schema/task-suggestions.ts

            const SessionRowSchema = Type.Object({
\tkey: Type.String(),
\tsessionId: Type.Optional(Type.String()),
\tkind: Type.String(),
\tlabel: Type.Optional(Type.String()),
\tdisplayName: Type.Optional(Type.String()),
\tchannel: Type.Optional(Type.String()),
\tupdatedAt: Type.Optional(Type.Number()),
\tstatus: Type.Optional(Type.String()),
\tspawnedBy: Type.Optional(Type.String()),
\tparentSessionKey: Type.Optional(Type.String()),
\tcreatedVia: Type.Optional(Type.String()),
\tcreatedAt: Type.Optional(Type.Number()),
\ttotalTokens: Type.Optional(Type.Number()),
\ttotalTokensFresh: Type.Optional(Type.Boolean()),
\tcontextTokens: Type.Optional(Type.Number()),
\tmodel: Type.Optional(Type.String()),
\tmodelProvider: Type.Optional(Type.String())
            }, { additionalProperties: true });
            //#endregion
            //#region packages/gateway-protocol/src/schema/sessions-catalog.ts

            const SessionsListParamsSchema = closedObject({
\tlimit: Type.Optional(Type.Integer()),
\toffset: Type.Optional(Type.Integer()),
\tactiveMinutes: Type.Optional(Type.Integer()),
\trequireLastInteraction: Type.Optional(Type.Boolean()),
\tsortBy: Type.Optional(Type.String()),
\tincludeGlobal: Type.Optional(Type.Boolean()),
\tincludeUnknown: Type.Optional(Type.Boolean()),
\tconfiguredAgentsOnly: Type.Optional(Type.Boolean()),
\tincludeDerivedTitles: Type.Optional(Type.Boolean()),
\tincludeLastMessage: Type.Optional(Type.Boolean()),
\tlabel: Type.Optional(Type.String()),
\tboardFace: Type.Optional(Type.String()),
\tcreatorId: Type.Optional(Type.String()),
\tspawnedBy: Type.Optional(Type.String()),
\tagentId: Type.Optional(Type.String()),
\tsearch: Type.Optional(Type.String()),
\tarchived: Type.Optional(Type.Boolean())
            });
            /** Searches one agent's indexed session transcripts */

            /** Subscribes a client to live message updates for one session. */
            const SessionsMessagesSubscribeParamsSchema = closedObject({
\tkey: NonEmptyString,
\tagentId: Type.Optional(NonEmptyString),
\tincludeApprovals: Type.Optional(Type.Literal(true))
            });
            /** Removes a live message subscription for one session. */
            const SessionsMessagesUnsubscribeParamsSchema = closedObject({
\tkey: NonEmptyString,
\tagentId: Type.Optional(NonEmptyString)
            });
            /** Aborts the active or named run for a session. */
            const SessionsAbortParamsSchema = closedObject({});
            /** Mutable per-session preferences and routing metadata. */
            const SessionsPatchParamsSchema = closedObject({
\tkey: NonEmptyString,
\texpectedSessionId: Type.Optional(NonEmptyString),
\tthinkingLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
\tfastMode: Type.Optional(Type.Union([
                    Type.Boolean(), Type.Literal("auto"), Type.Null()
                ])),
\tmodel: Type.Optional(Type.Union([NonEmptyString, Type.Null()]))
            });
            /** Updates or clears one plugin namespace value on a session record. */
            const SessionsPluginPatchParamsSchema = closedObject({});

            const SessionsResetParamsSchema = closedObject({
\tkey: NonEmptyString,
\tagentId: Type.Optional(NonEmptyString),
\treason: Type.Optional(Type.String())
            });
            /** Deletes a session record and optionally its transcript. */
            const SessionsDeleteParamsSchema = closedObject({
\tkey: NonEmptyString,
\tagentId: Type.Optional(NonEmptyString),
\tdeleteTranscript: Type.Optional(Type.Boolean()),
\texpectedSessionId: Type.Optional(NonEmptyString),
\texpectedLifecycleRevision: Type.Optional(NonEmptyString),
\texpectedSessionUpdatedAt: Type.Optional(Type.Number()),
\temitLifecycleHooks: Type.Optional(Type.Boolean()),
\tarchivedOnly: Type.Optional(Type.Boolean())
            });
            /** Lists the gateway-owned custom session group catalog */

            const SessionsCompactParamsSchema = closedObject({
\tkey: NonEmptyString,
\tagentId: Type.Optional(NonEmptyString),
\tmaxLines: Type.Optional(Type.Integer())
            });
            /** Lists compaction checkpoints for one session. */

            const CronCommonOptionalFields = {
\tagentId: Type.Optional(NonEmptyString),
\tsessionKey: Type.Optional(NonEmptyString),
\tdescription: Type.Optional(Type.String()),
\tenabled: Type.Optional(Type.Boolean()),
\tdeleteAfterRun: Type.Optional(Type.Boolean())
            };
            function cronIdOrJobIdParams(extraFields) {
                return Type.Union([
                    closedObject({ id: NonEmptyString, ...extraFields }),
                    closedObject({ jobId: NonEmptyString, ...extraFields })
                ]);
            }
            const CronRunLogJobIdSchema = Type.String();

            const CronScheduleSchema = Type.Union([
                closedObject({
                    kind: Type.Literal("at"), at: NonEmptyString
                }),
                closedObject({
                    kind: Type.Literal("every"), everyMs: Type.Integer(),
                    anchorMs: Type.Optional(Type.Integer())
                }),
                closedObject({
                    kind: Type.Literal("cron"), expr: NonEmptyString,
                    tz: Type.Optional(Type.String()), staggerMs: Type.Optional(Type.Integer())
                }),
                closedObject({
                    kind: Type.Literal("on-exit"), command: NonEmptyString,
                    cwd: Type.Optional(NonEmptyString)
                }),
                closedObject({
                    kind: Type.Literal("stream"), command: Type.Array(NonEmptyString),
                    cwd: Type.Optional(NonEmptyString), mode: Type.Optional(Type.String()),
                    match: Type.Optional(Type.String()), batchMs: Type.Optional(Type.Integer()),
                    maxBatchBytes: Type.Optional(Type.Integer())
                })
            ]);
            /** Headless condition script evaluated before a recurring cron payload runs. */

            function cronAgentTurnPayloadSchema(params) {
                return closedObject({
                    kind: Type.Literal("agentTurn"),
                    message: params.message,
                    model: Type.Optional(params.model),
                    thinking: Type.Optional(params.thinking),
                    timeoutSeconds: Type.Optional(Type.Number()),
                    lightContext: Type.Optional(Type.Boolean())
                });
            }
            function cronCommandPayloadSchema(params) {
                return closedObject({
                    kind: Type.Literal("command"), argv: params.argv
                });
            }
            function cronScriptPayloadSchema(params) {
                return closedObject({
                    kind: Type.Literal("script"), script: params.script,
                    timeoutSeconds: Type.Optional(Type.Number())
                });
            }
            /** Session target accepted by cron jobs. */
            const CronPayloadSchema = Type.Union([
                closedObject({ kind: Type.Literal("systemEvent"), text: NonEmptyString })
            ]);
            const CronReportedPayloadSchema = Type.Union([
                ...CronPayloadSchema.anyOf,
                closedObject({ kind: Type.Literal("heartbeat") })
            ]);

            const CronFailureDestinationSchema = closedObject({
\tchannel: Type.Optional(CronAnnounceChannelSchema),
\tto: Type.Optional(NonBlankString),
\taccountId: Type.Optional(NonEmptyString),
\tmode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("webhook")]))
            });
            const CronFailureDestinationPatchSchema = closedObject({
\tchannel: Type.Optional(Type.Union([CronAnnounceChannelSchema, Type.Null()])),
\tto: Type.Optional(Type.Union([NonBlankString, Type.Null()])),
\taccountId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
\tmode: Type.Optional(Type.Union([
                    Type.Literal("announce"), Type.Literal("webhook"), Type.Null()
                ]))
            });
            const CronCompletionDestinationSchema = closedObject({
\tmode: Type.Literal("webhook"),
\tto: NonBlankString
            });
            const CronDeliverySharedProperties = {
\tchannel: Type.Optional(CronAnnounceChannelSchema),
\tthreadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
\taccountId: Type.Optional(NonEmptyString),
\tbestEffort: Type.Optional(Type.Boolean()),
\tfailureDestination: Type.Optional(CronFailureDestinationSchema)
            };
            const CronDeliveryPatchSharedProperties = {
\tchannel: Type.Optional(Type.Union([CronAnnounceChannelSchema, Type.Null()])),
\tthreadId: Type.Optional(Type.Union([
                    Type.String(), Type.Number(), Type.Null()
                ])),
\taccountId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
\tbestEffort: Type.Optional(Type.Boolean()),
\tfailureDestination: Type.Optional(Type.Union([CronFailureDestinationPatchSchema, Type.Null()]))
            };
            const CronDeliveryNoopSchema = closedObject({
                mode: Type.Literal("none"),
                ...CronDeliverySharedProperties,
                to: Type.Optional(NonBlankString)
            });
            const CronDeliveryAnnounceSchema = closedObject({
                mode: Type.Literal("announce"),
                ...CronDeliverySharedProperties,
                completionDestination: Type.Optional(CronCompletionDestinationSchema),
                to: Type.Optional(NonBlankString)
            });
            const CronDeliveryWebhookSchema = closedObject({
                mode: Type.Literal("webhook"),
                ...CronDeliverySharedProperties,
                to: NonBlankString
            });
            const CronDeliverySchema = Type.Union([
                CronDeliveryNoopSchema,
                CronDeliveryAnnounceSchema,
                CronDeliveryWebhookSchema
            ]);
            /** Patch shape for cron delivery policy updates. */
            const CronDeliveryPatchSchema = closedObject({
\tmode: Type.Optional(Type.Union([
                    Type.Literal("none"), Type.Literal("announce"), Type.Literal("webhook")
                ])),
                ...CronDeliveryPatchSharedProperties,
\tcompletionDestination: Type.Optional(Type.Union([CronCompletionDestinationSchema, Type.Null()])),
\tto: Type.Optional(Type.Union([NonBlankString, Type.Null()]))
            });
            const CronFailureNotificationDeliverySchema = closedObject({});

            const CronJobStateSchema = closedObject({
\tnextRunAtMs: Type.Optional(Type.Integer()),
\trunningAtMs: Type.Optional(Type.Integer()),
\tlastRunAtMs: Type.Optional(Type.Integer()),
\tlastRunStatus: Type.Optional(Type.String()),
\tlastErrorReason: Type.Optional(Type.String()),
\tlastDurationMs: Type.Optional(Type.Integer()),
\tconsecutiveErrors: Type.Optional(Type.Integer()),
\tlastDeliveryStatus: Type.Optional(Type.String()),
\tstreamStatus: Type.Optional(Type.String())
            });
            /** Persisted cron job definition returned by scheduler list/get APIs. */
            const CronJobSchema = closedObject({
\tid: NonEmptyString,
\tagentId: Type.Optional(NonEmptyString),
\tname: NonEmptyString,
\tdescription: Type.Optional(Type.String()),
\tenabled: Type.Boolean(),
\tcreatedAtMs: Type.Integer(),
\tupdatedAtMs: Type.Integer(),
\tconfigRevision: Type.Optional(Type.String()),
\tschedule: CronScheduleSchema,
\tsessionTarget: Type.String(),
\twakeMode: Type.String(),
\tpayload: CronReportedPayloadSchema,
\tdelivery: Type.Optional(Type.Object({ mode: Type.String() })),
\tstate: CronJobStateSchema
            });
            /** Query params for listing cron jobs with filters and pagination. */
            const CronListParamsSchema = closedObject({
\tincludeDisabled: Type.Optional(Type.Boolean()),
\tlimit: Type.Optional(Type.Integer()),
\toffset: Type.Optional(Type.Integer()),
\tquery: Type.Optional(Type.String()),
\tenabled: Type.Optional(Type.String()),
\tscheduleKind: Type.Optional(Type.String()),
\tlastRunStatus: Type.Optional(Type.String()),
\tsortBy: Type.Optional(Type.String()),
\tsortDir: Type.Optional(Type.String()),
\tagentId: Type.Optional(NonEmptyString),
\tcompact: Type.Optional(Type.Boolean()),
\tincludeDeliveryPreviews: Type.Optional(Type.Boolean())
            });
            /** Empty request payload for scheduler status. */
            const CronGetParamsSchema = cronIdOrJobIdParams({});
            const CronUpdateParamsSchema = cronIdOrJobIdParams({
\tpatch: closedObject({
\t\tname: Type.Optional(NonEmptyString),
\t\tdisplayName: Type.Optional(Type.String()),
                ...CronCommonOptionalFields,
\t\tschedule: Type.Optional(CronScheduleSchema),
\t\tpacing: Type.Optional(Type.Unknown()),
\t\ttrigger: Type.Optional(Type.Unknown()),
\t\tsessionTarget: Type.Optional(Type.String()),
\t\twakeMode: Type.Optional(Type.String()),
\t\tpayload: Type.Optional(Type.Unknown()),
\t\tdelivery: Type.Optional(Type.Unknown()),
\t\tfailureAlert: Type.Optional(Type.Unknown()),
\t\tstate: Type.Optional(Type.Unknown())
                }),
\texpectedConfigRevision: Type.Optional(Type.String())
            });
            /** Removes a cron job by id or legacy jobId alias. */
            const CronRemoveParamsSchema = cronIdOrJobIdParams({});
            const CronRunParamsSchema = cronIdOrJobIdParams({
\tmode: Type.Optional(Type.String()),
\texpectedProcessInstanceId: Type.Optional(NonEmptyString)
            });
            /** Query params for cron run history. */
            const CronRunsParamsSchema = closedObject({
\tagentId: Type.Optional(NonEmptyString),
\tscope: Type.Optional(Type.String()),
\tid: Type.Optional(CronRunLogJobIdSchema),
\tjobId: Type.Optional(CronRunLogJobIdSchema),
\trunId: Type.Optional(NonEmptyString),
\tlimit: Type.Optional(Type.Integer()),
\toffset: Type.Optional(Type.Integer()),
\tstatuses: Type.Optional(Type.Array(Type.String())),
\tstatus: Type.Optional(Type.String()),
\tdeliveryStatuses: Type.Optional(Type.Array(Type.String())),
\tdeliveryStatus: Type.Optional(Type.String()),
\tquery: Type.Optional(Type.String()),
\tsortDir: Type.Optional(Type.String())
            });
            closedObject({
\tts: Type.Integer({ minimum: 0 }),
\tjobId: NonEmptyString,
\tstatus: Type.Optional(Type.String()),
\terrorReason: Type.Optional(Type.String()),
\tsummary: Type.Optional(Type.String()),
\tdeliveryStatus: Type.Optional(Type.String()),
\trunId: Type.Optional(NonEmptyString),
\trunAtMs: Type.Optional(Type.Integer()),
\tdurationMs: Type.Optional(Type.Integer()),
\tmodel: Type.Optional(Type.String()),
\tprovider: Type.Optional(Type.String()),
\tusage: Type.Optional(closedObject({
                    input_tokens: Type.Optional(Type.Number()),
                    output_tokens: Type.Optional(Type.Number()),
                    total_tokens: Type.Optional(Type.Number()),
                    cache_read_tokens: Type.Optional(Type.Number()),
                    cache_write_tokens: Type.Optional(Type.Number())
                }))
            });
            /** Model option shown in selectors and model catalog results. */
            const ModelChoiceSchema = closedObject({
\tid: NonEmptyString,
\tname: NonEmptyString,
\tprovider: NonEmptyString,
\treasoning: Type.Optional(Type.Boolean())
            });
            /** Semantic owner of an agent roster entry. */
            const AgentKindSchema = Type.Union([]);
            /** Model catalog request with optional visibility scope. */
            const ModelsListParamsSchema = closedObject({
\tincludeProviderCapabilities: Type.Optional(Type.Boolean()),
\tview: Type.Optional(Type.Union([Type.Literal("configured")]))
            });
            /** Reads model-provider credential health for one configured agent. */
            const ModelsAuthStatusParamsSchema = closedObject({});
            //#region packages/gateway-protocol/src/schema/environments.ts
        `,
        "server-runtime-subscriptions-fixture.js": `
            const SESSION_COMPANION_IDLE_TTL_MS = 120 * 6e4;
            const SESSION_COMPANION_SWEEP_INTERVAL_MS = 10 * 6e4;
            function createSessionCompanion() {
                const threads = /* @__PURE__ */ new Map();
                const reset = (sessionKey) => {
                    const key = sessionKey.trim();
                    askRuntime.cancel(key);
                    threads.delete(key);
                };
                return {
                    state(sessionKey) {
                        const key = sessionKey.trim();
                        const thread = threads.get(key);
                        return thread;
                    }
                };
            }
            const upserted = {
                action: "upserted",
                task: mapTaskSummary(event.task)
            };
            const deleted = {
                action: "deleted",
                taskId: event.taskId
            };
            payload = { action: "restored" };
            params.broadcast("task", payload, { dropIfSlow: true });
            function createSessionObserverAudience(params) {
                params.sessionEventSubscribers?.getAll();
                return { recipients() {} };
            }
            deps.broadcastToConnIds("session.observer", digest,
                audience.recipients(sessionKey), { dropIfSlow: true });
        `,
        "session-companion-rpc-fixture.js": `
            "sessions.companion.ask";
            "sessions.companion.state";
            "sessions.companion.reset";
            if (!client?.connId) throw new Error();
            respond(true, await context.sessionCompanion.ask({
                sessionKey,
                question,
                connId: client.connId
            }));
            respond(true, context.sessionCompanion.state(sessionKey));
            context.sessionCompanion.reset(sessionKey);
            respond(true, { ok: true });
            SESSION_COMPANION_BUSY;
            const details = { retryable: true };
        `,
        "session-companion-ask-fixture.js": `
            const SESSION_COMPANION_TOOLS = [
                "read",
                "sessions_history",
                "sessions_search"
            ];
            const policy = { visibility: "self", workspaceOnly: true, enabled: false };
            const SESSION_COMPANION_MAX_EXCHANGES = 24;
            const SESSION_COMPANION_MAX_EXCHANGE_BYTES = 48 * 1024;
            const ASK_TIMEOUT_MS = 6e4;
            const ANSWER_MAX_CHARS = 1200;
            const SEED_MAX_BYTES = 24 * 1024;
            const SEED_MESSAGE_MAX_CHARS = 4e3;
            const MAX_CONCURRENT_ASKS = 6;
            const MAX_ASKS_PER_RATE_WINDOW = 12;
            const MAX_ASKS_PER_CONNECTION_RATE_WINDOW = 4;
            messages.slice(-40);
            const run = { disableMessageTool: true };
            throw new Error("The session companion is answering another question.");
        `,
        "session-change-event-fixture.js": `
            function emitSessionsChanged(context, payload) {
                context.broadcastToConnIds("sessions.changed", {
                    ...payload,
                    ts: Date.now(),
                    ...buildGatewaySessionEventFields({ sessionRow })
                }, connIds, {
                    dropIfSlow: true
                });
            }
        `,
        "session-event-payload-fixture.js": `
            function buildGatewaySessionEventFields(params) {
                const sessionRow = params.sessionRow;
                return {
                    updatedAt: sessionRow.updatedAt ?? void 0,
                    sessionId: sessionRow.sessionId
                };
            }
        `,
        "sessions-shared-fixture.js": `
            function emitSessionOperation(context, payload) {
                const connIds = context.getSessionEventSubscriberConnIds();
                context.broadcastToConnIds("session.operation", payload, connIds, {
                    dropIfSlow: true
                });
            }
        `,
        "server-session-events-fixture.js": `
            function broadcastSessionMessage(params, update) {
                const connIds = params.sessionEventSubscribers.getAll();
                if (update.message === void 0) {
                    params.broadcastToConnIds("sessions.changed", update, connIds);
                    return;
                }
                const idempotencyKey = readMessageIdempotencyKey(update.message);
                const message = projectChatDisplayMessage(update.message);
                if (message) {
                    params.broadcastToConnIds("session.message", update, connIds);
                    return;
                }
                const sessionEventConnIds = params.sessionEventSubscribers.getAll();
                params.broadcastToConnIds("sessions.changed", update,
                    sessionEventConnIds, { dropIfSlow: true });
            }
            /** Creates a lifecycle-event broadcaster for session list refreshes. */
        `,
        "lifecycle-fixture.js": `
            const SESSION_LIFECYCLE_CHANGED_ERROR_REASON = "session-changed";
            function resolveSessionWorkStartError() {}
        `,
        "session-utils-list-fixture.js": `
            function buildSessionsListResult(params) {
                const { list, sessions } = params;
                return {
                    ts: list.now,
                    path: list.storePath,
                    count: sessions.length,
                    totalCount: list.totalCount,
                    limitApplied: list.limitApplied,
                    offset: list.offset > 0 ? list.offset : void 0,
                    nextOffset: list.nextOffset,
                    hasMore: list.hasMore,
                    creators: list.creators,
                    defaults: getSessionDefaults(params.cfg),
                    sessions
                };
            }
            function filterAndSortSessionEntries(params) {}
        `,
        "session-reset-service-fixture.js": `
            async function performGatewaySessionReset() {
                const nextSessionId = currentEntry?.sessionId ?? randomUUID();
                return {
                    sessionId: nextSessionId,
                    lifecycleRevision: randomUUID()
                };
            }
        `,
        "session-utils-row-fixture.js": `
            function buildGatewaySessionRow(params) {
                const thinkingProjection = resolveGatewaySessionThinkingProjectionInternal({});
                const fastModeState = {};
                return {
\t\tkey,
\t\tspawnedBy: subagentOwner || entry?.spawnedBy,
\t\tcreatedVia: entry?.createdVia,
\t\tcreatedAt: entry?.createdAt,
\t\tkind: gatewayKind,
\t\tlabel: entry?.label,
\t\tdisplayName,
\t\tchannel,
\t\tupdatedAt,
\t\tsessionId: entry?.sessionId,
\t\tthinkingLevel: thinkingProjection.thinkingLevel,
\t\tthinkingLevels: thinkingProjection.thinkingLevels,
\t\tthinkingOptions: thinkingProjection.thinkingOptions,
\t\tthinkingDefault: thinkingProjection.thinkingDefault,
\t\tfastMode: entry?.fastMode,
\t\teffectiveFastMode: fastModeState.mode,
\t\tverboseLevel: entry?.verboseLevel,
\t\treasoningLevel: entry?.reasoningLevel,
\t\televatedLevel: entry?.elevatedLevel,
\t\ttotalTokens,
\t\ttotalTokensFresh,
\t\tstatus: subagentRun ? subagentStatus : entry?.status,
\t\tstartedAt: subagentRun ? subagentStartedAt : entry?.startedAt,
\t\tendedAt: subagentRun ? subagentEndedAt : entry?.endedAt,
\t\truntimeMs: subagentRun ? subagentRuntimeMs : entry?.runtimeMs,
\t\tparentSessionKey: entry?.parentSessionKey,
\t\tmodelProvider: rowModelProvider,
\t\tmodel: rowModel,
\t\tcontextTokens,
                };
            }
            //#endregion
        `,
        "sessions-fixture.js": `
            const sessionCompactHandlers = {
                "sessions.compact": async () => {
                    const event = { reason: "compact", compacted: true };
                    respond(true, {
                        ok: result.ok,
                        key: target.canonicalKey,
                        compacted: result.compacted,
                        reason: result.reason,
                        result: result.result
                    });
                }
            };
            const sessionDeleteHandlers = {
                "sessions.delete": async () => {
                    const event = { reason: "delete" };
                    const mainKey = resolveMainSessionKey(cfg);
                    const isSelectedNonDefaultGlobal = target.canonicalKey === "global" &&
                        requestedAgentId !== resolveDefaultAgentId(cfg);
                    if (target.canonicalKey === mainKey && !isSelectedNonDefaultGlobal) {
                        errorShape(
                            ErrorCodes.INVALID_REQUEST,
                            "Cannot delete the main session (\${mainKey})."
                        );
                    }
                    expectedLifecycleRevision;
                    expectedSessionId;
                    expectedSessionUpdatedAt;
                    ErrorCodes.INVALID_REQUEST;
                    details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON };
                    const archived = deletion.archivedTranscripts.map((entry) => entry.path);
                    worktreePreserved = { id, branch, path };
                    respond(true, { ok: true, key, deleted, archived, worktreePreserved });
                }
            };
            const sessionHandlers = {
                "sessions.subscribe": ({ client, context, respond }) => {
                    const connId = client?.connId?.trim();
                    if (connId) context.subscribeSessionEvents(connId);
                    respond(true, { subscribed: Boolean(connId) });
                },
                "sessions.unsubscribe": ({ client, context, respond }) => {
                    respond(true, { subscribed: false });
                },
                "sessions.reset": async () => {
                    const reason = p.reason === "new" ? "new" : "reset";
                    if ("incognitoDeleted" in result) {
                        respond(true, { ok: true, key: result.key, deleted: true });
                    }
                    respond(true, {
                        ok: true,
                        key: result.key,
                        entry: result.entry,
                        resolved: result.resolved
                    });
                },
                "sessions.list": async () => ({
                    ...session,
                    hasActiveRun: activeRunState.active,
                    ...activeRunState.runIds.length > 0 ? {
                        activeRunIds: activeRunState.runIds
                    } : {}
                }),
                "sessions.patch": async () => {
                    const expectedSessionChanged = p.expectedSessionId !== void 0 && currentLifecycleEntry?.sessionId !== p.expectedSessionId;
                    respond(true, {
                        entry: applied.entry,
                        resolved: {
                            model: resolvedDisplayModel.model,
                            thinkingLevel: thinkingProjection.effectiveThinkingLevel
                        }
                    });
                },
                "sessions.pluginPatch": async () => {},
                "sessions.messages.subscribe": ({ client, context, respond }) => {
                    context.subscribeSessionMessageEvents(connId, subscriptionKey);
                    respond(true, {
                        subscribed: true,
                        key: canonicalKey
                    });
                },
                "sessions.messages.unsubscribe": ({ client, context, respond }) => {
                    context.unsubscribeSessionMessageEvents(connId, subscriptionKey);
                    respond(true, {
                        subscribed: false,
                        key: canonicalKey
                    });
                }
            };
            //#endregion
            //#region src/gateway/server-methods/session-typing-state.ts
        `,
        "cron-fixture.js": `
            function cronJobReadView(job) {
                return { ...job, configRevision: revision };
            }
            function compactCronListJob(job) {
                return {
                    id: job.id,
                    name: job.name,
                    ...job.declarationKey ? { declarationKey: job.declarationKey } : {},
                    ...job.displayName ? { displayName: job.displayName } : {},
                    ...job.owner ? { owner: job.owner } : {},
                    enabled: job.enabled,
                    nextRunAtMs: job.state.nextRunAtMs,
                    scheduleKind: job.schedule.kind,
                    ...job.trigger ? { trigger: true } : {},
                    lastRunAtMs: job.state.lastRunAtMs,
                    lastRunStatus: job.state.lastRunStatus,
                    lastRunError: job.state.lastError,
                    lastDelivered: job.state.lastDelivered,
                    lastDeliveryStatus: job.state.lastDeliveryStatus,
                    lastDeliveryError: job.state.lastDeliveryError,
                    lastFailureNotificationDelivered: job.state.lastFailureNotificationDelivered,
                    lastFailureNotificationDeliveryStatus: job.state.lastFailureNotificationDeliveryStatus,
                    lastFailureNotificationDeliveryError: job.state.lastFailureNotificationDeliveryError
                };
            }
            async function assertValidCronUpdatePatch(params) {}
            const cronHandlers = {
                "cron.get": async () => respond(true, cronJobReadView(job), void 0),
                "cron.list": async () => {
                    if (p.compact === true) {
                        respond(true, { jobs: page.jobs.map(compactCronListJob) });
                    }
                    if (p.includeDeliveryPreviews === false) respond(true, page);
                },
                "cron.update": async () => {
                    expectedConfigRevision;
                    code: "CRON_JOB_CHANGED";
                    respond(true, cronJobReadView(job), void 0);
                },
                "cron.remove": async () => {
                    if (!result.removed) return;
                },
                "cron.run": async () => {
                    expectedProcessInstanceId;
                    if (isInvalidCronSessionTargetIdError(error)) {
                        respond(true, { ok: true, ran: false, reason: "invalid-spec" });
                    }
                    respond(true, { processInstanceId: getGatewayProcessInstanceId() });
                },
                "cron.runs": async () => readCronTaskRunHistoryPage(params)
            };
        `,
        "jobs-fixture.js": `
            function assertDeliverySupport() {}
            function mergeCronDelivery(existing, patch, implicitMode) {
                const hasCompletionDestinationPatch = "completionDestination" in patch;
                const next = {};
                if (typeof patch.mode === "string") {
                    const previousMode = next.mode;
                    next.mode = patch.mode;
                    if (previousMode !== next.mode && (previousMode === "webhook" || next.mode === "webhook")) next.to = void 0;
                    if (next.mode === "webhook") {
                        next.channel = void 0;
                        next.threadId = void 0;
                        next.accountId = void 0;
                    }
                    if (!hasCompletionDestinationPatch && (next.mode === "none" || next.mode === "webhook")) next.completionDestination = void 0;
                }
                if ("channel" in patch) next.channel = normalizeOptionalString(patch.channel);
                if ("to" in patch) next.to = normalizeOptionalString(patch.to);
                if ("threadId" in patch) next.threadId = normalizeOptionalThreadValue(patch.threadId);
                if ("accountId" in patch) next.accountId = normalizeOptionalString(patch.accountId);
                if (hasCompletionDestinationPatch) {
                    if (patch.completionDestination == null) next.completionDestination = void 0;
                }
                if ("failureDestination" in patch) {
                    if (patch.failureDestination == null) next.failureDestination = void 0;
                }
                return next;
            }
            function mergeCronFailureAlert(existing, patch) {}
            function applyJobPatch() {}
        `,
        "normalize-fixture.js": `
            function coerceDelivery(delivery) {
                const next = { ...delivery };
                if ("channel" in delivery && delivery.channel === null) next.channel = null;
                if ("to" in delivery && delivery.to === null) next.to = null;
                if ("threadId" in delivery && delivery.threadId === null) next.threadId = null;
                if ("accountId" in delivery && delivery.accountId === null) next.accountId = null;
                if ("failureDestination" in next) if (next.failureDestination === null) next.failureDestination = null;
                if ("completionDestination" in next) if (next.completionDestination === null) next.completionDestination = null;
                function coerceFailureDestination(value) {
                    const next = { ...value };
                    if ("mode" in next) if (next.mode === null) next.mode = null;
                    return next;
                }
                return next;
            }
            function normalizeSessionTarget(raw) {}
            function normalizeCronJobPatch(raw) {}
        `,
        "service-fixture.js": `
            async function listPage(state, opts) {
                return {
                    jobs,
                    snapshotRevision,
                    total,
                    offset,
                    limit,
                    hasMore: nextOffset < total,
                    nextOffset: nextOffset < total ? nextOffset : null
                };
            }
            //#region src/cron/service/ops-run.ts
            const stopped = { ok: true, ran: false, reason: "already-running" };
            const notDue = { ok: true, ran: false, reason: "not-due" };
            const invalid = { ok: true, ran: false, reason: "invalid-spec" };
            async function enqueueRun(state, id, mode) {
                return { ok: true, enqueued: true, runId };
            }
        `,
        "list-snapshot-revision-fixture.js": `
            function readCronTaskRunHistoryPage(options) {
                return {
                    entries,
                    total,
                    offset: boundedOffset,
                    limit,
                    hasMore: nextOffset < total,
                    nextOffset: nextOffset < total ? nextOffset : null
                };
            }
            //#region src/cron/list-snapshot-revision.ts
            function resolveCronListSnapshotRevision(jobs) {}
        `,
        "server-cron-fixture.js": `
            const deps = {
                onEvent: (evt) => {
                    params.broadcast("cron", evt, { dropIfSlow: true });
                }
            };
        `,
        "tasks-fixture.js": `
            const DEFAULT_TASKS_LIST_LIMIT = 100;
            const MAX_TASKS_LIST_LIMIT = 500;
            const LEDGER_STATUS_TO_TASK_STATUSES = { failed: ["failed", "lost"] };
            function parseCursor(cursor) {
                if (!/^\\d+$/.test(cursor.trim())) return null;
            }
            const handlers = {
                "tasks.list": () => {
                    const nextOffset = cursor + page.tasks.length;
                    respond(true, {
                        tasks: page.tasks.map((task) => mapTaskSummary(task)),
                        ...page.hasMore ? { nextCursor: String(nextOffset) } : {}
                    });
                },
                "tasks.get": () => {
                    respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, \`task not found: \${taskId}\`));
                    respond(true, { task: mapTaskSummary(task, { includePrompt: true }) });
                },
                "tasks.cancel": () => respond(true, {
                    found: result.found,
                    cancelled: result.cancelled,
                    ...result.task ? { task: mapTaskSummary(result.task) } : {}
                })
            };
        `,
        "task-registry-fixture.js": `
            "Task is already terminal.";
            killSubagentRunAdmin();
            "Subagent completed while cancellation was in progress.";
        `,
        "task-summary-fixture.js": `
            const TASK_PROMPT_MAX_CHARS = 4e3;
            const prompt = sanitizeTaskPromptText(task.task, TASK_PROMPT_MAX_CHARS);
        `,
        "subagent-control-fixture.js": `
            // Admin kill path for a subagent session key, bypassing caller ownership checks.
            cascadeKillChildren();
            const result = { cascadeKilled: cascade.killed };
        `,
        "server-constants-fixture.js": `
            const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
            const MAX_BUFFERED_BYTES = 50 * 1024 * 1024;
            const MAX_PREAUTH_PAYLOAD_BYTES = 64 * 1024;
        `,
        "client-info-fixture.js": `
            const GATEWAY_CLIENT_MODES = { BACKEND: "backend" };
            const GATEWAY_CLIENT_CAPS = {
                SESSION_SCOPED_EVENTS: "session-scoped-events"
            };
        `,
        "error-codes-fixture.js": `
            const GatewayClientIdSchema = Type.Enum(GATEWAY_CLIENT_IDS);
            const GatewayClientModeSchema = Type.Enum(GATEWAY_CLIENT_MODES);
        `,
        "message-handler-fixture.js": `
            async function admitGatewayConnect(context) {
                const isBrowserCopilot = isBrowserCopilotClient(connectParams.client);
                if (isBrowserCopilot &&
                    !hasGatewayClientCap(connectParams.caps, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS)) {
                    close();
                }
                if (isBrowserCopilot && !browserCopilotOrigin) close();
            }
        `,
        "server.impl-fixture.js": `
            const SESSION_SUBSCRIPTION_EVENTS = /* @__PURE__ */ new Set([
                "agent",
                "chat",
                "chat.side_result",
                "session.observer"
            ]);
            function createGatewayBroadcaster(params) {
                const clientSeq = /* @__PURE__ */ new WeakMap();
                const broadcastInternal = (event, payload, opts, targetConnIds) => {
                    const isTargeted = Boolean(targetConnIds);
                    for (const c of params.clients) {
                        if (
                            hasGatewayClientCap(c.connect.caps, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS) &&
                            SESSION_SUBSCRIPTION_EVENTS.has(event) &&
                            !params.sessionMessageSubscribers?.get(sessionKey).has(c.connId)
                        ) continue;
                        const nextSeq = (clientSeq.get(c) ?? 0) + 1;
                        const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
                        if (slow && opts?.dropIfSlow) {
                            if (!isTargeted) clientSeq.set(c, nextSeq);
                            continue;
                        }
                        const eventSeq = isTargeted ? void 0 : nextSeq;
                        if (!isTargeted) clientSeq.set(c, nextSeq);
                        c.socket.send({ event, payload, seq: eventSeq });
                    }
                };
                return { broadcastInternal };
            }
        `,
        "server-methods-fixture.js": `
            //#region src/gateway/server-methods.ts
            const coreGatewayHandlers = {};
            methods: ["agent", "agent.wait"];
            methods: ["agent.identity.get", "agents.list"];
            methods: ["chat.abort", "chat.history", "chat.message.get", "chat.send"];
            methods: ["models.list"];
            methods: ["system.info"];
            methods: [
                "session.typing",
                "sessions.compact",
                "sessions.delete",
                "sessions.list",
                "sessions.messages.subscribe",
                "sessions.messages.unsubscribe",
                "sessions.patch",
                "sessions.reset",
                "sessions.send",
                "sessions.subscribe",
                "sessions.unsubscribe"
            ];
            methods: ["tasks.cancel", "tasks.get", "tasks.list"];
            methods: [
                "wake",
                "cron.list",
                "cron.add",
                "cron.get",
                "cron.remove",
                "cron.run",
                "cron.runs",
                "cron.update"
            ];
        `,
        "server-methods-list-fixture.js": `
            const GATEWAY_EVENTS = [
                "connect.challenge",
                "agent",
                "chat",
                "session.message",
                "session.tool",
                "session.typing",
                "sessions.changed",
                "task",
                "cron",
                "health",
                "heartbeat",
                "presence",
                "shutdown",
                "tick"
            ];
        `,
        "server-ws-runtime-fixture.js": `
            MAX_PREAUTH_PAYLOAD_BYTES;
            send({ type: "event", event: "connect.challenge" });
            setLastFrameMeta({ method: "connect" });
        `,
        "version-fixture.js": `
            //#region packages/gateway-protocol/src/version.ts
            const PROTOCOL_VERSION = 4;
            const MIN_CLIENT_PROTOCOL_VERSION = 4;
            const MIN_NODE_PROTOCOL_VERSION = 3;
            const MIN_PROBE_PROTOCOL_VERSION = 3;
        `,
    };
    await Promise.all(
        Object.entries(artifacts).map(([fileName, contents]) =>
            writeFile(path.join(dist, fileName), contents, "utf8")
        )
    );
    const controlUiArtifacts: Record<string, string> = {
        "chat-message-fixture.js": `
            if (t.stream===\`plan\` && n.phase===\`update\`) {}
            const status = a===\`in_progress\`&&n?\`pending\`:a;
            e.planStatus=null;
            "plan-checklist__body"; "plan-checklist__count";
        `,
        "chat-page-fixture.js": `
            sessions.companion.ask; tasks.list; tasks.get; tasks.cancel;
            const limits = { ob=200,sb=100 };
            runtime!==\`subagent\`;
            SESSION_COMPANION_BUSY;
            exchanges.slice(-24);
        `,
        "chat-session-rail-fixture.js": `
            planStatus; planProgress; steps.slice(-3); openclaw-chat-session-rail;
        `,
    };
    await Promise.all(
        Object.entries(controlUiArtifacts).map(([fileName, contents]) =>
            writeFile(path.join(controlUiAssets, fileName), contents, "utf8")
        )
    );
    await writeFile(
        path.join(sourceRoot, "package.json"),
        `${JSON.stringify({ name: "openclaw", version: sourceVersion })}\n`,
        "utf8"
    );
}

async function withTemporaryDirectory<T>(
    prefix: string,
    operation: (directory: string) => Promise<T>
): Promise<T> {
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    try {
        return await operation(directory);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
}

describe("reviewed OpenClaw protocol fixtures", () => {
    test("loads strict, hash-pinned fixtures without an installed OpenClaw package", async () => {
        const reviewed = await loadReviewedOpenClawFixtures();

        expect(reviewed.manifest.contentPolicy).toEqual({
            containsHostConfiguration: false,
            containsRuntimeState: false,
            containsSecrets: false,
            sourceArtifacts: "hashes-only",
            syntheticPayloadsOnly: true,
        });
        expect(reviewed.audit.source).toEqual({
            builtAt: sourceBuiltAt,
            commit: sourceCommit,
            packageName: "openclaw",
            protocolVersion: 4,
            version: sourceVersion,
        });
        expect(reviewed.audit.gateway).toMatchObject({
            broadcastSequence: {
                dropIfSlowAdvances: true,
                firstSequence: 1,
                scope: "per-client",
                targetedOmitsSequence: true,
            },
            challengeEvent: "connect.challenge",
            helloType: "hello-ok",
            limits: {
                authenticatedFrameBytes: 25 * 1024 * 1024,
                bufferedAmountBytes: 50 * 1024 * 1024,
                preauthenticationFrameBytes: 64 * 1024,
            },
            protocolVersion: 4,
            sessionScopedEvents: {
                backendModeAccepted: true,
                capability: "session-scoped-events",
                connectParameter: {
                    defaultEmptyArray: true,
                    element: "non-empty-string",
                    optional: true,
                },
                filteredEvents: ["agent", "chat", "chat.side_result", "session.observer"],
                requiresSessionMessageSubscription: true,
            },
        });
        expect(reviewed.audit.chat.streamingPolicy).toEqual({
            coalescedAgentStreams: ["assistant", "thinking"],
            deltaThrottleMs: 150,
            flushBeforeBoundaries: ["item.start", "tool.start"],
            flushBufferedDeltaBeforeTerminal: true,
            terminalStates: ["final", "aborted", "error"],
        });
        expect(reviewed.audit.chat.syntheticScenarios).toHaveLength(2);
        expect(
            reviewed.audit.chat.syntheticScenarios[1]?.events.map((event) => event.kind)
        ).toEqual([
            "agent-delta",
            "agent-delta",
            "tool-start",
            "tool-result",
            "chat-delta",
            "chat-terminal",
        ]);
        expect(reviewed.audit.sourceArtifacts).toHaveLength(47);
        expect(reviewed.audit.sessions.adapter.event.lifecycleProjection).toEqual({
            compactIsDestructiveOnlyWhenTrue: true,
            fields: ["compacted", "reason", "sessionId", "sessionKey", "ts", "updatedAt"],
            lossRequiresReconciliation: true,
            reasons: ["compact", "delete", "new", "reset"],
            resetPreservesSessionId: true,
            resetRotatesLifecycleRevision: true,
        });
        expect(reviewed.audit.chat.methodAccess).toEqual([
            {
                controlPlaneWrite: false,
                name: "chat.abort",
                scope: "operator.write",
            },
            {
                controlPlaneWrite: false,
                name: "chat.history",
                scope: "operator.read",
            },
            {
                controlPlaneWrite: false,
                name: "chat.message.get",
                scope: "operator.read",
            },
            {
                controlPlaneWrite: false,
                name: "chat.send",
                scope: "operator.write",
            },
            {
                controlPlaneWrite: false,
                name: "models.list",
                scope: "operator.read",
            },
            {
                controlPlaneWrite: false,
                name: "sessions.companion.ask",
                scope: "operator.read",
            },
            {
                controlPlaneWrite: true,
                name: "sessions.companion.reset",
                scope: "operator.write",
            },
            {
                controlPlaneWrite: false,
                name: "sessions.companion.state",
                scope: "operator.read",
            },
            {
                controlPlaneWrite: false,
                name: "sessions.messages.subscribe",
                scope: "operator.read",
            },
            {
                controlPlaneWrite: false,
                name: "sessions.messages.unsubscribe",
                scope: "operator.read",
            },
        ]);
        expect(reviewed.audit.chat.taskNotificationSend).toEqual({
            acknowledgedStatuses: ["in_flight", "ok", "started"],
            idempotencyKeyIsRunId: true,
            requiredParams: ["idempotencyKey", "message", "sessionKey"],
        });
        expect(reviewed.audit.chat.adapter.methods.history.pagination).toEqual({
            hasMoreRequiresNextOffset: true,
            nextOffsetOnlyWhenHasMore: true,
            offsetDirection: "older-from-recent-tail",
        });
        expect(reviewed.audit.chat.adapter.methods.history.inFlightRun).toEqual({
            boundedAgainstPageMessages: true,
            exactValueStableAcrossPages: false,
            multipleActiveRunsPossible: true,
            recomputedPerRequest: true,
            selection: "newest-visible-run",
            tieBreak: "runId-descending",
        });
        expect(
            reviewed.audit.chat.adapter.methods.settings.generationAcknowledgement
        ).toEqual({
            requestField: "expectedSessionId",
            requiredOnFencedMutation: true,
            responseField: "entry.sessionId",
        });
        expect(
            reviewed.audit.chat.adapter.methods.companionReset.resetCancelsActiveAsk
        ).toBeTrue();
        expect(reviewed.audit.chat.adapter.methods.messageGet.requestParams).toEqual([
            "agentId",
            "maxChars",
            "messageId",
            "sessionKey",
        ]);
        expect(reviewed.audit.tasks.adapter.summary).toMatchObject({
            endedAtOptionalForEveryStatus: true,
            promptOptional: true,
            timestampRepresentations: ["integer", "string"],
        });
        expect(reviewed.audit.sessions.adapter.list.requestParams).toEqual([
            "archived",
            "includeGlobal",
            "includeUnknown",
            "limit",
            "sortBy",
        ]);
        expect(reviewed.audit.sessions.adapter.list.responseMetadata).toEqual([
            "count",
            "creators",
            "defaults",
            "hasMore",
            "limitApplied",
            "nextOffset",
            "offset",
            "path",
            "totalCount",
            "ts",
        ]);
        expect(reviewed.audit.sessions.adapter.list.derivedRowFields).toEqual([
            "activeRunIds",
            "hasActiveRun",
        ]);
        expect(reviewed.audit.sessions.adapter.list.rowFields).toEqual([
            "activeRunIds",
            "channel",
            "contextTokens",
            "createdAt",
            "createdVia",
            "displayName",
            "effectiveFastMode",
            "elevatedLevel",
            "endedAt",
            "fastMode",
            "hasActiveRun",
            "key",
            "kind",
            "label",
            "model",
            "modelProvider",
            "parentSessionKey",
            "reasoningLevel",
            "runtimeMs",
            "sessionId",
            "spawnedBy",
            "startedAt",
            "status",
            "thinkingDefault",
            "thinkingLevel",
            "thinkingLevels",
            "thinkingOptions",
            "totalTokens",
            "totalTokensFresh",
            "updatedAt",
            "verboseLevel",
        ]);
        expect(reviewed.audit.sessions.adapter.deleteLifecycle).toMatchObject({
            conflict: { code: "INVALID_REQUEST", reason: "session-changed" },
            generationFields: [
                "expectedLifecycleRevision",
                "expectedSessionId",
                "expectedSessionUpdatedAt",
            ],
            generationGuardedScope: "operator.admin",
            mainSessionProtection: {
                canonicalKeyComparison: true,
                configuredKeyResolver: "resolveMainSessionKey",
                errorCode: "INVALID_REQUEST",
                selectedNonDefaultGlobalException: true,
            },
        });
        expect(reviewed.audit.sessions.adapter.methodAccess).toEqual([
            {
                lane: "one-shot-admin",
                method: "sessions.compact",
                scope: "operator.admin",
            },
            { lane: "one-shot-admin", method: "sessions.delete", scope: "dynamic" },
            { lane: "persistent", method: "sessions.list", scope: "operator.read" },
            {
                lane: "one-shot-admin",
                method: "sessions.reset",
                scope: "operator.admin",
            },
            {
                lane: "persistent",
                method: "sessions.subscribe",
                scope: "operator.read",
            },
        ]);
        expect(reviewed.audit.sessions.adapter.subscription).toEqual({
            acknowledgementField: "subscribed",
            acknowledgementValue: "Boolean(connId)",
            connectionIdSource: "client.connId.trim",
            effectiveWithSessionScopedCap: [
                "session.message",
                "session.operation",
                "session.tool",
                "sessions.changed",
            ],
            registration: "subscribeSessionEvents",
            registryTargetedEvents: [
                "session.message",
                "session.observer",
                "session.operation",
                "session.tool",
                "sessions.changed",
            ],
            requestParams: [],
            requiredAcknowledgement: true,
        });
        expect(reviewed.audit.cron.adapter.operations.list.requestLiterals).toEqual({
            compact: false,
            includeDeliveryPreviews: false,
        });
        expect(
            reviewed.audit.cron.adapter.operations.list
                .fullJobProjectionRequiresCompactFalse
        ).toBeTrue();
        expect(
            reviewed.audit.cron.adapter.operations.list.compactOmittedJobFields
        ).toEqual([
            "agentId",
            "configRevision",
            "createdAtMs",
            "delivery",
            "description",
            "payload",
            "schedule",
            "sessionTarget",
            "state",
            "updatedAtMs",
            "wakeMode",
        ]);
        expect(reviewed.audit.cron.adapter.delivery).toEqual({
            full: {
                completionDestination: {
                    mode: "webhook",
                    requiredFields: ["mode", "to"],
                },
                failureDestination: {
                    modes: ["announce", "webhook"],
                    optionalFields: ["accountId", "channel", "mode", "to"],
                },
                modes: ["announce", "none", "webhook"],
                sharedFields: [
                    "accountId",
                    "bestEffort",
                    "channel",
                    "failureDestination",
                    "threadId",
                ],
                variantFields: {
                    announce: ["completionDestination", "to"],
                    none: ["to"],
                    webhookRequired: ["to"],
                },
            },
            merge: {
                explicitNullClears: [
                    "accountId",
                    "channel",
                    "completionDestination",
                    "failureDestination",
                    "threadId",
                    "to",
                ],
                failureDestinationNullClearsWholeDestination: true,
                modeSwitchAcrossWebhookBoundaryClearsTo: true,
                noneOrWebhookModeClearsOmittedCompletionDestination: true,
                webhookModeClears: ["accountId", "channel", "threadId"],
            },
            patch: {
                fields: [
                    "accountId",
                    "bestEffort",
                    "channel",
                    "completionDestination",
                    "failureDestination",
                    "mode",
                    "threadId",
                    "to",
                ],
                failureDestinationNullableFields: ["accountId", "channel", "mode", "to"],
                nonNullableFields: ["bestEffort", "mode"],
                nullableFields: [
                    "accountId",
                    "channel",
                    "completionDestination",
                    "failureDestination",
                    "threadId",
                    "to",
                ],
            },
        });
        expect(
            reviewed.audit.cron.adapter.operations.run.acknowledgementVariants
        ).toEqual([
            {
                fields: ["enqueued", "ok", "processInstanceId", "runId"],
                kind: "enqueued",
            },
            {
                fields: ["ok", "ran", "reason"],
                kind: "invalid-spec-fallback",
            },
            {
                fields: ["ok", "processInstanceId", "ran", "reason"],
                kind: "not-run",
            },
        ]);
        expect(reviewed.audit.cron.adapter.methodAccess).toEqual([
            { lane: "persistent", method: "cron.get", scope: "operator.read" },
            { lane: "persistent", method: "cron.list", scope: "operator.read" },
            {
                lane: "one-shot-admin",
                method: "cron.remove",
                scope: "operator.admin",
            },
            { lane: "one-shot-admin", method: "cron.run", scope: "operator.admin" },
            { lane: "persistent", method: "cron.runs", scope: "operator.read" },
            {
                lane: "one-shot-admin",
                method: "cron.update",
                scope: "operator.admin",
            },
            { lane: "persistent", method: "system.info", scope: "operator.read" },
        ]);
        expect(reviewed.audit.cron.adapter.operations.systemInfo).toEqual({
            method: "system.info",
            processInstanceId: { minimumCharacters: 1, optional: true },
            requestParams: [],
            responseFields: [
                "arch",
                "cpuCount",
                "cpuModel",
                "defaultAgentUtilityModel",
                "diskAvailableBytes",
                "diskPath",
                "diskTotalBytes",
                "hostname",
                "lanAddress",
                "loadAverage",
                "machineName",
                "memoryFreeBytes",
                "memoryTotalBytes",
                "nodeVersion",
                "osLabel",
                "pid",
                "platform",
                "port",
                "processInstanceId",
                "release",
                "uptimeMs",
            ],
            responseSchema: "closed-object",
        });
        expect(reviewed.audit.sessions.plan.authority).toMatchObject({
            dedicatedGatewayEvent: false,
            gatewayEvent: "agent",
            producerTool: "update_plan",
            stream: "plan",
        });
        expect(reviewed.audit.sessions.companion.methodPermissions).toEqual([
            {
                controlPlaneWrite: false,
                name: "sessions.companion.ask",
                scope: "operator.read",
            },
            {
                controlPlaneWrite: true,
                name: "sessions.companion.reset",
                scope: "operator.write",
            },
            {
                controlPlaneWrite: false,
                name: "sessions.companion.state",
                scope: "operator.read",
            },
        ]);
        expect(reviewed.audit.tasks.uiProjection.subagentOpenSessionLink).toBeFalse();
    });

    test("rejects unknown fixture fields before policy use", async () => {
        const fixtureRoot = path.dirname(
            fileURLToPath(new URL("manifest.json", defaultReviewedOpenClawFixtureRoot))
        );
        const serialized = await readFile(path.join(fixtureRoot, "chat.json"), "utf8");
        const value = JSON.parse(serialized) as Record<string, unknown>;

        expect(() =>
            parseFixtureDocument(
                chatFixtureSchema,
                JSON.stringify({ ...value, rawHostConfiguration: {} })
            )
        ).toThrow();
    });

    test("rejects a fixture whose bytes no longer match the reviewed manifest", async () => {
        await withTemporaryDirectory("mira-openclaw-fixtures-", async (temporaryRoot) => {
            const fixtureRoot = path.join(temporaryRoot, sourceVersion);
            await mkdir(fixtureRoot);
            const reviewedRoot = path.dirname(
                fileURLToPath(
                    new URL("manifest.json", defaultReviewedOpenClawFixtureRoot)
                )
            );
            for (const fileName of [
                "agents.json",
                "chat.json",
                "cron.json",
                "gateway.json",
                "manifest.json",
                "sessions.json",
                "tasks.json",
            ]) {
                await copyFile(
                    path.join(reviewedRoot, fileName),
                    path.join(fixtureRoot, fileName)
                );
            }
            await writeFile(
                path.join(fixtureRoot, "chat.json"),
                `${await readFile(path.join(fixtureRoot, "chat.json"), "utf8")} `,
                "utf8"
            );

            const mismatchError = await rejectedError(
                loadReviewedOpenClawFixtures(fixtureRoot)
            );
            expect(mismatchError.message).toContain("hash mismatch for chat.json");
        });
    });
});

describe("explicit OpenClaw source audit", () => {
    test("extracts only reviewed facts from a synthetic package distribution", async () => {
        await withTemporaryDirectory("mira-openclaw-source-", async (sourceRoot) => {
            await writeSyntheticOpenClawPackage(sourceRoot);

            const audit = await auditInstalledOpenClaw(sourceRoot);

            expect(audit.source).toMatchObject({
                commit: sourceCommit,
                protocolVersion: 4,
                version: sourceVersion,
            });
            expect(audit.chat.methods).toEqual([
                "chat.abort",
                "chat.history",
                "chat.message.get",
                "chat.send",
            ]);
            expect(audit.agents.methods).toEqual([
                "agent",
                "agent.identity.get",
                "agent.wait",
                "agents.list",
            ]);
            expect(audit.sessions.gatewayEvents).toEqual([
                "session.message",
                "session.tool",
                "session.typing",
                "sessions.changed",
            ]);
            expect(audit.tasks.methods).toEqual([
                "tasks.cancel",
                "tasks.get",
                "tasks.list",
            ]);
            expect(audit.sessions.adapter.event).toEqual({
                backpressurePaths: [
                    {
                        event: "sessions.changed",
                        path: "session-change",
                        slowClient: "drop-event",
                    },
                    {
                        event: "sessions.changed",
                        path: "transcript-fallback",
                        slowClient: "drop-event",
                    },
                    {
                        event: "session.message",
                        path: "transcript-message",
                        slowClient: "close-socket",
                    },
                    {
                        event: "sessions.changed",
                        path: "transcript-snapshot",
                        slowClient: "close-socket",
                    },
                ],
                delivery: "path-dependent-drop-or-close",
                lifecycleProjection: {
                    compactIsDestructiveOnlyWhenTrue: true,
                    fields: [
                        "compacted",
                        "reason",
                        "sessionId",
                        "sessionKey",
                        "ts",
                        "updatedAt",
                    ],
                    lossRequiresReconciliation: true,
                    reasons: ["compact", "delete", "new", "reset"],
                    resetPreservesSessionId: true,
                    resetRotatesLifecycleRevision: true,
                },
                name: "sessions.changed",
                sequence: "omitted",
                targeted: true,
            });
            expect(audit.cron.adapter.operations.runs.resultFields).toEqual([
                "entries",
                "hasMore",
                "limit",
                "nextOffset",
                "offset",
                "total",
            ]);
            expect(audit.sourceArtifacts).toHaveLength(47);
        });
    });

    test("rejects drift in the chat.send write permission", async () => {
        await withTemporaryDirectory("mira-openclaw-chat-scope-", async (sourceRoot) => {
            await writeSyntheticOpenClawPackage(sourceRoot);
            const descriptorPath = path.join(
                sourceRoot,
                "dist",
                "core-descriptors-fixture.js"
            );
            const source = await readFile(descriptorPath, "utf8");
            await writeFile(
                descriptorPath,
                source.replace(
                    '{ name: "chat.send", scope: "operator.write" }',
                    '{ name: "chat.send", scope: "operator.read" }'
                ),
                "utf8"
            );

            const error = await rejectedError(auditInstalledOpenClaw(sourceRoot));
            expect(error.message).toContain(
                "permission descriptor changed for chat.send"
            );
        });
    });

    test("rejects drift in the system.info read permission", async () => {
        await withTemporaryDirectory(
            "mira-openclaw-system-scope-",
            async (sourceRoot) => {
                await writeSyntheticOpenClawPackage(sourceRoot);
                const descriptorPath = path.join(
                    sourceRoot,
                    "dist",
                    "core-descriptors-fixture.js"
                );
                const source = await readFile(descriptorPath, "utf8");
                await writeFile(
                    descriptorPath,
                    source.replace(
                        '{ name: "system.info", scope: "operator.read" }',
                        '{ name: "system.info", scope: "operator.write" }'
                    ),
                    "utf8"
                );

                const error = await rejectedError(auditInstalledOpenClaw(sourceRoot));
                expect(error.message).toContain(
                    "permission descriptor changed for system.info"
                );
            }
        );
    });

    test("rejects a non-empty system.info request or unvalidated process identity", async () => {
        await withTemporaryDirectory(
            "mira-openclaw-system-shape-",
            async (temporaryRoot) => {
                const requestRoot = path.join(temporaryRoot, "request");
                await writeSyntheticOpenClawPackage(requestRoot);
                const requestPath = path.join(requestRoot, "dist", "src-fixture.js");
                const requestSource = await readFile(requestPath, "utf8");
                await writeFile(
                    requestPath,
                    requestSource.replace(
                        "const SystemInfoParamsSchema = closedObject({});",
                        "const SystemInfoParamsSchema = closedObject({ verbose: Type.Boolean() });"
                    ),
                    "utf8"
                );
                const requestError = await rejectedError(
                    auditInstalledOpenClaw(requestRoot)
                );
                expect(requestError.message).toContain("system.info params changed");

                const resultRoot = path.join(temporaryRoot, "result");
                await writeSyntheticOpenClawPackage(resultRoot);
                const resultPath = path.join(resultRoot, "dist", "src-fixture.js");
                const resultSource = await readFile(resultPath, "utf8");
                await writeFile(
                    resultPath,
                    resultSource.replace(
                        "processInstanceId: Type.Optional(Type.String({ minLength: 1 }))",
                        "processInstanceId: Type.Optional(Type.String())"
                    ),
                    "utf8"
                );
                const resultError = await rejectedError(
                    auditInstalledOpenClaw(resultRoot)
                );
                expect(resultError.message).toContain(
                    "system.info process identity changed"
                );
            }
        );
    });

    test("rejects drift in the protocol-v4 connect capability parameter", async () => {
        await withTemporaryDirectory("mira-openclaw-caps-drift-", async (sourceRoot) => {
            await writeSyntheticOpenClawPackage(sourceRoot);
            const protocolPath = path.join(sourceRoot, "dist", "src-fixture.js");
            const source = await readFile(protocolPath, "utf8");
            await writeFile(
                protocolPath,
                source.replace(
                    "caps: Type.Optional(Type.Array(NonEmptyString, { default: [] }))",
                    "capabilities: Type.Optional(Type.Array(NonEmptyString, { default: [] }))"
                ),
                "utf8"
            );

            const error = await rejectedError(auditInstalledOpenClaw(sourceRoot));
            expect(error.message).toContain("Gateway connect caps changed");
        });
    });

    test("rejects drift that disconnects the backend mode enum from its schema", async () => {
        await withTemporaryDirectory("mira-openclaw-mode-drift-", async (sourceRoot) => {
            await writeSyntheticOpenClawPackage(sourceRoot);
            const schemaPath = path.join(sourceRoot, "dist", "error-codes-fixture.js");
            const source = await readFile(schemaPath, "utf8");
            await writeFile(
                schemaPath,
                source.replace(
                    "const GatewayClientModeSchema = Type.Enum(GATEWAY_CLIENT_MODES)",
                    'const GatewayClientModeSchema = Type.String({ title: "GATEWAY_CLIENT_MODES" })'
                ),
                "utf8"
            );

            const error = await rejectedError(auditInstalledOpenClaw(sourceRoot));
            expect(error.message).toContain("Gateway client mode schema changed");
        });
    });

    test("round-trips a source audit through a separately generated candidate", async () => {
        await withTemporaryDirectory(
            "mira-openclaw-candidate-",
            async (temporaryRoot) => {
                const sourceRoot = path.join(temporaryRoot, "source");
                await writeSyntheticOpenClawPackage(sourceRoot);
                const audit = await auditInstalledOpenClaw(sourceRoot);
                const outputDirectory = path.join(temporaryRoot, sourceVersion);

                await writeOpenClawAuditCandidate(audit, outputDirectory);
                const loaded = await loadReviewedOpenClawFixtures(outputDirectory);

                expect(() =>
                    assertOpenClawAuditMatchesReviewed(audit, loaded.audit)
                ).not.toThrow();
                const existingOutputError = await rejectedError(
                    writeOpenClawAuditCandidate(audit, outputDirectory)
                );
                expect(existingOutputError.message).toContain(
                    "output directory already exists"
                );
            }
        );
    });

    test("requires explicit absolute host paths and one operation", () => {
        expect(
            parseSourceAuditCliArguments([
                "--source-root=/opt/openclaw",
                "--output=/tmp/openclaw-audit/2026.7.2-beta.7",
            ])
        ).toEqual({
            mode: "write",
            outputDirectory: "/tmp/openclaw-audit/2026.7.2-beta.7",
            sourceRoot: "/opt/openclaw",
        });
        expect(
            parseSourceAuditCliArguments([
                "--check-reviewed",
                "--source-root=/opt/openclaw",
            ])
        ).toEqual({ mode: "check", sourceRoot: "/opt/openclaw" });
        expect(() => parseSourceAuditCliArguments(["--check-reviewed"])).toThrow();
        expect(() =>
            parseSourceAuditCliArguments([
                "--source-root=relative/openclaw",
                "--check-reviewed",
            ])
        ).toThrow();
        expect(() =>
            parseSourceAuditCliArguments([
                "--source-root=/opt/openclaw",
                "--source-root=/opt/openclaw",
                "--check-reviewed",
            ])
        ).toThrow();
    });
});
