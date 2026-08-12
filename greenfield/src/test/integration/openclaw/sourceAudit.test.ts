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
        "zod-schema-fixture.js": `
            //#region src/config/zod-schema.agents.ts
            const AgentDefaultsSchema = object({
                heartbeat: HeartbeatSchema.unwrap().safeExtend({ agentId: string().trim().min(1).optional() }).optional()
            }).strict();
            const AgentEntryConfigSchema = preprocess((value, ctx) => {
                if (value && typeof value === "object" && !Array.isArray(value)) for (const key of Object.getOwnPropertyNames(value)) {
                    if (!isBlockedObjectKey(key)) continue;
                    ctx.addIssue({
                        message: "agent entries must not contain blocked object keys"
                    });
                }
                return value;
            }, AgentEntrySchema.omit({ id: true }));
            const AgentsSchema = object({
                defaults: lazy(() => AgentDefaultsSchema).optional(),
                entries: record(string().regex(/^[a-z0-9_][a-z0-9_-]{0,63}$/i, "Invalid agent id"), AgentEntryConfigSchema).optional()
            }).strict().superRefine((value, ctx) => {
                const defaultCount = Object.values(value.entries ?? {}).filter((agent) => agent.default === true).length;
                if (defaultCount !== 1) ctx.addIssue({
                    message: "agents.entries must contain exactly one default=true entry"
                });
            }).optional();
            const BindingMatchSchema = object({});
        `,
        "zod-schema.agent-runtime-fixture.js": `
            const HeartbeatSchema = object({
                every: string().optional(),
                target: string().optional()
            }).strict().optional();
            const SandboxDockerSchema = object({});
            const ToolPolicySchema = object({
                allow: array(string()).optional(),
                alsoAllow: array(string()).optional(),
                deny: array(string()).optional()
            }).strict().optional();
            const CommonToolPolicyFields = {
                profile: ToolProfileSchema,
                allow: array(string()).optional(),
                alsoAllow: array(string()).optional(),
                deny: array(string()).optional(),
                byProvider: record(string(), ToolPolicyWithProfileSchema).optional(),
                toolsBySender: ToolPolicyBySenderSchema
            };
            const MessageToolConfigSchema = object({});
            const AgentToolsSchema = object({
                ...CommonToolPolicyFields
            }).strict().superRefine((value, ctx) => {
                addAllowAlsoAllowConflictIssue(value, ctx,
                    "agent tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)");
            }).optional();
            const MemorySearchSchema = object({});
            const AgentEntrySchema = object({
                id: string(),
                heartbeat: HeartbeatSchema,
                tools: AgentToolsSchema
            }).strict();
            const ToolsSchema = object({});
        `,
        "automations-tool-name-fixture.js": `
            const AUTOMATIONS_TOOL_NAME = "automations";
            const LEGACY_AUTOMATIONS_TOOL_NAMES = ["cron"];
            function isAutomationsToolName(name) {
                return name === "automations" || LEGACY_AUTOMATIONS_TOOL_NAMES.includes(name);
            }
        `,
        "tool-catalog-fixture.js": `
            const CORE_TOOL_DEFINITIONS = [
                { id: "read" },
                { id: "write" },
                { id: "edit" },
                { id: "exec" },
                { id: "web_search" },
                { id: "web_fetch" },
                { id: "memory_search" },
                { id: "sessions_list" },
                { id: "sessions_history" },
                { id: "browser" },
                { id: "message" },
                { id: AUTOMATIONS_TOOL_NAME },
                { id: "gateway" },
                { id: "nodes" },
                { id: "image" },
                { id: "image_generate" },
                { id: "music_generate" },
                { id: "video_generate" },
                { id: "tts" }
            ];
            const CORE_TOOL_BY_ID = new Map(CORE_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]));
            function isKnownCoreToolId(toolId) {
                return CORE_TOOL_BY_ID.has(toolId);
            }
        `,
        "tool-policy-fixture.js": `
            const TOOL_NAME_ALIASES = {
                bash: "exec",
                cron: "automations"
            };
            function normalizeToolName(name) {
                const normalized = normalizeLowercaseStringOrEmpty(name);
                return TOOL_NAME_ALIASES[normalized] ?? normalized;
            }
            function normalizeToolList(list) {
                if (!list) return [];
                return list.map(normalizeToolName).filter(Boolean);
            }
        `,
        "zod-schema.channels-config-fixture.js": `
            const ChannelModelByChannelSchema = object({});
            function addLegacyChannelAcpBindingIssues(value, ctx) {}
            const ChannelsSchema = object({
\tdefaults: object({}).strict().optional(),
\tmodelByChannel: ChannelModelByChannelSchema
            }).passthrough().superRefine((value, ctx) => {
                addLegacyChannelAcpBindingIssues(value, ctx);
            }).optional();
            //#endregion
        `,
        "channel-selection-fixture.js": `
            function isConfiguredChannel(cfg, channelId) {
                const channels = cfg.channels;
                if (!channels || typeof channels !== "object" || Array.isArray(channels)) return false;
                const entry = channels[channelId];
                if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
                return entry.enabled !== false;
            }
            function listConfiguredOfficialExternalRepairHints(cfg) { return []; }
            function resolveAvailableKnownChannel(params) { return undefined; }
        `,
        "model-input-normalization-fixture.js": `
            const MODEL_SELECTION_KEYS = [
                "model",
                "imageModel",
                "voiceModel",
                "pdfModel"
            ];
            const MEDIA_MODEL_KEYS = [
                "image",
                "video",
                "music"
            ];
            function normalizeModelSelection(value) {
                if (typeof value === "string") return normalizeAgentModelRefForConfig(value);
                const next = { ...value };
                const assign = (key, normalized) => { next[key] = normalized; };
                if (typeof value.primary === "string") assign("primary", normalizeAgentModelRefForConfig(value.primary));
                if (Array.isArray(value.fallbacks)) next.fallbacks = value.fallbacks.map((fallback) => normalizeAgentModelRefForConfig(fallback));
                return next;
            }
            function normalizeStringModelRef(value) { return value; }
            function normalizeNestedModelField(value, key, normalizer) { return value; }
            function normalizeAgentModelScope(value) {
                const next = { ...value };
                const assign = (key, normalized) => { next[key] = normalized; };
                for (const key of MODEL_SELECTION_KEYS) assign(key, normalizeModelSelection(value[key]));
                assign("utilityModel", normalizeStringModelRef(value.utilityModel));
                for (const key of MEDIA_MODEL_KEYS) assign(key, normalizeModelSelection(value[key]));
                assign("heartbeat", normalizeNestedModelField(value.heartbeat, "model", normalizeStringModelRef));
                assign("subagents", normalizeNestedModelField(value.subagents, "model", normalizeModelSelection));
                assign("compaction", normalizeNestedModelField(value.compaction, "model", normalizeStringModelRef));
                normalizeNestedModelField(value.compaction, "model", normalizeStringModelRef);
                normalizeNestedModelField(compaction.memoryFlush, "model", normalizeStringModelRef);
                assign("models", normalizeAgentModelMapForConfig(value.models));
                return next;
            }
            function normalizeAgentScopes(agents) {
                let next = agents;
                const assign = (key, normalized) => { next = { ...next, [key]: normalized }; };
                if (Object.hasOwn(agents, "defaults")) assign("defaults", normalizeAgentModelScope(agents.defaults));
                if (isRecord(agents.entries)) assign("entries", Object.fromEntries(Object.entries(agents.entries).map(([key, entry]) => [key, normalizeAgentModelScope(entry)])));
                if (Array.isArray(agents.list)) {
                    const originalList = agents.list;
                    assign("list", originalList.map(normalizeAgentModelScope));
                }
                return next;
            }
            function normalizeProviderCatalogs(models, modelIdNormalizationPolicies) {
                if (!isRecord(models.providers)) return models;
                const providers = Object.fromEntries(Object.entries(models.providers).map(([providerId, providerValue]) => {
                    if (!Array.isArray(providerValue.models)) return [providerId, providerValue];
                    return [providerId, { ...providerValue, models: providerValue.models.map((model) => {
                        if (typeof model.id !== "string") return model;
                        const trimmed = model.id.trim();
                        return { ...model, id: normalizeConfiguredProviderCatalogModelId(providerId, trimmed, modelIdNormalizationPolicies) };
                    }) }];
                }));
                return { ...models, providers };
            }
            /** Canonicalize model refs submitted through a config mutation API before persistence. */
            function normalizeSubmittedConfigModelRefs(cfg, modelIdNormalizationPolicies) {
                let next = cfg;
                const agents = normalizeAgentScopes(cfg.agents);
                if (agents !== cfg.agents) next = { ...next, agents };
                const models = normalizeProviderCatalogs(cfg.models, modelIdNormalizationPolicies);
                if (models !== cfg.models) next = { ...next, models };
                return next;
            }
            //#endregion
        `,
        "model-input-fixture.js": `
            const GOOGLE_PROVIDER_IDS = /* @__PURE__ */ new Set([
\t"google",
\t"google-gemini-cli",
\t"google-vertex"
            ]);
            function normalizeAgentModelRefForConfig(model) {
                const { provider, modelId: modelSuffix } = parseModelCatalogRef(model);
                return modelKey(provider, GOOGLE_PROVIDER_IDS.has(provider) || modelSuffix.startsWith("google/") ? normalizeGooglePreviewModelId(modelSuffix) : provider === "together" ? normalizeTogetherModelId(modelSuffix) : modelSuffix);
            }
            function mergeAgentModelEntryForConfig(existing, incoming) { return incoming; }
            function normalizeAgentModelMapForConfig(models) { return models; }
        `,
        "provider-model-id-normalize-fixture.js": `
            function normalizeGooglePreviewModelId(id) {
                if (id.startsWith("google/")) return normalizeGooglePreviewModelId(id.slice(7));
                if (id === "gemini-3-pro" || id === "gemini-3-pro-preview") return "gemini-3.1-pro-preview";
                if (id === "gemini-3-flash") return "gemini-3-flash-preview";
                if (id === "gemini-3.1-pro") return "gemini-3.1-pro-preview";
                if (id === "gemini-3.1-flash-lite-preview") return "gemini-3.1-flash-lite";
                if (id === "gemini-3.1-flash" || id === "gemini-3.1-flash-preview") return "gemini-3-flash-preview";
                if (id === "gemma-4-26b") return "gemma-4-26b-a4b-it";
                return id;
            }
            function normalizeTogetherModelId(id) {
                if (id === "moonshotai/Kimi-K2.5") return "moonshotai/Kimi-K2.6";
                return id;
            }
            function normalizeAntigravityPreviewModelId(id) { return id; }
        `,
        "get-reply-fixture.js": `
            function resolveElevatedPermissions(params) {
                const globalConfig = params.cfg.tools?.elevated;
                const agentConfig = resolveAgentConfig(params.cfg, params.agentId)?.tools?.elevated;
                const globalEnabled = globalConfig?.enabled !== false;
                const agentEnabled = agentConfig?.enabled !== false;
                const enabled = globalEnabled && agentEnabled;
                return { enabled };
            }
            function collapseInlineHorizontalWhitespace(value) { return value; }
            function resolveElevatedAllowList(allowFrom, provider, fallbackAllowFrom) { return []; }
            function isApprovedElevatedSender(params) { return false; }
        `,
        "session-visibility-fixture.js": `
            function createAgentToAgentPolicy(cfg) {
                const routingA2A = cfg.tools?.agentToAgent;
                const enabled = routingA2A?.enabled === true;
                const isAllowed = () => {
                    if (!enabled) return false;
                    return true;
                };
                return { enabled, isAllowed };
            }
            function actionPrefix(action) { return action; }
            function a2aDisabledMessage(action) { return action; }
            function createSessionVisibilityCheckerImpl(params) { return params; }
        `,
        "exec-defaults-fixture.js": `
            function resolveExecConfigState(params) {
                const cfg = params.cfg ?? {};
                const globalExec = cfg.tools?.exec;
                const agentExec = params.agentExec;
                return {
                    cfg,
                    host: params.execOverrides?.host ?? agentExec?.host ?? globalExec?.host ?? "auto",
                    agentExec,
                    globalExec
                };
            }
            /** Resolves whether node exec is usable and any effective node binding. */
            function resolveNodeExecEligibility(params) { return resolveExecDefaults(params); }
            /** Resolves effective exec host, mode, approval policy, and node availability. */
            function resolveExecDefaults(params) {
                const { agentExec, globalExec } = resolveExecConfigState(params);
                const resolved = { effectiveHost: params.effectiveHost };
                const defaultSecurity = resolved.effectiveHost === "sandbox" ? "deny" : "full";
                const approvalDefaults = resolved.effectiveHost === "sandbox" ? void 0 : resolveExecApprovalsFromFile({
                    overrides: { security: defaultSecurity, ask: "off" }
                }).agent;
                const modePolicy = resolveExecModePolicy(applyExecPolicyLayer(applySessionLegacyExecPolicyLayer(applyExecPolicyLayer(applyExecPolicyLayer({
                    security: approvalDefaults?.security ?? defaultSecurity,
                    ask: approvalDefaults?.ask ?? "off"
                }, globalExec), agentExec), params.sessionEntry), params.execOverrides));
                const security = approvalDefaults?.security !== void 0 ? minSecurity(modePolicy.security, approvalDefaults.security) : modePolicy.security;
                const ask = approvalDefaults?.ask !== void 0 ? maxAsk(modePolicy.ask, approvalDefaults.ask) : modePolicy.ask;
                return { security, ask };
            }
            //#endregion
        `,
        "exec-approvals-fixture.js": `
            function resolveExecModeFromPolicy(params) { return "ask"; }
            function resolveExecPolicyForMode(mode) {
                switch (mode) {
                    case "deny": return { security: "deny", ask: "off", autoReview: false };
                    case "allowlist": return { security: "allowlist", ask: "off", autoReview: false };
                    case "ask": return { security: "allowlist", ask: "on-miss", autoReview: false };
                    case "auto": return { security: "allowlist", ask: "on-miss", autoReview: true };
                    case "full": return { security: "full", ask: "off", autoReview: false };
                }
                throw new Error("unsupported");
            }
            function resolveExecModePolicy(params) {
                if (!params.mode) return {
                    mode: resolveExecModeFromPolicy({ security: params.security, ask: params.ask }),
                    security: params.security,
                    ask: params.ask,
                    autoReview: false
                };
                return { mode: params.mode, ...resolveExecPolicyForMode(params.mode) };
            }
            const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 18e5;
        `,
        "merge-patch-fixture.js": `
            function isMergePatchObjectKeyAllowed(key, parentPath) {
                if (!isBlockedObjectKey(key)) return true;
                return parentPath === "browser.profiles" && (key === "constructor" || key === "prototype");
            }
            function mergeObjectArraysById(base, patch, options, arrayPath) {}
            function applyMergePatch(base, patch, options = {}) {
                if (!isPlainObject(patch)) return patch;
                const result = isPlainObject(base) ? { ...base } : {};
                for (const [key, value] of Object.entries(patch)) {
                    const path = formatMergePatchPath(options.path, key);
                    if (value === null) {
                        delete result[key];
                        continue;
                    }
                    if (options.mergeObjectArraysById && Array.isArray(result[key]) && Array.isArray(value)) {
                        if (options.replaceArrayPaths?.has(path)) {
                            result[key] = value;
                            continue;
                        }
                        const mergedArray = mergeObjectArraysById(result[key], value, options, path);
                        if (mergedArray) result[key] = mergedArray;
                    }
                }
                return result;
            }
            //#endregion
        `,
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
            projectChatDisplayMessages(recencyFilteredMessages, { maxChars: effectiveMaxChars });
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
        "chat-display-projection-fixture.js": `
            function hasTranscriptMediaFacts(message) {
                return (readPersistedMediaFacts(message) ?? []).some(isMeaningfulMediaFact);
            }
            function toProjectedMessages(messages) {
                return messages.filter((message) => Boolean(message));
            }
            function shouldHideProjectedHistoryMessage(message) {
                if (roleContent.role === "user" && isEmptyTextOnlyContent(message.content ?? message.text) && !hasTranscriptMediaFacts(message)) return true;
                return false;
            }
            function projectChatDisplayMessagesWithState(messages, options) {
                return { messages: toProjectedMessages(messages) };
            }
        `,
        "media-facts-fixture.js": `
            function readPersistedMediaFacts(message) {
                const media = readPersistedMediaFactInputs(message);
                return media ? normalizeMediaFacts(media) : void 0;
            }
            function readPersistedMediaFactInputs(message) {
                const metadata = message["__openclaw"];
                const media = metadata && typeof metadata === "object" ? metadata.media : void 0;
                return Array.isArray(media) ? media : void 0;
            }
            const LEGACY_MEDIA_CONTEXT_KEYS = ["MediaPath", "MediaPaths", "MediaUrl", "MediaUrls", "MediaType", "MediaTypes"];
            const PERSISTED_LEGACY_MEDIA_KEYS = ["MediaPath", "MediaPaths", "MediaUrl", "MediaUrls", "MediaType", "MediaTypes"];
            function hasAmbiguousSparseLegacyMediaAlignment(source) { return false; }
            function hasUnderCardinalLegacyTypes(source) { return false; }
            function canonicalizePersistedUserMessageMedia(message) {
                const record = message;
                const hadTopLevelMedia = Object.hasOwn(record, "media");
                const canonical = readPersistedMediaFactInputs(message);
                const topLevelMedia = Array.isArray(record.media) ? record.media : void 0;
                const source = { ...record, media: canonical ?? topLevelMedia };
                if (hasAmbiguousSparseLegacyMediaAlignment(source)) throw new Error("legacy media arrays have ambiguous sparse positional alignment");
                const resolvedSource = hasUnderCardinalLegacyTypes(source) ? { ...source, MediaType: void 0, MediaTypes: [] } : source;
                const media = resolveMediaFacts(resolvedSource);
                const next = { ...record };
                delete next.media;
                for (const key of PERSISTED_LEGACY_MEDIA_KEYS) delete next[key];
                const openclaw = { ...(record["__openclaw"] ?? {}) };
                openclaw.media = media;
                next["__openclaw"] = openclaw;
                return { changed: true, message: next };
            }
            function stripLegacyMediaContextFields(ctx) {}
            function normalizeMediaFact(media, index, defaults = {}) {
                const contentType = normalizeOptionalString(media.contentType);
                const durationMs = normalizePositiveInteger(media.durationMs);
                const width = normalizePositiveInteger(media.width);
                const height = normalizePositiveInteger(media.height);
                const workspaceDir = normalizeOptionalString(media.workspaceDir);
                return {
                    path: normalizeOptionalString(media.path),
                    url: normalizeOptionalString(media.url),
                    contentType,
                    kind: media.kind ?? defaults.kind ?? kindFromMime(contentType),
                    fileName: normalizeOptionalString(media.fileName),
                    sizeBytes: normalizeNonNegativeNumber(media.sizeBytes),
                    durationMs,
                    width,
                    height,
                    transcribed: media.transcribed === true,
                    messageId: normalizeOptionalString(media.messageId),
                    workspaceDir,
                    staged: media.staged === true,
                    hydrationSuppressed: media.hydrationSuppressed === true
                };
            }
            /** True when every path-bearing canonical fact has explicit staging proof. */
            function normalizeMediaFacts(media) { return Array.isArray(media) ? media.map(normalizeMediaFact) : []; }
            function resolveMediaFactsWithPrecedence(source, legacyProjectionWins) {
                const canonical = normalizeMediaFacts(source.media);
                const paths = Array.isArray(source.MediaPaths) ? source.MediaPaths : [];
                const urls = Array.isArray(source.MediaUrls) ? source.MediaUrls : [];
                const types = Array.isArray(source.MediaTypes) ? source.MediaTypes : [];
                const count = Math.max(canonical.length, paths.length, urls.length, types.length, source.MediaPath || source.MediaUrl || source.MediaType ? 1 : 0);
                return Array.from({ length: count }, (_, index) => {
                    const fact = canonical[index];
                    const legacyPath = paths[index] ?? (index === 0 ? source.MediaPath : void 0);
                    const legacyUrl = urls[index] ?? (paths.length > 0 || index === 0 ? source.MediaUrl : void 0);
                    const legacyContentType = normalizeOptionalString(types[index]) ?? (index === 0 ? source.MediaType : void 0);
                    return normalizeMediaFact({
                        path: legacyProjectionWins ? legacyPath : fact?.path ?? legacyPath,
                        url: legacyProjectionWins ? legacyUrl : fact?.url ?? legacyUrl,
                        contentType: legacyProjectionWins ? legacyContentType : fact?.contentType ?? legacyContentType
                    }, index);
                });
            }
            /** Normalizes canonical facts or, for compatibility callers, legacy parallel fields. */
            function resolveMediaFacts(source) { return resolveMediaFactsWithPrecedence(source, false); }
        `,
        "payloads-media-fixture.js": `
            const MEDIA_TOKEN_RE = /\\bMEDIA:\\s*([^\\n]+)/gi;
            const FILE_URL_PREFIX_RE = /^file:\\/\\//i;
            function normalizeMediaSource(src) { return src.replace(FILE_URL_PREFIX_RE, ""); }
            function hasTraversalOrUnsupportedHomeDirPrefix(candidate) { return candidate.includes(".."); }
            function isValidMedia(candidate, opts) {
                if (candidate.length > 4096) return false;
                if (hasTraversalOrUnsupportedHomeDirPrefix(candidate)) return false;
                return true;
            }
            function splitMediaFromOutput(raw, options = {}) {
                const trimmedRaw = raw.trimEnd();
                const lines = trimmedRaw.split("\\n");
                let foundMediaToken = false;
                let cleanedText = "";
                for (const line of lines) {
                    if (isInsideFence(fenceSpans, lineOffset)) continue;
                    const trimmedStart = line.trimStart();
                    if (!trimmedStart.toUpperCase().startsWith("MEDIA:")) continue;
                    const candidate = normalizeMediaSource(cleanCandidate(part));
                    if (isValidMedia(candidate)) foundMediaToken = true;
                    else if (looksLikeLocalPath) foundMediaToken = true;
                }
                const parsedText = foundMediaToken || hasAudioAsVoice ? cleanedText : trimmedRaw;
                return { text: parsedText };
            }
            //#endregion
        `,
        "store-media-fixture.js": `
            const resolveMediaDir = () => path.join(resolveConfigDir(), "media");
            function resolveMediaScopedDir(subdir, caller) {
                const mediaDir = resolveMediaDir();
                const dir = path.join(mediaDir, subdir);
                if (!isPathInside(mediaDir, dir)) throw new Error("escaped media root");
                return dir;
            }
            function openMediaStore(maxBytes = MAX_BYTES, rootDir = resolveMediaDir()) { return fileStore({ rootDir, maxBytes }); }
        `,
        "session-accessor.sqlite-transcript-store-fixture.js": `
            function appendTranscriptEventInTransaction(database, scope, event, options = {}) {
                const persistedEvent = canonicalizeTranscriptEventMedia(event);
                database.insert({ event_json: JSON.stringify(persistedEvent) });
            }
            function canonicalizeTranscriptEventMedia(event) {
                const record = event;
                const message = record.message;
                if (record.type !== "message" || !message) return event;
                const canonical = canonicalizePersistedUserMessageMedia(message);
                return canonical.changed ? { ...record, message: canonical.message } : event;
            }
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
        "base-hash-fixture.js": `
            function resolveBaseHashParam(params) {
                const raw = params?.baseHash;
                if (typeof raw !== "string") return null;
                const trimmed = raw.trim();
                return trimmed ? trimmed : null;
            }
        `,
        "config-get-response-fixture.js": `
            let configGetResponseCache;
            function createConfigGetResponse(snapshot, uiHints) {
                return {
                    ...redactConfigSnapshot(snapshot, uiHints),
                    configRevisionHash: hashRuntimeConfigValue(snapshot.sourceConfig),
                    appliedConfigHash: getRuntimeConfigAppliedHash()
                };
            }
            async function readConfigGetResponse(params) {
                const getHotReloadStatus = params.getHotReloadStatus;
                if (!getHotReloadStatus || getHotReloadStatus() !== "active") return createConfigGetResponse(await readConfigFileSnapshot(), params.loadUiHints());
                const appliedConfigHash = getRuntimeConfigAppliedHash();
                const pluginRegistryVersion = getActivePluginRegistryVersion();
                if (configGetResponseCache?.getHotReloadStatus === getHotReloadStatus && configGetResponseCache.appliedConfigHash === appliedConfigHash && configGetResponseCache.pluginRegistryVersion === pluginRegistryVersion) return await configGetResponseCache.promise;
                const promise = (async () => createConfigGetResponse(await readConfigFileSnapshot(), params.loadUiHints()))();
                configGetResponseCache = { getHotReloadStatus, appliedConfigHash, pluginRegistryVersion, promise };
                try { return await promise; } catch (error) {
                    if (configGetResponseCache?.promise === promise) configGetResponseCache = void 0;
                    throw error;
                }
            }
            function invalidateConfigGetResponseCache() {
                configGetResponseCache = void 0;
            }
        `,
        "io-fixture.js": `
            function createConfigFileSnapshot(params) {
                const sourceConfig = params.sourceConfig;
                const runtimeConfig = params.runtimeConfig;
                return {
                    includedPaths: [...params.includedPaths ?? []],
                    sourceConfig,
                    resolved: sourceConfig,
                    runtimeConfig,
                    config: runtimeConfig,
                    hash: params.hash
                };
            }
            async function finalizeReadConfigSnapshotInternalResult(deps, result, options) { return result; }
            function listResolvedIncludePaths(includeFilePathsForWatch) {
                return [...includeFilePathsForWatch].toSorted();
            }
            async function readConfigFileSnapshotInternal(context, options = {}) {
                const rawHash = await deps.measure("config.snapshot.read.hash", () => hashConfigRaw$1(raw));
                const effectiveParsed = parsedRes.parsed;
                resolveConfigIncludesForRead(effectiveParsed, configPath, deps, includeFileHashesForWrite, includeFileTargetsForWrite, includeFilePathsForWatch);
                const readResolution = deps.measure("config.snapshot.read.env", () => resolveConfigForRead(resolved, deps.env, deps.lowerPrecedenceEnv));
                const rosterMigration = migratePersistedImplicitMainRoster(readResolution.resolvedConfigRaw);
                const effectiveConfigRaw = rosterMigration.config;
                const snapshotRaw = raw;
                const snapshotParsed = effectiveParsed;
                const snapshotHash = rawHash;
                const snapshotConfig = materializeRuntimeConfig(validated.config, "snapshot");
                return createConfigFileSnapshot({
                    sourceConfig: coerceConfig(effectiveConfigRaw),
                    runtimeConfig: snapshotConfig,
                    includedPaths: listResolvedIncludePaths(includeFilePathsForWatch)
                });
            }
            async function readConfigFileSnapshotFromContext(context, options = {}) { return readConfigFileSnapshotInternal(context, options); }
            function resolveConfigForRead(resolvedIncludes, env, lowerPrecedenceEnv = {}) {
                return {
                    resolvedConfigRaw: resolveConfigEnvVars(resolvedIncludes, env),
                    envSnapshotForRestore: { ...env }
                };
            }
            function snapshotEnv(env) { return { ...env }; }
            function restoreEnvVarRefs(incoming, parsed, env = process.env) {
                if (tryResolveString(parsed, env) === incoming) return parsed;
                return incoming;
            }
            function parentPath(value) { return value; }
            function hasJSON5Comments(raw) { return true; }
            function warnIfJSON5CommentsWillBeStripped(params) {
                logger.warn(\`Config write will strip JSON5 comments from \${params.filePath}.\`);
            }
            async function writeConfigFileFromContext(context, cfg, options, readSnapshot) {
                const stampedOutputConfig = cfg;
                const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\\n");
                const nextHash = hashConfigRaw$1(json);
                return { persistedHash: nextHash, persistedConfig: stampedOutputConfig };
            }
            async function writeConfigFile(cfg, options = {}) {
                const nextCfg = cfg;
                const writeResult = await io.writeConfigFile(nextCfg, {
                    afterWrite: options.afterWrite
                });
                return await finalizeCommittedConfigWrite({
                    io,
                    options,
                    nextCfg,
                    writeResult,
                    baseSnapshot
                });
            }
            async function finalizeCommittedConfigWrite(params) {
                const { io, options, writeResult, baseSnapshot } = params;
                try {
                    const freshSnapshot = await io.readConfigFileSnapshot();
                    await finalizeRuntimeSnapshotWrite({
                        nextSourceConfig: freshSnapshot.sourceConfig
                    });
                } catch (error) {
                    try {
                        if (await rollbackConfigFileWriteIfUnchanged({
                            configPath: io.configPath,
                            previousSnapshot: baseSnapshot,
                            committedHash: writeResult.persistedHash
                        })) writeResult[configWritePostCommitRollback]?.();
                    } catch (rollbackError) {
                        throw new ConfigRuntimeRefreshError(\`\${formatErrorMessage(error)} Rollback failed: \${formatErrorMessage(rollbackError)}\`, { cause: error });
                    }
                    throw error;
                }
                return writeResult;
            }
            //#endregion
            //#region src/config/io.factory.ts
        `,
        "mutate-fixture.js": `
            async function tryWriteSingleTopLevelIncludeMutation(params) {
                if (changedKeys.length !== 1 || changedKeys[0] === "<root>") return null;
                const includePath = getSingleTopLevelIncludeTarget({ changedKeys });
                await writeRootBoundJsonFile({ includePath });
                refreshed = await readConfigSnapshotForMutation({ context: params.context });
                const persistedHash = resolveConfigSnapshotHash(refreshedSnapshot);
                return {
                    persistedHash,
                    persistedConfig: refreshedSnapshot.sourceConfig
                };
            }
            function resolveConfigWriteResult(result, fallbackConfig) { return result; }
            async function replaceConfigFileUnlocked(params) { return params; }
            async function transformConfigFileAttempt(params) {
                const snapshot = await readConfigSnapshotForMutation(params);
                const baseConfig = params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig;
                return params.transform(baseConfig);
            }
            async function transformConfigFileWithRetry(params) {
                const maxAttempts = params.maxAttempts ?? DEFAULT_CONFIG_MUTATION_RETRY_ATTEMPTS;
                for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                    try { return await transformConfigFileAttempt(params); } catch (err) {
                        if (err instanceof ConfigMutationConflictError && err.retryable && attempt < maxAttempts - 1) continue;
                        throw err;
                    }
                }
            }
            async function mutateConfigFile(params) { return transformConfigFileWithRetry(params); }
            async function mutateConfigFileWithRetry(params) { return transformConfigFileWithRetry(params); }
        `,
        "redact-snapshot-fixture.js": `
            const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";
            function redactConfigSnapshot(snapshot, uiHints) {
                if (!snapshot.valid) {
                    const redactedConfig = {};
                    const redactedResolved = {};
                    return {
                        ...snapshot,
                        sourceConfig: redactedResolved,
                        runtimeConfig: redactedConfig,
                        config: redactedConfig,
                        raw: null,
                        parsed: null,
                        resolved: redactedResolved
                    };
                }
                const redactedConfig = redactObject(snapshot.config, uiHints);
                const redactedParsed = snapshot.parsed ? redactObject(snapshot.parsed, uiHints) : snapshot.parsed;
                let redactedRaw = snapshot.raw;
                const redactedResolved = redactConfigObject(snapshot.resolved, uiHints);
                const { pluginMetadataSnapshot: _pluginMetadataSnapshot, ...publicSnapshot } = snapshot;
                return {
                    ...publicSnapshot,
                    sourceConfig: redactedResolved,
                    runtimeConfig: redactedConfig,
                    config: redactedConfig,
                    raw: redactedRaw,
                    parsed: redactedParsed,
                    resolved: redactedResolved
                };
            }
            /**
            * Deep-walk \`incoming\` and restore sensitive values.
            */
            function restoreRedactedValues(incoming, original, hints) {
                const restored = incoming;
                assertNoRedactedSentinel(restored, "");
                return { ok: true, result: restored };
            }
            function restoreOriginalValueOrThrow(params) {
                if (Object.hasOwn(params.original, params.key)) return params.original[params.key];
                throw new RedactionError(params.path);
            }
        `,
        "config-fixture.js": `
            async function commitGatewayConfigWrite(params) {
                const result = await replaceConfigFile({
                    nextConfig: params.nextConfig,
                    baseHash: resolveConfigSnapshotHash(params.snapshot) ?? void 0
                });
                invalidateConfigGetResponseCache();
                return {
                    path: resolveGatewayConfigPath(params.snapshot),
                    config: result.nextConfig,
                    hash: result.persistedHash,
                    queueFollowUp: () => {}
                };
            }
            function buildConfigRestartSentinelPayload(params) {
                return {
                    kind: params.kind,
                    status: "ok",
                    stats: {
                        mode: params.mode,
                        root: params.configPath,
                        requiresRestart: params.requiresRestart
                    }
                };
            }
            async function tryWriteRestartSentinelPayload(payload) { return true; }
            async function resolveGatewayConfigRestartWriteResult(params) {
                const sentinelPersisted = await tryWriteRestartSentinelPayload(payload);
                const restart = restartRequirement.scheduleDirectRestart ? scheduleGatewaySigusr1Restart({
                    changedPaths: params.changedPaths
                }) : void 0;
                return { payload, sentinelPersisted, restart };
            }
            async function respondWithConfigRestartWrite(params) {
                const { payload, sentinelPersisted, restart } = await resolveGatewayConfigRestartWriteResult(params);
                params.respond(true, {
                    ok: true,
                    path: params.writeResult.path,
                    ...params.writeResult.hash ? { hash: params.writeResult.hash } : {},
                    config: redactConfigObject(params.writeResult.config, params.uiHints),
                    restart,
                    sentinel: {
                        persisted: sentinelPersisted,
                        payload
                    }
                }, void 0);
            }
            function shouldDisconnectSharedAuthClientsForConfigWrite(params) { return false; }
            function formatConfigPatchPath(parentPath, key) {
                return parentPath ? \`\${parentPath}.\${key}\` : key;
            }
            function normalizeConfigPatchReplacePath(value) {
                const trimmed = value.trim();
                if (trimmed.endsWith("[]")) return trimmed.slice(0, -2).replace(/\\[\\d+\\](?=\\.)/g, "[]");
                return trimmed.replace(/\\[\\d+\\](?=\\.)/g, "[]");
            }
            function normalizeConfigPatchReplacePaths(values) {
                if (!values) return new Set();
                return new Set(values.filter((value) => typeof value === "string").map(normalizeConfigPatchReplacePath).filter((value) => value.length > 0));
            }
            function collectDestructiveArrayPatchPaths(params) {
                return [];
            }
            function rejectDestructiveArrayPatchWithoutIntent(params) {
                const unconfirmedPaths = collectDestructiveArrayPatchPaths({}).filter((path) => !params.replacePaths.has(path));
                return unconfirmedPaths.length > 0;
            }
            const HASHLESS_PATCH_LWW_PATH_PREFIXES = ["ui.prefs"];
            function requireConfigBaseHash(params, snapshot, respond) {
                if (baseHash !== snapshotHash) {
                    respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "config changed since last load; re-run config.get and retry"));
                    return false;
                }
                return true;
            }
            const configHandlers = {
                "config.get": async ({ params, respond, context }) => {
                    if (!assertValidParams(params, validateConfigGetParams, "config.get", respond)) return;
                    respond(true, await readConfigGetResponse({
                        loadUiHints: () => loadSchemaWithPlugins().uiHints
                    }), void 0);
                },
                "config.schema": ({ params, respond }) => {},
                "config.patch": async ({ params, respond, client, context }) => {
                    if (!assertValidParams(params, validateConfigPatchParams, "config.patch", respond)) return;
                    const hashlessPatch = resolveBaseHashParam(params) === null;
                    const parsedRes = parseConfigJson5(params.raw);
                    const normalizedPatch = normalizeSubmittedConfigModelRefs(parsedRes.parsed, modelIdNormalizationPolicies);
                    if (hashlessPatch && !hasHashlessPatchLwwStructure(normalizedPatch)) return;
                    const replacePaths = readConfigPatchReplacePaths(params);
                    const merged = applyMergePatch(snapshot.config, normalizedPatch, {
                        mergeObjectArraysById: true,
                        replaceArrayPaths: replacePaths
                    });
                    const restoredMerge = restoreRedactedValues(merged, snapshot.config, schemaPatch.uiHints);
                    const restoredChangedPaths = diffConfigLeafPaths(snapshot.config, restoredMerge.result);
                    if (hashlessPatch && !restoredChangedPaths.every(isHashlessPatchLwwPath)) return;
                    const validationCandidate = normalizeSubmittedConfigModelRefs(stripBundledProviderRuntimeDefaults({
                        candidate: restoredMerge.result,
                        sourceConfig: snapshot.sourceConfig
                    }), modelIdNormalizationPolicies);
                    const sourceValidated = validateConfigObjectRawWithPlugins(validationCandidate);
                    const writeConfig = validationCandidate;
                    const validated = validateConfigObjectWithPlugins(validationCandidate);
                    if (restoredChangedPaths.length === 0) {
                        respondConfigPatchNoop({ snapshot });
                        return;
                    }
                    await respondWithConfigRestartWrite({
                        changedPaths: restoredChangedPaths,
                        sentinel: {
                            persisted: sentinelPersisted,
                            payload
                        }
                    });
                },
                "config.apply": async ({ params, respond }) => {}
            };
        `,
        "skills-fixture.js": `
            function patchSkillConfigEntry(cfg, skillKey, patch) {
                const entries = { ...cfg.skills?.entries };
                const current = entries[skillKey] ? { ...entries[skillKey] } : {};
                if (typeof patch.enabled === "boolean") current.enabled = patch.enabled;
                if (typeof patch.apiKey === "string") {
                    const trimmed = normalizeSecretInput(patch.apiKey);
                    if (trimmed === "__OPENCLAW_REDACTED__") {}
                    else if (trimmed) current.apiKey = trimmed;
                    else delete current.apiKey;
                }
                if (patch.env && typeof patch.env === "object") {
                    const nextEnv = { ...current.env };
                    for (const [key, value] of Object.entries(patch.env)) {
                        const trimmedKey = key.trim();
                        if (!trimmedKey) continue;
                        const trimmedVal = value.trim();
                        if (trimmedVal === "__OPENCLAW_REDACTED__") continue;
                        if (!trimmedVal) delete nextEnv[trimmedKey];
                        else nextEnv[trimmedKey] = trimmedVal;
                    }
                    current.env = nextEnv;
                }
                entries[skillKey] = current;
                return { ...cfg, skills: { ...cfg.skills, entries } };
            }
            async function updateSkillConfigEntry(params) {
                return (await mutateConfigFileWithRetry({
                    afterWrite: { mode: "auto" },
                    mutate: (draft) => {
                        const next = patchSkillConfigEntry(draft, params.skillKey, params);
                        Object.assign(draft, next);
                        return next.skills?.entries?.[params.skillKey] ?? {};
                    }
                })).result ?? {};
            }
            //#endregion
            function resolveSkillsAgentWorkspace(params, context) {
                const cfg = context.getRuntimeConfig();
                const agentIdRaw = params.agentId;
                const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
                if (agentIdRaw && !listAgentIds(cfg).includes(agentId)) return { ok: false };
                return { ok: true, cfg, agentId, workspaceDir: resolveAgentWorkspaceDir(cfg, agentId) };
            }
            const SKILL_PROPOSAL_RESPONSE_HANDLED = Symbol();
            function buildRemoteAwareWorkspaceSkillStatus(resolved) {
                const nodeSkills = resolveNodeExecEligibility({ agentId: resolved.agentId });
                return buildWorkspaceSkillStatus(resolved.workspaceDir, {
                    remote: getRemoteSkillEligibility({ advertiseExecNode: nodeSkills.canExec })
                });
            }
            const skillsHandlers = {
                "skills.status": ({ params, respond, context }) => {
                    if (!assertValidParams(params, validateSkillsStatusParams, "skills.status", respond)) return;
                    const resolved = resolveSkillsAgentWorkspace(params, context);
                    respond(true, buildRemoteAwareWorkspaceSkillStatus(resolved), void 0);
                },
                "skills.securityVerdicts": async () => {},
                "skills.update": async ({ params, respond, context }) => {
                    if (!assertValidParams(params, validateSkillsUpdateParams, "skills.update", respond)) return;
                    if (params && typeof params === "object" && "source" in params && params.source === "clawhub") return;
                    const p = params;
                    const updated = await updateSkillConfigEntry(p);
                    respond(true, {
                        ok: true,
                        skillKey: p.skillKey,
                        config: redactConfigObject(updated)
                    }, void 0);
                }
            };
            //#endregion
        `,
        "status-fixture.js": `
            function buildSkillStatus(indexed, context) {
                const entry = indexed.entry;
                const skillKey = indexed.skillKey;
                const skillConfig = resolveSkillConfig(context.config, skillKey);
                const disabled = skillConfig?.enabled === false;
                const skillSource = indexed.source;
                const bundled = indexed.bundled;
                const blockedByAllowlist = false;
                const requirementsSatisfied = true;
                const eligible = !disabled && !blockedByAllowlist && requirementsSatisfied;
                return {
                    name: entry.skill.name,
                    description: entry.skill.description,
                    source: skillSource,
                    bundled,
                    filePath: entry.skill.filePath,
                    baseDir: entry.skill.baseDir,
                    skillKey,
                    disabled,
                    eligible,
                };
            }
            function buildWorkspaceSkillStatus(workspaceDir, opts) {
                const managedSkillsDir = opts.managedSkillsDir;
                const agentSkillFilter = opts.agentSkillFilter;
                const skillIndexEntries = opts.entries;
                return {
                    workspaceDir,
                    managedSkillsDir,
                    agentId: opts?.agentId,
                    agentSkillFilter,
                    skills: skillIndexEntries.map((entry) => buildSkillStatus(entry, {
                        config: opts.config
                    }))
                };
            }
            //#endregion
        `,
        "workspace-fixture.js": `
            function mergeRemoteNodeSkillEntries(localEntries, options) {
                const remoteEntries = [{
                    skill: {
                        source: "openclaw-node",
                        sourceInfo: { source: "openclaw-node" }
                    }
                }];
                return [...localEntries, ...remoteEntries];
            }
            function resetRemoteNodeSkillsForTests() {}
            function loadSkillEntries(workspaceDir, opts) {
                const bundledSkills = loadSkills({ source: "openclaw-bundled" });
                const extraSkills = loadSkills({ source: "openclaw-extra" });
                const managedSkills = loadSkills({ source: "openclaw-managed" });
                const personalAgentsSkills = loadSkills({ source: "agents-skills-personal" });
                const projectAgentsSkills = loadSkills({ source: "agents-skills-project" });
                const workspaceSkills = loadSkills({ source: "openclaw-workspace" });
                return [
                    ...bundledSkills,
                    ...extraSkills,
                    ...managedSkills,
                    ...personalAgentsSkills,
                    ...projectAgentsSkills,
                    ...workspaceSkills
                ];
            }
            function filterArchivedSkillEntries(entries) { return entries; }
        `,
        "source-fixture.js": `
            function resolveSkillSource(skill) {
                const compatSkill = skill;
                const canonical = normalizeOptionalString(compatSkill.source) ?? "";
                if (canonical) return canonical;
                return (normalizeOptionalString(compatSkill.sourceInfo?.source) ?? "") || "unknown";
            }
            function resolveSkillTelemetrySourceValue(value) { return value; }
            function resolveSkillTelemetrySource(skill) { return resolveSkillSource(skill); }
        `,
        "frontmatter-fixture.js": `
            function resolveOpenClawMetadata(frontmatter) { return frontmatter.metadata; }
            function resolveSkillInvocationPolicy(frontmatter) { return frontmatter.policy; }
            function resolveSkillKey(skill, entry) {
                return entry?.metadata?.skillKey ?? skill.name;
            }
            //#endregion
        `,
        "store-fixture.js": `
            function buildSkillIndexEntries(entries, opts) {
                return entries.map((entry) => createSkillIndexEntry(entry, opts));
            }
            function createSkillIndexEntry(entry, opts, agentSkillSet) {
                const name = entry.skill.name;
                const skillKey = resolveSkillKey(entry.skill, entry);
                const source = resolveSkillSource(entry.skill);
                return {
                    skillKey,
                    source,
                    bundled: source === "openclaw-bundled" || source === "unknown" && opts?.bundledNames?.has(name) === true
                };
            }
            //#endregion
        `,
        "restart-fixture.js": `
            function scheduleGatewaySigusr1Restart(opts) {
                const cooldownMsApplied = 0;
                return {
                    ok: true,
                    pid: process.pid,
                    signal: "SIGUSR1",
                    delayMs: 0,
                    reason: opts.reason,
                    mode: "signal",
                    coalesced: false,
                    cooldownMsApplied,
                    emitHooksQueued: false
                };
            }
            //#endregion
        `,
        "cleanup-service-fixture.js": `
            function serializeSessionCleanupResult(params) {
                if (params.summaries.length === 1) return params.summaries[0] ?? {};
                return {
                    allAgents: true,
                    mode: params.mode,
                    dryRun: params.dryRun,
                    stores: params.summaries
                };
            }
            function pruneMissingTranscriptEntries(params) { return 0; }
            async function previewStoreCleanup(params) { return params; }
            /** Runs session cleanup preview/apply for the selected store targets. */
            async function runSessionsCleanup(params) {
                const { cfg, opts } = params;
                const maintenance = resolveMaintenanceConfig();
                const mode = opts.enforce ? "enforce" : maintenance.mode;
                previewStoreCleanup({
                    fixMissing: Boolean(opts.fixMissing),
                    fixDmScope: Boolean(opts.fixDmScope)
                });
                const lifecycleResult = await applySqliteSessionEntryLifecycleMutation({
                    activeSessionKey: opts.activeKey,
                    maintenanceOverride: {
                        ...maintenance,
                        mode
                    }
                });
                const appliedUnreferencedArtifacts = mode === "warn" ? null : await pruneUnreferencedSessionArtifacts({});
                const appliedDiskBudget = await enforceSqliteSessionHistoryDiskBudget({});
                const missingApplied = 0;
                const dmScopeRetiredApplied = 0;
                const unreferencedArtifacts = appliedUnreferencedArtifacts;
                const appliedReport = {
                    mode,
                    beforeCount: 2,
                    afterCount: 1,
                    modelRunPruned: 0,
                    pruned: 1,
                    capped: 0
                };
                const summary = {
                    agentId: target.agentId,
                    storePath: target.storePath,
                    mode: appliedReport.mode,
                    dryRun: false,
                    beforeCount: appliedReport.beforeCount,
                    afterCount: appliedReport.afterCount,
                    missing: missingApplied,
                    dmScopeRetired: dmScopeRetiredApplied,
                    modelRunPruned: appliedReport.modelRunPruned,
                    pruned: appliedReport.pruned,
                    capped: appliedReport.capped,
                    unreferencedArtifacts,
                    diskBudget: appliedDiskBudget,
                    wouldMutate: true,
                    applied: true,
                    appliedCount: lifecycleResult.afterCount
                };
                return { mode, previewResults: [], appliedSummaries: [summary] };
            }
            /** Purge session store entries for a deleted agent (#65524). Best-effort. */
        `,
        "session-entry-slot-keys-fixture.js": `
            function collectSessionMaintenancePreserveKeys(baseKeys) { return new Set(baseKeys); }
            function collectActiveSessionWorkAdmissionKeys(params) { return new Set(); }
            /** Collects every runtime and active-work key protected from automatic maintenance. */
            function collectSessionMaintenancePreserveKeysForStore(params) {
                const keys = collectSessionMaintenancePreserveKeys(params.baseKeys) ?? new Set();
                for (const key of collectActiveSessionWorkAdmissionKeys({
                    storePath: params.storePath,
                    store: params.store
                }) ?? []) keys.add(key);
                return keys.size > 0 ? keys : void 0;
            }
            //#endregion
            function isPrimarySessionMaintenanceKey(sessionKey) { return sessionKey === "main"; }
            function isTelegramTopicSessionKey(sessionKey) { return false; }
            function isExternalGroupOrChannelSessionKey(sessionKey) { return false; }
            function isProtectedSessionMaintenanceEntry(sessionKey, entry) {
                if (isPrimarySessionMaintenanceKey(sessionKey)) return true;
                if (parseSessionThreadInfoFast(sessionKey).threadId) return true;
                if (isTelegramTopicSessionKey(sessionKey)) return true;
                if (isExternalGroupOrChannelSessionKey(sessionKey)) return true;
                const chatType = normalizeLowercaseStringOrEmpty(entry?.chatType ?? sessionDeliveryOrigin(entry)?.chatType);
                return chatType === "group" || chatType === "channel" || chatType === "thread";
            }
            function shouldPreserveMaintenanceEntry(params) {
                if (params.entry?.archivedAt !== void 0) return true;
                return params.entry?.modelSelectionLocked === true ||
                    params.preserveKeys?.has(params.key) === true ||
                    isProtectedSessionMaintenanceEntry(params.key, params.entry);
            }
            function getActiveSessionMaintenanceWarning(params) { return null; }
            function resolveMaintenanceConfig() {
                let maintenance;
                try {
                    maintenance = getRuntimeConfig().session?.maintenance;
                } catch {}
                return resolveMaintenanceConfigFromInput(maintenance);
            }
            async function pruneUnreferencedSessionArtifacts(params) {
                return {
                    scannedFiles: files.length + promptBlobFiles.length,
                    removedFiles,
                    freedBytes,
                    olderThanMs
                };
            }
            async function enforceSessionDiskBudget(params) {
                return {
                    totalBytesBefore: totalBefore,
                    totalBytesAfter: total,
                    removedFiles,
                    removedEntries,
                    freedBytes,
                    maxBytes,
                    highWaterBytes,
                    overBudget: true
                };
            }
            //#endregion
        `,
        "session-accessor.sqlite-fixture.js": `
            function collectSqliteSessionMaintenanceBaseKeys(store, activeSessionKey) {
                const keys = [];
                let currentKey = normalizeStoreSessionKey(activeSessionKey);
                while (currentKey) {
                    keys.push(currentKey);
                    currentKey = normalizeStoreSessionKey(store[currentKey]?.parentSessionKey ?? "");
                }
                return keys;
            }
            function hasStaleSqliteSessionEntryCandidate() { return false; }
            function applySqliteSessionEntryMaintenance(database, params) {
                const store = {};
                const preserveKeys = collectSessionMaintenancePreserveKeysForStore({
                    storePath: params.storePath,
                    store,
                    baseKeys: collectSqliteSessionMaintenanceBaseKeys(store, params.activeSessionKey)
                }) ?? new Set();
                pruneStaleEntries(store, maintenance.pruneAfterMs, { preserveKeys });
                capEntryCount(store, maintenance.maxEntries, { preserveKeys });
                return { entryRemovals: [], stateDeletePlans: [] };
            }
            function finalizeSqliteSessionEntryMaintenancePlansBestEffort(scope, plans) { return []; }
            /** Applies exact lifecycle removals/upserts using SQLite session rows. */
            async function applySqliteSessionEntryLifecycleMutation(params) {
                if (!sqliteSessionEntriesEqual(entry, removal.expectedEntry)) throw new Error("changed");
                applySqliteSessionEntryMaintenance(database, {
                    activeSessionKey: params.activeSessionKey ?? "",
                    forceMaintenance: params.maintenanceOverride !== void 0,
                    maintenanceConfig: params.maintenanceOverride ? {
                        ...resolveMaintenanceConfig(),
                        ...params.maintenanceOverride
                    } : void 0
                });
                return { afterCount: 1 };
            }
            /** Purges entries owned by a deleted agent from SQLite session rows. */
        `,
        "update-fixture.js": `
            const MANAGED_HANDOFF_RESTART_DELAY_MS = 2e3;
            function hasManagedServiceHandoffContext(env, supervisor) {
                if (supervisor === "systemd") return Boolean(env.OPENCLAW_SYSTEMD_UNIT?.trim());
                return false;
            }
            function resolveManagedServiceHandoffRestartDelayMs(restartDelayMs, supervisor) {
                const resolvedDelayMs = restartDelayMs ?? MANAGED_HANDOFF_RESTART_DELAY_MS;
                if (supervisor !== "systemd") return resolvedDelayMs;
                return Math.max(resolvedDelayMs, MANAGED_HANDOFF_RESTART_DELAY_MS);
            }
            const updateHandlers = {
                "update.status": async () => {},
                "update.run": async ({ params, respond, client, context }) => {
                    if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) return;
                    const timeoutMsRaw = params.timeoutMs;
                    const timeoutMs = typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) ? Math.max(1e3, Math.floor(timeoutMsRaw)) : void 0;
                    const installSurface = {};
                    const supervisor = "systemd";
                    const hasHandoffContext = supervisor ? hasManagedServiceHandoffContext(process.env, supervisor) : false;
                    const requiresManagedServiceHandoff = installSurface.kind === "global" || installSurface.kind === "git" && supervisor !== null;
                    let result;
                    let handoff = null;
                    let managedHandoffRestart = null;
                    let ownsManagedServiceHandoff = true;
                    if (requiresManagedServiceHandoff && hasHandoffContext) {
                        const started = await startManagedServiceUpdateHandoff({ timeoutMs });
                        ownsManagedServiceHandoff = started.status === "started";
                        if (ownsManagedServiceHandoff) {
                            handoff = {
                                status: "started",
                                ...started.pid ? { pid: started.pid } : {},
                                command: started.command
                            };
                            managedHandoffRestart = scheduleGatewaySigusr1Restart({
                                reason: "update.run",
                                skipDeferral: true,
                                skipCooldown: true
                            });
                        } else handoff = {
                            status: "already-running",
                            command: started.command,
                            message: "Another managed update is already running; retry after it completes."
                        };
                    } else {
                        result = await runGatewayUpdate({
                            timeoutMs,
                            allowGatewayServiceRepair: false,
                            allowGatewayActivation: false
                        });
                    }
                    const payload = buildUpdateRestartSentinelPayload({ result, meta: {} });
                    let sentinelPersisted = false;
                    if (ownsManagedServiceHandoff) try {
                        await writeRestartSentinel(payload);
                        sentinelPersisted = true;
                    } catch {}
                    const updateWasPackageSwap = result.status === "ok" && result.mode !== "git";
                    const restart = managedHandoffRestart ?? (result.status === "ok" ? scheduleGatewaySigusr1Restart({
                        delayMs: updateWasPackageSwap ? 0 : undefined,
                        reason: "update.run",
                        skipDeferral: updateWasPackageSwap,
                        skipCooldown: updateWasPackageSwap
                    }) : null);
                    respond(true, {
                        ok: result.status === "ok" || handoff?.status === "started",
                        result,
                        ...handoff ? { handoff } : {},
                        restart,
                        sentinel: {
                            persisted: sentinelPersisted,
                            payload
                        }
                    }, void 0);
                }
            };
            //#endregion
        `,
        "update-startup-fixture.js": `
            const HANDOFF_READY_TIMEOUT_MS = 3e4;
            const HANDOFF_READY_MARKER = "OPENCLAW_UPDATE_HANDOFF_READY\\n";
            const HANDOFF_SCRIPT = String.raw\`
                function cleanupSensitiveFiles() {}
                cleanupSensitiveFiles();
            \`;
            function resolveUpdateCliArgv(params) {
                const updateArgs = ["update", "--yes", "--json"];
                if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) updateArgs.push("--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1e3))));
                return ["openclaw", ...updateArgs];
            }
            function formatManagedServiceUpdateCommand(params) {
                const args = ["openclaw", "update", "--yes"];
                if (typeof params?.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) args.push("--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1e3))));
                return args.join(" ");
            }
            function resolveGatewayServiceRecovery(supervisor, env) { return {}; }
            async function waitForHandoffReady(child) {
                if (buffered.includes(HANDOFF_READY_MARKER)) finish();
                setTimeout(() => finish(new Error("managed update handoff did not signal readiness within 30 seconds")), HANDOFF_READY_TIMEOUT_MS);
            }
            async function resolveHandoffSpawn(params) {
                return { args: ["--user", "--scope", "--collect"] };
            }
            async function spawnManagedServiceUpdateHandoff(params, onExit) {
                const helperParams = {
                    sensitivePaths: [scriptPath, paramsPath, metaPath]
                };
                const child = spawn(command, args, { detached: true });
                child.unref();
                return { status: "started", command: "openclaw update --yes" };
            }
            async function startManagedServiceUpdateHandoff(params) {
                const active = activeManagedServiceUpdateHandoff;
                if (active) return {
                    ...await active,
                    status: "joined"
                };
                return await spawnManagedServiceUpdateHandoff(params, () => {});
            }
            function buildManagedServiceHandoffUnavailableMessage(command) { return command; }
        `,
        "update-runner-fixture.js": `
            const MAX_LOG_CHARS = 8e3;
            async function runStep(opts) {
                const { runCommand, name, argv, cwd, timeoutMs, progress, stepIndex, totalSteps } = opts;
                const command = argv.join(" ");
                const result = await runCommand(argv, {
                    cwd,
                    timeoutMs,
                    env
                });
                const stderrTail = trimLogTail(result.stderr, MAX_LOG_CHARS);
                return {
                    name,
                    command,
                    cwd,
                    durationMs: 1,
                    exitCode: result.code,
                    stdoutTail: trimLogTail(result.stdout, MAX_LOG_CHARS),
                    stderrTail,
                    signal: result.signal
                };
            }
            function normalizeFallbackFailureReason(stepName) { return "unexpected-error"; }
            function successfulUpdateResult() { return { status: "ok" }; }
            async function runGatewayUpdate(opts = {}) {
                const timeoutMs = opts.timeoutMs ?? 12e5;
                if (gitRoot) return await runGitUpdate({ timeoutMs });
                if (globalManager) return await runGlobalUpdate({ timeoutMs });
                return {
                    status: "skipped",
                    mode: "unknown",
                    root: pkgRoot,
                    reason: "not-git-install",
                    before: { version: beforeVersion },
                    steps: [],
                    durationMs: 0
                };
            }
            //#endregion
        `,
        "update-control-plane-sentinel-fixture.js": `
            function buildUpdateRestartSentinelPayload(params) {
                const { result, meta } = params;
                return {
                    kind: "update",
                    status: result.status,
                    message: meta.note ?? null,
                    doctorHint: formatDoctorNonInteractiveHint(),
                    stats: {
                        mode: result.mode,
                        ...result.root ? { root: result.root } : {},
                        ...meta.handoffId ? { handoffId: meta.handoffId } : {},
                        before: result.before ?? null,
                        after: result.after ?? null,
                        steps: result.steps.map((step) => ({
                            command: step.command,
                            cwd: step.cwd,
                            log: {
                                stdoutTail: step.stdoutTail ?? null,
                                stderrTail: step.stderrTail ?? null
                            }
                        }))
                    }
                };
            }
            //#endregion
            const CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";
            function isPendingControlPlaneUpdateRestartSentinel(payload) {
                return payload.stats?.reason === CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON;
            }
        `,
        "reset-policy-fixture.js": `
            const DEFAULT_RESET_MODE = "none";
            const DEFAULT_RESET_AT_HOUR = 4;
            function resolveSessionResetPolicy(params) {
                const baseReset = params.baseReset;
                const typeReset = params.typeReset;
                const configured = Boolean(baseReset || typeReset);
                const inheritedTypeMode = typeReset && baseReset?.mode !== "none" ? baseReset?.mode : void 0;
                const mode = typeReset?.mode ?? inheritedTypeMode ?? (typeReset ? "daily" : void 0) ?? baseReset?.mode ?? (baseReset ? "daily" : DEFAULT_RESET_MODE);
                const atHour = normalizeResetAtHour(typeReset?.atHour ?? baseReset?.atHour ?? DEFAULT_RESET_AT_HOUR);
                let idleMinutes;
                if (mode === "daily") idleMinutes = undefined;
                else if (mode === "idle") idleMinutes = 0;
                return { mode, atHour, idleMinutes, configured };
            }
            /** Evaluates whether a persisted session is still fresh under the resolved reset policy. */
        `,
        "runtime-fetch-fixture.js": `
            function resolveWebFetchEnabled(params) {
                if (typeof params.fetch?.enabled === "boolean") return params.fetch.enabled;
                return true;
            }
            function resolveFetchConfig(config) { return config; }
            function resolveWebFetchProviderId(params) { return params.provider; }
            function resolveWebFetchDefinition(options) { return options; }
        `,
        "runtime-search-fixture.js": `
            function resolveWebSearchEnabled(params) {
                if (typeof params.search?.enabled === "boolean") return params.search.enabled;
                if (params.sandboxed) return true;
                return true;
            }
            function hasEntryCredential(provider, config, search, agentDir) { return false; }
            function resolveWebSearchProviderId(params) { return params.provider; }
            function resolveWebSearchCandidates(options) { return []; }
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
            { name: "sessions.cleanup", scope: "operator.admin" },
            { name: "sessions.reset", scope: "operator.admin" },
            { name: "sessions.subscribe", scope: "operator.read" },
            { name: "cron.get", scope: "operator.read" },
            { name: "cron.list", scope: "operator.read" },
            { name: "cron.remove", scope: "operator.admin" },
            { name: "cron.run", scope: "operator.admin" },
            { name: "cron.runs", scope: "operator.read" },
            { name: "cron.update", scope: "operator.admin" },
            { name: "config.get", scope: "operator.read" },
            { name: "config.patch", scope: "operator.admin", controlPlaneWrite: true },
            { name: "skills.status", scope: "operator.read" },
            { name: "skills.update", scope: "operator.admin" },
            { name: "update.run", scope: "operator.admin", controlPlaneWrite: true },
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
            /** Empty request payload for reading the current raw config. */
            const ConfigGetParamsSchema = closedObject({});
            /** Full raw config replacement request with optional base hash guard. */
            const ConfigApplyLikeParamProperties = {
\traw: NonEmptyString,
\tbaseHash: Type.Optional(NonEmptyString),
\tsessionKey: Type.Optional(Type.String()),
\tdeliveryContext: Type.Optional(ConfigDeliveryContextSchema),
\tnote: Type.Optional(Type.String()),
\trestartDelayMs: Type.Optional(Type.Integer({ minimum: 0 }))
            };
            const ConfigPatchParamsSchema = closedObject({
\t...ConfigApplyLikeParamProperties,
\treplacePaths: Type.Optional(Type.Array(NonEmptyString, { maxItems: 256 }))
            });
            /** Empty request payload for fetching the generated config schema. */
            const UpdateStatusParamsSchema = closedObject({});
            /** Request payload for running an update/restart flow with optional channel delivery context. */
            const UpdateRunParamsSchema = closedObject({
\tsessionKey: Type.Optional(Type.String()),
\tdeliveryContext: Type.Optional(ConfigDeliveryContextSchema),
\tnote: Type.Optional(Type.String()),
\tcontinuationMessage: Type.Optional(Type.String()),
\trestartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
\ttimeoutMs: Type.Optional(Type.Integer({ minimum: 1 }))
            });
            /** UI metadata attached to config schema paths. */
            /** Reads installed skill status, optionally for a selected agent. */
            const SkillsStatusParamsSchema = closedObject({ agentId: Type.Optional(NonEmptyString) });
            /** Empty request payload for listing available skill bins. */
            const SkillsUpdateParamsSchema = Type.Union([closedObject({
\tskillKey: NonEmptyString,
\tenabled: Type.Optional(Type.Boolean()),
\tapiKey: Type.Optional(Type.String()),
\tenv: Type.Optional(Type.Record(NonEmptyString, Type.String()))
            }), closedObject({
\tagentId: Type.Optional(NonEmptyString),
\tsource: Type.Literal("clawhub"),
\tslug: Type.Optional(NonEmptyString),
\tall: Type.Optional(Type.Boolean()),
\tacknowledgeClawHubRisk: Type.Optional(Type.Boolean())
            })]);
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

            /** Repairs or removes invalid session records from the selected agent scope. */
            const SessionsCleanupParamsSchema = closedObject({
\tagent: Type.Optional(NonEmptyString),
\tallAgents: Type.Optional(Type.Boolean()),
\tenforce: Type.Optional(Type.Boolean()),
\tactiveKey: Type.Optional(NonEmptyString),
\tfixMissing: Type.Optional(Type.Boolean()),
\tfixDmScope: Type.Optional(Type.Boolean())
            });
            /** Reads short previews for selected session keys. */
            const SessionsPreviewParamsSchema = closedObject({});

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
                "sessions.cleanup": async ({ params, respond, context }) => {
                    if (!assertValidParams(params, validateSessionsCleanupParams, "sessions.cleanup", respond)) return;
                    try {
                        const { mode, appliedSummaries } = await runSessionsCleanup({
                            cfg: context.getRuntimeConfig(),
                            opts: {
                                agent: params.agent,
                                allAgents: params.allAgents,
                                enforce: params.enforce,
                                activeKey: params.activeKey,
                                fixMissing: params.fixMissing,
                                fixDmScope: params.fixDmScope
                            }
                        });
                        respond(true, serializeSessionCleanupResult({
                            mode,
                            dryRun: false,
                            summaries: appliedSummaries
                        }), void 0);
                        emitSessionsChanged(context, { reason: "cleanup" });
                    } catch (error) {
                        respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
                    }
                },
                "sessions.preview": async () => {},
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
        expect(reviewed.audit.sourceArtifacts).toHaveLength(90);
        expect(reviewed.audit.chat.adapter.media.localHistory).toEqual({
            canonical: {
                fields: [
                    "contentType",
                    "durationMs",
                    "fileName",
                    "height",
                    "hydrationSuppressed",
                    "kind",
                    "messageId",
                    "path",
                    "sizeBytes",
                    "staged",
                    "transcribed",
                    "url",
                    "width",
                    "workspaceDir",
                ],
                persistedPath: "__openclaw.media",
                retiredTopLevelMediaMigrated: true,
            },
            directives: {
                fencedBlocksPreserved: true,
                fileUrlPrefixStripped: true,
                invalidLocalPathDirectiveRemovedFromVisibleText: true,
                lineLeadingAfterWhitespace: true,
                maximumCandidateCharacters: 4096,
                scope: "outbound-reply-output",
                token: "MEDIA:",
                traversalSegmentsRejected: true,
            },
            legacy: {
                pluralFields: ["MediaPaths", "MediaTypes", "MediaUrls"],
                singularFields: ["MediaPath", "MediaType", "MediaUrl"],
            },
            persistence: {
                ambiguousSparseLegacyAlignmentRejected: true,
                canonicalizedBeforeSqliteWrite: true,
                retiredFieldsDeleted: true,
                underCardinalLegacyTypesDroppedWhenUnambiguous: true,
            },
            precedence: {
                contentType: [
                    "canonical.contentType",
                    "MediaTypes[index]",
                    "MediaType[index=0]",
                ],
                path: ["canonical.path", "MediaPaths[index]", "MediaPath[index=0]"],
                slotCount: "maximum-canonical-paths-urls-types-or-singular",
                url: [
                    "canonical.url",
                    "MediaUrls[index]",
                    "MediaUrl[index=0-or-MediaPaths-present]",
                ],
            },
            projection: {
                canonicalEnvelopeOnly: true,
                mediaOnlyUserMessagesRetained: true,
            },
            root: { mediaStore: "config-directory/media" },
        });
        expect(reviewed.audit.settings.methodAccess).toEqual([
            { controlPlaneWrite: false, name: "config.get", scope: "operator.read" },
            { controlPlaneWrite: true, name: "config.patch", scope: "operator.admin" },
            { controlPlaneWrite: false, name: "skills.status", scope: "operator.read" },
            { controlPlaneWrite: false, name: "skills.update", scope: "operator.admin" },
        ]);
        expect(reviewed.audit.settings.agentAccess.entries).toEqual({
            blockedObjectKeysRejected: true,
            defaultEntryCount: 1,
            idCaseInsensitive: true,
            idMaximumLength: 64,
            idMinimumLength: 1,
            idPattern: "^[a-z0-9_][a-z0-9_-]{0,63}$",
            inlineIdOmitted: true,
            storagePath: "agents.entries",
            storageShape: "record-by-id",
        });
        expect(reviewed.audit.settings.agentAccess.toolsPolicy.aliases).toEqual([
            "bash=>exec",
            "cron=>automations",
        ]);
        expect(reviewed.audit.settings.channels).toEqual({
            providerEntriesArePassthrough: true,
            providerEntryEnabledUnlessExplicitlyFalse: true,
            reservedConfigKeys: ["defaults", "modelByChannel"],
        });
        expect(reviewed.audit.settings.configPatch.modelNormalization).toEqual({
            agentScopeCollections: ["defaults", "entries", "list"],
            agentSelectionFields: [
                "imageModel",
                "model",
                "pdfModel",
                "utilityModel",
                "voiceModel",
            ],
            appliedBeforeMerge: true,
            dynamicEnvironmentRefs: {
                canonicalizedResolvedValueDoesNotRestoreOriginalReference: true,
                resolvedBeforeSnapshotValidation: true,
                restoredOnlyWhenResolvedValueUnchanged: true,
            },
            googleAliases: [
                "gemini-3-pro=>gemini-3.1-pro-preview",
                "gemini-3-pro-preview=>gemini-3.1-pro-preview",
                "gemini-3-flash=>gemini-3-flash-preview",
                "gemini-3.1-pro=>gemini-3.1-pro-preview",
                "gemini-3.1-flash-lite-preview=>gemini-3.1-flash-lite",
                "gemini-3.1-flash=>gemini-3-flash-preview",
                "gemini-3.1-flash-preview=>gemini-3-flash-preview",
                "gemma-4-26b=>gemma-4-26b-a4b-it",
            ],
            googleProviderIds: ["google", "google-gemini-cli", "google-vertex"],
            mediaSelectionFields: ["image", "music", "video"],
            modelSelectionShapes: ["fallbacks[]", "primary", "string"],
            nestedAgentModelPaths: [
                "compaction.memoryFlush.model",
                "compaction.model",
                "heartbeat.model",
                "models.<key>",
                "subagents.fallbacks[]",
                "subagents.model",
                "subagents.primary",
            ],
            nestedGoogleModelIdsNormalized: true,
            normalizesAgentScopes: true,
            normalizesProviderCatalogs: true,
            providerCatalogModelPath: "models.providers[].models[].id",
            togetherAliases: ["moonshotai/Kimi-K2.5=>moonshotai/Kimi-K2.6"],
            togetherProviderId: "together",
            wholeMergedCandidateNormalizedBeforeValidation: true,
        });
        expect(reviewed.audit.settings.exec).toMatchObject({
            defaultAsk: "off",
            defaultConfiguredHost: "auto",
            defaultSecurityByEffectiveHost: {
                nonSandbox: "full",
                sandbox: "deny",
            },
            modePolicies: [
                "allowlist:allowlist:off:no-auto-review",
                "ask:allowlist:on-miss:no-auto-review",
                "auto:allowlist:on-miss:auto-review",
                "deny:deny:off:no-auto-review",
                "full:full:off:no-auto-review",
            ],
        });
        expect(reviewed.audit.settings.toolActivationDefaults).toEqual({
            agentToAgentRequiresExplicitTrue: true,
            elevatedEnabledUnlessExplicitlyFalse: true,
            webFetchEnabledWhenOmitted: true,
            webSearchEnabledWhenOmitted: true,
        });
        expect(reviewed.audit.settings.skillsUpdate.request).toEqual({
            baseHashAccepted: false,
            localParams: ["apiKey", "enabled", "env", "skillKey"],
            unpatchableConfigEntryKeys: ["constructor", "prototype"],
        });
        expect(reviewed.audit.settings.skillsStatus.source).toEqual({
            bundling: {
                canonicalBundledSource: "openclaw-bundled",
                unknownSourceUsesBundledNameFallback: true,
            },
            fallback: {
                canonicalField: "skill.source",
                compatibilityField: "skill.sourceInfo.source",
                missingSource: "unknown",
            },
            keyResolution: {
                canonicalField: "entry.metadata.skillKey",
                fallbackField: "skill.name",
                indexUsesResolver: true,
                statusUsesIndexedKey: true,
            },
            taxonomy: [
                "agents-skills-personal",
                "agents-skills-project",
                "openclaw-bundled",
                "openclaw-extra",
                "openclaw-managed",
                "openclaw-node",
                "openclaw-workspace",
                "unknown",
            ],
        });
        expect(reviewed.audit.settings.configPatch.restart).toMatchObject({
            schedulerSuccess: {
                ok: true,
                resultFields: [
                    "coalesced",
                    "cooldownMsApplied",
                    "delayMs",
                    "emitHooksQueued",
                    "mode",
                    "ok",
                    "pid",
                    "reason",
                    "signal",
                ],
            },
            sentinelRequiresRestartPath: "sentinel.payload.stats.requiresRestart",
        });
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
                "operations.json",
                "sessions.json",
                "settings.json",
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
            expect(audit.settings.configPatch).toMatchObject({
                baseHash: {
                    blankIsAbsent: true,
                    generalWritesRequireHash: true,
                    hashlessLastWriterWinsPaths: ["ui.prefs"],
                    mismatchRejected: true,
                    protocolOptional: true,
                    writeUsesSnapshotHash: true,
                },
                redaction: {
                    patchRestoresSensitiveValuesFromSnapshot: true,
                    reservedOrUnrestorableSentinelRejected: true,
                    sentinel: "__OPENCLAW_REDACTED__",
                },
            });
            expect(audit.settings.agentAccess).toMatchObject({
                configPatchArrayReplacement: {
                    destructiveRemovalRequiresDeclaredPath: true,
                    exactPathTemplates: [
                        "agents.entries.<agentId>.tools.alsoAllow",
                        "agents.entries.<agentId>.tools.deny",
                    ],
                    listedPathReplacesArray: true,
                    pathComparison: "normalized-exact",
                },
                coreCatalog: {
                    canonicalSchedulerTool: "automations",
                    legacySchedulerAliases: ["cron"],
                },
                toolsPolicy: {
                    aliases: ["bash=>exec", "cron=>automations"],
                    nonEmptyAllowAndAlsoAllowConflictRejected: true,
                    optionalStringArrayFields: ["allow", "alsoAllow", "deny"],
                },
            });
            expect(audit.settings.channels).toEqual({
                providerEntriesArePassthrough: true,
                providerEntryEnabledUnlessExplicitlyFalse: true,
                reservedConfigKeys: ["defaults", "modelByChannel"],
            });
            expect(audit.settings.configPatch.modelNormalization).toMatchObject({
                appliedBeforeMerge: true,
                googleAliases: expect.arrayContaining([
                    "gemini-3-pro=>gemini-3.1-pro-preview",
                ]),
                togetherAliases: ["moonshotai/Kimi-K2.5=>moonshotai/Kimi-K2.6"],
            });
            expect(audit.settings.exec).toMatchObject({
                defaultAsk: "off",
                defaultConfiguredHost: "auto",
                modePolicies: expect.arrayContaining([
                    "auto:allowlist:on-miss:auto-review",
                ]),
            });
            expect(audit.settings.toolActivationDefaults).toEqual({
                agentToAgentRequiresExplicitTrue: true,
                elevatedEnabledUnlessExplicitlyFalse: true,
                webFetchEnabledWhenOmitted: true,
                webSearchEnabledWhenOmitted: true,
            });
            expect(audit.settings.skillsStatus.row).toMatchObject({
                disabledFrom: "skills.entries[skillKey].enabled-equals-false",
                eligibleRequiresNotDisabled: true,
            });
            expect(audit.settings.skillsUpdate.request).toEqual({
                baseHashAccepted: false,
                localParams: ["apiKey", "enabled", "env", "skillKey"],
                unpatchableConfigEntryKeys: ["constructor", "prototype"],
            });
            expect(audit.settings.skillsStatus.source.taxonomy).toEqual([
                "agents-skills-personal",
                "agents-skills-project",
                "openclaw-bundled",
                "openclaw-extra",
                "openclaw-managed",
                "openclaw-node",
                "openclaw-workspace",
                "unknown",
            ]);
            expect(audit.settings.configPatch.restart).toMatchObject({
                schedulerSuccess: { ok: true },
                sentinelRequiresRestartPath: "sentinel.payload.stats.requiresRestart",
            });
            expect(audit.operations.methodAccess).toEqual([
                {
                    controlPlaneWrite: false,
                    lane: "one-shot-admin",
                    method: "sessions.cleanup",
                    scope: "operator.admin",
                },
                {
                    controlPlaneWrite: true,
                    lane: "one-shot-admin",
                    method: "update.run",
                    scope: "operator.admin",
                },
            ]);
            expect(audit.operations.sessionsCleanup).toMatchObject({
                outcome: {
                    automaticReplaySafe: false,
                    handlerTimeoutParameter: false,
                    idempotencyParameter: false,
                    postDispatchTransportTimeout: "outcome-unknown",
                },
                request: {
                    acceptedParams: [
                        "activeKey",
                        "agent",
                        "allAgents",
                        "enforce",
                        "fixDmScope",
                        "fixMissing",
                    ],
                    closedObject: true,
                    requiredParams: [],
                },
                response: {
                    sensitivePaths: ["storePath", "stores[].storePath"],
                },
            });
            expect(audit.operations.updateRun).toMatchObject({
                managedHandoff: {
                    internalJoinedStatusCrossesRpc: false,
                    nonOwningWireStatus: "already-running",
                    readyMarkerTimeoutMs: 30_000,
                    sensitiveTemporaryFilesRemoved: true,
                    startedHandoffCountsAsAccepted: true,
                },
                outcome: {
                    automaticReplaySafe: false,
                    handlerAbortSignal: false,
                    idempotencyParameter: false,
                    operationalErrorsUseRpcSuccess: true,
                    postDispatchTransportTimeout: "outcome-unknown",
                },
                response: {
                    sentinelPersistenceBestEffort: true,
                    sensitivePaths: expect.arrayContaining([
                        "handoff.command",
                        "result.root",
                        "result.steps[].stdoutTail",
                        "sentinel.payload",
                    ]),
                },
                timeout: {
                    defaultRunnerPerStepMs: 1_200_000,
                    handlerFloorMs: 1000,
                    perStepRatherThanWholeOperation: true,
                },
            });
            expect(audit.sourceArtifacts).toHaveLength(90);
            expect(audit.chat.adapter.media.localHistory.precedence.url).toEqual([
                "canonical.url",
                "MediaUrls[index]",
                "MediaUrl[index=0-or-MediaPaths-present]",
            ]);
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

    test("rejects drift in source-backed local-history media facts", async () => {
        await withTemporaryDirectory(
            "mira-openclaw-local-media-",
            async (temporaryRoot) => {
                const cases = [
                    {
                        expected: "media carrier precedence changed",
                        fileName: "media-facts-fixture.js",
                        from: "paths.length > 0 || index === 0",
                        name: "legacy-url-precedence",
                        to: "index === 0",
                    },
                    {
                        expected: "MEDIA directive projection changed",
                        fileName: "payloads-media-fixture.js",
                        from: "const trimmedStart = line.trimStart()",
                        name: "directive-line-boundary",
                        to: "const trimmedStart = line",
                    },
                    {
                        expected: "canonical media history projection changed",
                        fileName: "chat-display-projection-fixture.js",
                        from: "&& !hasTranscriptMediaFacts(message)",
                        name: "media-only-message",
                        to: "&& hasTranscriptMediaFacts(message)",
                    },
                    {
                        expected: "SQLite media canonicalization changed",
                        fileName: "session-accessor.sqlite-transcript-store-fixture.js",
                        from: "event_json: JSON.stringify(persistedEvent)",
                        name: "sqlite-canonicalization",
                        to: "event_json: JSON.stringify(event)",
                    },
                    {
                        expected:
                            "Expected one OpenClaw media-store-root artifact, found 0",
                        fileName: "store-media-fixture.js",
                        from: 'path.join(resolveConfigDir(), "media")',
                        name: "media-store-root",
                        to: 'path.join(resolveStateDir(), "media")',
                    },
                ] as const;

                for (const driftCase of cases) {
                    const sourceRoot = path.join(temporaryRoot, driftCase.name);
                    await writeSyntheticOpenClawPackage(sourceRoot);
                    const artifactPath = path.join(
                        sourceRoot,
                        "dist",
                        driftCase.fileName
                    );
                    const source = await readFile(artifactPath, "utf8");
                    expect(source).toContain(driftCase.from);
                    await writeFile(
                        artifactPath,
                        source.replace(driftCase.from, driftCase.to),
                        "utf8"
                    );

                    const error = await rejectedError(auditInstalledOpenClaw(sourceRoot));
                    expect(error.message).toContain(driftCase.expected);
                }
            }
        );
    });

    test("rejects drift in privileged operations access and execution facts", async () => {
        const driftCases = [
            {
                expected: "permission descriptor changed for sessions.cleanup",
                fileName: "core-descriptors-fixture.js",
                from: '{ name: "sessions.cleanup", scope: "operator.admin" }',
                to: '{ name: "sessions.cleanup", scope: "operator.read" }',
            },
            {
                expected: "update.run optional params changed",
                fileName: "src-fixture.js",
                from: "timeoutMs: Type.Optional(Type.Integer({ minimum: 1 }))",
                to: "timeoutMs: Type.Optional(Type.Integer({ minimum: 0 }))",
            },
            {
                expected: "sessions.cleanup execution changed",
                fileName: "cleanup-service-fixture.js",
                from: 'const appliedUnreferencedArtifacts = mode === "warn" ? null',
                to: 'const appliedUnreferencedArtifacts = mode === "enforce" ? null',
            },
            {
                expected: "update.run handler changed",
                fileName: "update-fixture.js",
                from: 'ok: result.status === "ok" || handoff?.status === "started"',
                to: "ok: true",
            },
        ] as const;

        for (const driftCase of driftCases) {
            await withTemporaryDirectory(
                "mira-openclaw-operations-drift-",
                async (sourceRoot) => {
                    await writeSyntheticOpenClawPackage(sourceRoot);
                    const artifactPath = path.join(
                        sourceRoot,
                        "dist",
                        driftCase.fileName
                    );
                    const source = await readFile(artifactPath, "utf8");
                    expect(source).toContain(driftCase.from);
                    await writeFile(
                        artifactPath,
                        source.replace(driftCase.from, driftCase.to),
                        "utf8"
                    );

                    const error = await rejectedError(auditInstalledOpenClaw(sourceRoot));
                    expect(error.message).toContain(driftCase.expected);
                }
            );
        }
    });

    test("rejects cleanup disk-budget enforcement before lifecycle mutation", async () => {
        await withTemporaryDirectory(
            "mira-openclaw-cleanup-order-drift-",
            async (sourceRoot) => {
                await writeSyntheticOpenClawPackage(sourceRoot);
                const artifactPath = path.join(
                    sourceRoot,
                    "dist",
                    "cleanup-service-fixture.js"
                );
                const source = await readFile(artifactPath, "utf8");
                const lifecycleCall =
                    "const lifecycleResult = await applySqliteSessionEntryLifecycleMutation({";
                const diskBudgetCall =
                    "const appliedDiskBudget = await enforceSqliteSessionHistoryDiskBudget({";
                const lifecycleIndex = source.indexOf(lifecycleCall);
                const diskBudgetIndex = source.indexOf(diskBudgetCall);
                expect(lifecycleIndex).toBeGreaterThanOrEqual(0);
                expect(diskBudgetIndex).toBeGreaterThan(lifecycleIndex);
                const reordered =
                    source.slice(0, lifecycleIndex) +
                    diskBudgetCall +
                    source.slice(lifecycleIndex + lifecycleCall.length, diskBudgetIndex) +
                    lifecycleCall +
                    source.slice(diskBudgetIndex + diskBudgetCall.length);
                await writeFile(artifactPath, reordered, "utf8");

                const error = await rejectedError(auditInstalledOpenClaw(sourceRoot));
                expect(error.message).toContain(
                    "sessions.cleanup no longer applies lifecycle mutation before disk budget enforcement"
                );
            }
        );
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

    test("rejects settings permission and config safety drift", async () => {
        await withTemporaryDirectory(
            "mira-openclaw-settings-safety-",
            async (temporaryRoot) => {
                const scopeRoot = path.join(temporaryRoot, "scope");
                await writeSyntheticOpenClawPackage(scopeRoot);
                const descriptorPath = path.join(
                    scopeRoot,
                    "dist",
                    "core-descriptors-fixture.js"
                );
                const descriptors = await readFile(descriptorPath, "utf8");
                expect(descriptors).toContain(
                    '{ name: "config.patch", scope: "operator.admin", controlPlaneWrite: true }'
                );
                await writeFile(
                    descriptorPath,
                    descriptors.replace(
                        '{ name: "config.patch", scope: "operator.admin", controlPlaneWrite: true }',
                        '{ name: "config.patch", scope: "operator.write", controlPlaneWrite: true }'
                    ),
                    "utf8"
                );
                const scopeError = await rejectedError(auditInstalledOpenClaw(scopeRoot));
                expect(scopeError.message).toContain(
                    "permission descriptor changed for config.patch"
                );

                const hashRoot = path.join(temporaryRoot, "base-hash");
                await writeSyntheticOpenClawPackage(hashRoot);
                const configPath = path.join(hashRoot, "dist", "config-fixture.js");
                const configSource = await readFile(configPath, "utf8");
                expect(configSource).toContain("if (baseHash !== snapshotHash)");
                await writeFile(
                    configPath,
                    configSource.replace(
                        "if (baseHash !== snapshotHash)",
                        "if (baseHash === snapshotHash)"
                    ),
                    "utf8"
                );
                const hashError = await rejectedError(auditInstalledOpenClaw(hashRoot));
                expect(hashError.message).toContain("config.patch base hash changed");

                const sentinelRoot = path.join(temporaryRoot, "sentinel");
                await writeSyntheticOpenClawPackage(sentinelRoot);
                const redactionPath = path.join(
                    sentinelRoot,
                    "dist",
                    "redact-snapshot-fixture.js"
                );
                const redactionSource = await readFile(redactionPath, "utf8");
                expect(redactionSource).toContain(
                    'assertNoRedactedSentinel(restored, "")'
                );
                await writeFile(
                    redactionPath,
                    redactionSource.replace(
                        'assertNoRedactedSentinel(restored, "")',
                        "validateRestoredConfig(restored)"
                    ),
                    "utf8"
                );
                const sentinelError = await rejectedError(
                    auditInstalledOpenClaw(sentinelRoot)
                );
                expect(sentinelError.message).toContain(
                    "config redaction sentinel changed"
                );
            }
        );
    });

    test("rejects drift in source-backed Agent access constraints", async () => {
        await withTemporaryDirectory(
            "mira-openclaw-agent-access-",
            async (temporaryRoot) => {
                const cases = [
                    {
                        expected: "agents.entries config schema changed",
                        fileName: "zod-schema-fixture.js",
                        from: "[a-z0-9_-]{0,63}",
                        name: "agent-id",
                        to: "[a-z0-9_-]{0,127}",
                    },
                    {
                        expected: "agent tools policy changed",
                        fileName: "zod-schema.agent-runtime-fixture.js",
                        from: "agent tools cannot set both allow and alsoAllow",
                        name: "tool-conflict",
                        to: "agent tools may set both allow and alsoAllow",
                    },
                    {
                        expected: "core gateway tool catalog entry changed",
                        fileName: "tool-catalog-fixture.js",
                        from: '{ id: "gateway" }',
                        name: "core-catalog",
                        to: '{ id: "gateway_admin" }',
                    },
                    {
                        expected:
                            "Expected one OpenClaw tool-policy-normalization artifact, found 0",
                        fileName: "tool-policy-fixture.js",
                        from: 'bash: "exec"',
                        name: "bash-alias",
                        to: 'bash: "shell"',
                    },
                    {
                        expected: "tool policy alias normalization changed",
                        fileName: "tool-policy-fixture.js",
                        from: "return TOOL_NAME_ALIASES[normalized] ?? normalized;",
                        name: "cron-alias",
                        to: "return normalized;",
                    },
                    {
                        expected: "config.patch exact replacement intent changed",
                        fileName: "config-fixture.js",
                        from: "!params.replacePaths.has(path)",
                        name: "replacement-intent",
                        to: "!params.replacePaths.has(key)",
                    },
                    {
                        expected: "config merge-patch array replacement changed",
                        fileName: "merge-patch-fixture.js",
                        from: "options.replaceArrayPaths?.has(path)",
                        name: "array-replacement",
                        to: "options.replaceArrayPaths?.has(key)",
                    },
                    {
                        expected: "config merge-patch blocked-key policy changed",
                        fileName: "merge-patch-fixture.js",
                        from: 'parentPath === "browser.profiles"',
                        name: "blocked-skill-key",
                        to: 'parentPath === "skills.entries"',
                    },
                ] as const;

                for (const driftCase of cases) {
                    const sourceRoot = path.join(temporaryRoot, driftCase.name);
                    await writeSyntheticOpenClawPackage(sourceRoot);
                    const artifactPath = path.join(
                        sourceRoot,
                        "dist",
                        driftCase.fileName
                    );
                    const source = await readFile(artifactPath, "utf8");
                    expect(source).toContain(driftCase.from);
                    await writeFile(
                        artifactPath,
                        source.replace(driftCase.from, driftCase.to),
                        "utf8"
                    );

                    const error = await rejectedError(auditInstalledOpenClaw(sourceRoot));
                    expect(error.message).toContain(driftCase.expected);
                }
            }
        );
    });

    test("rejects drift in settings normalization and activation defaults", async () => {
        await withTemporaryDirectory(
            "mira-openclaw-settings-defaults-",
            async (temporaryRoot) => {
                const cases = [
                    {
                        expected: "channel config schema changed",
                        fileName: "zod-schema.channels-config-fixture.js",
                        from: ").passthrough().superRefine",
                        name: "channel-passthrough",
                        to: ").strict().superRefine",
                    },
                    {
                        expected: "channel enabled default changed",
                        fileName: "channel-selection-fixture.js",
                        from: "return entry.enabled !== false;",
                        name: "channel-enabled-default",
                        to: "return entry.enabled === true;",
                    },
                    {
                        expected: "config.patch handler changed",
                        fileName: "config-fixture.js",
                        from: "const normalizedPatch = normalizeSubmittedConfigModelRefs(parsedRes.parsed, modelIdNormalizationPolicies);",
                        name: "model-normalization-dispatch",
                        to: "const normalizedPatch = parsedRes.parsed;",
                    },
                    {
                        expected: "Google model id normalization changed",
                        fileName: "provider-model-id-normalize-fixture.js",
                        from: 'return "gemini-3.1-pro-preview";',
                        name: "google-model-alias",
                        to: 'return "gemini-3-pro";',
                    },
                    {
                        expected: "Together model id normalization changed",
                        fileName: "provider-model-id-normalize-fixture.js",
                        from: 'return "moonshotai/Kimi-K2.6";',
                        name: "together-model-alias",
                        to: 'return "moonshotai/Kimi-K2.5";',
                    },
                    {
                        expected: "elevated tool defaults changed",
                        fileName: "get-reply-fixture.js",
                        from: "globalConfig?.enabled !== false",
                        name: "elevated-default",
                        to: "globalConfig?.enabled === true",
                    },
                    {
                        expected: "agent-to-agent default changed",
                        fileName: "session-visibility-fixture.js",
                        from: "routingA2A?.enabled === true",
                        name: "agent-to-agent-default",
                        to: "routingA2A?.enabled !== false",
                    },
                    {
                        expected: "exec config defaults changed",
                        fileName: "exec-defaults-fixture.js",
                        from: 'globalExec?.host ?? "auto"',
                        name: "exec-host-default",
                        to: 'globalExec?.host ?? "sandbox"',
                    },
                    {
                        expected: "exec mode policy changed",
                        fileName: "exec-approvals-fixture.js",
                        from: 'case "auto": return { security: "allowlist", ask: "on-miss", autoReview: true };',
                        name: "exec-auto-review",
                        to: 'case "auto": return { security: "allowlist", ask: "on-miss", autoReview: false };',
                    },
                ] as const;

                for (const driftCase of cases) {
                    const sourceRoot = path.join(temporaryRoot, driftCase.name);
                    await writeSyntheticOpenClawPackage(sourceRoot);
                    const artifactPath = path.join(
                        sourceRoot,
                        "dist",
                        driftCase.fileName
                    );
                    const source = await readFile(artifactPath, "utf8");
                    expect(source).toContain(driftCase.from);
                    await writeFile(
                        artifactPath,
                        source.replace(driftCase.from, driftCase.to),
                        "utf8"
                    );

                    const error = await rejectedError(auditInstalledOpenClaw(sourceRoot));
                    expect(error.message).toContain(driftCase.expected);
                }
            }
        );
    });

    test("rejects drift in pinned config IO, reset, web, and skill mutation facts", async () => {
        await withTemporaryDirectory(
            "mira-openclaw-settings-upstream-facts-",
            async (temporaryRoot) => {
                const cases = [
                    {
                        expected: "config.patch handler changed",
                        fileName: "config-fixture.js",
                        from: "const validationCandidate = normalizeSubmittedConfigModelRefs(stripBundledProviderRuntimeDefaults({",
                        name: "whole-merged-model-normalization",
                        to: "const validationCandidate = stripBundledProviderRuntimeDefaults({",
                    },
                    {
                        expected: "agent model scope normalization changed",
                        fileName: "model-input-normalization-fixture.js",
                        from: 'assign("heartbeat", normalizeNestedModelField(value.heartbeat, "model", normalizeStringModelRef));',
                        name: "heartbeat-model-traversal",
                        to: 'assign("heartbeat", value.heartbeat);',
                    },
                    {
                        expected: "provider catalog model normalization changed",
                        fileName: "model-input-normalization-fixture.js",
                        from: "normalizeConfiguredProviderCatalogModelId(providerId, trimmed, modelIdNormalizationPolicies)",
                        name: "provider-catalog-traversal",
                        to: "trimmed",
                    },
                    {
                        expected: "config.get response cache changed",
                        fileName: "config-get-response-fixture.js",
                        from: "configGetResponseCache.pluginRegistryVersion === pluginRegistryVersion",
                        name: "config-get-cache-key",
                        to: "true",
                    },
                    {
                        expected: "config snapshot read changed",
                        fileName: "io-fixture.js",
                        from: "const effectiveParsed = parsedRes.parsed;",
                        name: "authored-parsed-order",
                        to: "const effectiveParsed = resolved;",
                    },
                    {
                        expected: "config environment reference restoration changed",
                        fileName: "io-fixture.js",
                        from: "if (tryResolveString(parsed, env) === incoming) return parsed;",
                        name: "environment-reference-restoration",
                        to: "if (parsed !== incoming) return parsed;",
                    },
                    {
                        expected: "included config mutation changed",
                        fileName: "mutate-fixture.js",
                        from: "const persistedHash = resolveConfigSnapshotHash(refreshedSnapshot);",
                        name: "include-root-persisted-hash",
                        to: "const persistedHash = committedIncludeHash;",
                    },
                    {
                        expected: "config mutation base changed",
                        fileName: "mutate-fixture.js",
                        from: 'const baseConfig = params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig;',
                        name: "skill-mutation-source-base",
                        to: "const baseConfig = snapshot.runtimeConfig;",
                    },
                    {
                        expected: "config mutation retry changed",
                        fileName: "mutate-fixture.js",
                        from: "err.retryable && attempt < maxAttempts - 1",
                        name: "config-mutation-retry-fence",
                        to: "attempt < maxAttempts - 1",
                    },
                    {
                        expected: "config merge-patch array replacement changed",
                        fileName: "merge-patch-fixture.js",
                        from: "if (value === null) {",
                        name: "merge-patch-null-delete",
                        to: "if (value === undefined) {",
                    },
                    {
                        expected: "agent heartbeat defaults schema changed",
                        fileName: "zod-schema-fixture.js",
                        from: "heartbeat: HeartbeatSchema.unwrap().safeExtend({ agentId: string().trim().min(1).optional() }).optional()",
                        name: "heartbeat-target-defaults-path",
                        to: "heartbeat: HeartbeatSchema.optional()",
                    },
                    {
                        expected: "agent heartbeat schema changed",
                        fileName: "zod-schema.agent-runtime-fixture.js",
                        from: "target: string().optional()",
                        name: "heartbeat-target-optional-leaf",
                        to: "target: string()",
                    },
                    {
                        expected: "config post-commit dispatch changed",
                        fileName: "io-fixture.js",
                        from: "const writeResult = await io.writeConfigFile(nextCfg, {",
                        name: "persist-before-finalize",
                        to: "const writeResult = await finalizeRuntimeSnapshotWrite({",
                    },
                    {
                        expected: "config post-commit settlement changed",
                        fileName: "io-fixture.js",
                        from: "committedHash: writeResult.persistedHash",
                        name: "hash-guarded-rollback",
                        to: "committedHash: baseSnapshot.hash",
                    },
                    {
                        expected: "session reset policy changed",
                        fileName: "reset-policy-fixture.js",
                        from: '(typeReset ? "daily" : void 0)',
                        name: "reset-present-default",
                        to: '(typeReset ? "none" : void 0)',
                    },
                    {
                        expected: "skill key resolution changed",
                        fileName: "frontmatter-fixture.js",
                        from: "return entry?.metadata?.skillKey ?? skill.name;",
                        name: "skill-key-fallback",
                        to: "return skill.name;",
                    },
                    {
                        expected: "skills.status row changed",
                        fileName: "status-fixture.js",
                        from: "const skillKey = indexed.skillKey;",
                        name: "status-indexed-skill-key",
                        to: "const skillKey = entry.skill.name;",
                    },
                    {
                        expected: "web_fetch enabled default changed",
                        fileName: "runtime-fetch-fixture.js",
                        from: "return true;",
                        name: "web-fetch-omitted-default",
                        to: "return false;",
                    },
                    {
                        expected: "web_search enabled default changed",
                        fileName: "runtime-search-fixture.js",
                        from: "if (params.sandboxed) return true;",
                        name: "web-search-omitted-default",
                        to: "if (params.sandboxed) return false;",
                    },
                    {
                        expected: "skills.update mutation changed",
                        fileName: "skills-fixture.js",
                        from: "if (!trimmedVal) delete nextEnv[trimmedKey];",
                        name: "skill-env-blank-delete",
                        to: "if (!trimmedVal) nextEnv[trimmedKey] = trimmedVal;",
                    },
                    {
                        expected: "skills.update config write changed",
                        fileName: "skills-fixture.js",
                        from: "Object.assign(draft, next);",
                        name: "skill-no-whole-model-normalization",
                        to: "normalizeSubmittedConfigModelRefs(draft);\n                        Object.assign(draft, next);",
                    },
                ] as const;

                for (const driftCase of cases) {
                    const sourceRoot = path.join(temporaryRoot, driftCase.name);
                    await writeSyntheticOpenClawPackage(sourceRoot);
                    const artifactPath = path.join(
                        sourceRoot,
                        "dist",
                        driftCase.fileName
                    );
                    const source = await readFile(artifactPath, "utf8");
                    expect(source).toContain(driftCase.from);
                    await writeFile(
                        artifactPath,
                        source.replace(driftCase.from, driftCase.to),
                        "utf8"
                    );

                    const error = await rejectedError(auditInstalledOpenClaw(sourceRoot));
                    expect(error.message).toContain(driftCase.expected);
                }
            }
        );
    });

    test("rejects expansion of the reviewed skills.update local authority", async () => {
        await withTemporaryDirectory(
            "mira-openclaw-skills-authority-",
            async (sourceRoot) => {
                await writeSyntheticOpenClawPackage(sourceRoot);
                const protocolPath = path.join(sourceRoot, "dist", "src-fixture.js");
                const source = await readFile(protocolPath, "utf8");
                await writeFile(
                    protocolPath,
                    source.replace(
                        "\tskillKey: NonEmptyString,\n\tenabled: Type.Optional(Type.Boolean()),",
                        "\tskillKey: NonEmptyString,\n\tbaseHash: NonEmptyString,\n\tenabled: Type.Optional(Type.Boolean()),"
                    ),
                    "utf8"
                );

                const error = await rejectedError(auditInstalledOpenClaw(sourceRoot));
                expect(error.message).toContain(
                    "skills.update local params fields changed"
                );
            }
        );
    });

    test("rejects drift in skill source and restart acknowledgement facts", async () => {
        await withTemporaryDirectory(
            "mira-openclaw-settings-evidence-",
            async (temporaryRoot) => {
                const cases = [
                    {
                        expected: "skill source taxonomy changed",
                        fileName: "workspace-fixture.js",
                        from: 'source: "openclaw-managed"',
                        name: "source-taxonomy",
                        to: 'source: "openclaw-system"',
                    },
                    {
                        expected: "skill source resolution changed",
                        fileName: "source-fixture.js",
                        from: '|| "unknown"',
                        name: "source-fallback",
                        to: '|| "other"',
                    },
                    {
                        expected: "skill source index changed",
                        fileName: "store-fixture.js",
                        from: 'source === "unknown" && opts?.bundledNames?.has(name) === true',
                        name: "bundled-fallback",
                        to: 'source === "openclaw-managed"',
                    },
                    {
                        expected: "config.patch restart sentinel payload changed",
                        fileName: "config-fixture.js",
                        from: "requiresRestart: params.requiresRestart",
                        name: "restart-sentinel",
                        to: "restartRequired: params.requiresRestart",
                    },
                    {
                        expected: "Gateway restart scheduler success shape changed",
                        fileName: "restart-fixture.js",
                        from: "ok: true",
                        name: "restart-success",
                        to: "ok: false",
                    },
                ] as const;

                for (const driftCase of cases) {
                    const sourceRoot = path.join(temporaryRoot, driftCase.name);
                    await writeSyntheticOpenClawPackage(sourceRoot);
                    const artifactPath = path.join(
                        sourceRoot,
                        "dist",
                        driftCase.fileName
                    );
                    const source = await readFile(artifactPath, "utf8");
                    expect(source).toContain(driftCase.from);
                    await writeFile(
                        artifactPath,
                        source.replace(driftCase.from, driftCase.to),
                        "utf8"
                    );

                    const error = await rejectedError(auditInstalledOpenClaw(sourceRoot));
                    expect(error.message).toContain(driftCase.expected);
                }
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
