import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { readBoundedUtf8RegularFile } from "../../files/boundedFile.ts";
import {
    parseSourceAuditResult,
    type SourceArtifact,
    type SourceAuditResult,
} from "./sourceAuditSchemas.ts";

const maximumPackageMetadataBytes = 512 * 1024;
const maximumBuildInfoBytes = 4 * 1024;
const maximumDistributionArtifactBytes = 2 * 1024 * 1024;

interface LoadedSourceArtifact extends SourceArtifact {
    contents: string;
}

interface DistributionArtifactSpec {
    directory?: "dist" | "dist/control-ui/assets";
    fileNamePattern: RegExp;
    markers: readonly string[];
    role: SourceArtifact["role"];
}

const distributionArtifactSpecs: readonly DistributionArtifactSpec[] = [
    {
        fileNamePattern: /^zod-schema-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "//#region src/config/zod-schema.agents.ts",
            "const AgentEntryConfigSchema = preprocess",
            "const AgentsSchema = object({",
            "entries: record(string().regex(",
        ],
        role: "agent-config-schema",
    },
    {
        fileNamePattern: /^session-visibility-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function createAgentToAgentPolicy(cfg)",
            "function a2aDisabledMessage(action)",
            "function createSessionVisibilityCheckerImpl(params)",
        ],
        role: "agent-to-agent-runtime",
    },
    {
        fileNamePattern: /^zod-schema\.agent-runtime-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const ToolPolicySchema = object({",
            "const AgentToolsSchema = object({",
            "const AgentEntrySchema = object({",
            "const ToolsSchema = object({",
        ],
        role: "agent-tools-schema",
    },
    {
        fileNamePattern: /^automations-tool-name-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            'const AUTOMATIONS_TOOL_NAME = "automations"',
            'const LEGACY_AUTOMATIONS_TOOL_NAMES = ["cron"]',
            "function isAutomationsToolName(name)",
        ],
        role: "automations-tool-name",
    },
    {
        fileNamePattern: /^chat-abort-[A-Za-z0-9_-]+\.js$/u,
        markers: ["const plan = run?.planSnapshot", "const withoutText"],
        role: "chat-run-projection",
    },
    {
        fileNamePattern: /^chat-display-projection-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function hasTranscriptMediaFacts(message)",
            "function toProjectedMessages(messages)",
            "function projectChatDisplayMessagesWithState(messages, options)",
        ],
        role: "chat-display-projection",
    },
    {
        fileNamePattern: /^zod-schema\.channels-config-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const ChannelModelByChannelSchema",
            "function addLegacyChannelAcpBindingIssues",
            "const ChannelsSchema = object({",
        ],
        role: "channel-config-schema",
    },
    {
        fileNamePattern: /^channel-selection-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function isConfiguredChannel(cfg, channelId)",
            "function listConfiguredOfficialExternalRepairHints(cfg)",
            "function resolveAvailableKnownChannel(params)",
        ],
        role: "channel-enabled-default",
    },
    {
        fileNamePattern: /^chat-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function loadChatSendSessionContext",
            "function runChatSendPreAdmission",
            "const clientRunId = p.idempotencyKey",
            'status: "started"',
        ],
        role: "chat-send-handler",
    },
    {
        fileNamePattern: /^managed-image-attachments-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            'const OUTGOING_IMAGE_ROUTE_PREFIX = "/api/chat/media/outgoing"',
            "const MANAGED_OUTGOING_ATTACHMENT_ID_RE",
            "async function handleManagedOutgoingMediaHttpRequest",
            "resolveByteResponse({",
        ],
        role: "managed-outgoing-media",
    },
    {
        fileNamePattern: /^media-facts-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function readPersistedMediaFacts(message)",
            "function canonicalizePersistedUserMessageMedia(message)",
            "function resolveMediaFactsWithPrecedence(source, legacyProjectionWins)",
        ],
        role: "media-facts",
    },
    {
        fileNamePattern: /^payloads-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const MEDIA_TOKEN_RE =",
            "function isValidMedia(candidate, opts)",
            "function splitMediaFromOutput(raw, options = {})",
        ],
        role: "media-output-directives",
    },
    {
        fileNamePattern: /^store-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            'const resolveMediaDir = () => path.join(resolveConfigDir(), "media")',
            "function resolveMediaScopedDir(subdir, caller)",
            "function openMediaStore(maxBytes = MAX_BYTES, rootDir = resolveMediaDir())",
        ],
        role: "media-store-root",
    },
    {
        fileNamePattern: /^models-[A-Za-z0-9_-]+\.js$/u,
        markers: ["const modelsHandlers", '"models.list"', "buildModelsListResult"],
        role: "models-handlers",
    },
    {
        fileNamePattern: /^model-input-normalization-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function normalizeAgentScopes(agents)",
            "function normalizeProviderCatalogs(models, modelIdNormalizationPolicies)",
            "function normalizeSubmittedConfigModelRefs(cfg, modelIdNormalizationPolicies)",
        ],
        role: "model-input-normalization",
    },
    {
        fileNamePattern: /^model-input-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const GOOGLE_PROVIDER_IDS",
            "function normalizeAgentModelRefForConfig(model)",
            "function normalizeAgentModelMapForConfig(models)",
        ],
        role: "model-ref-normalization",
    },
    {
        fileNamePattern: /^server-chat-[A-Za-z0-9_-]+\.js$/u,
        markers: ["flushBufferedChatDeltaIfNeeded", "run.deltaSentAt"],
        role: "chat-streaming",
    },
    {
        fileNamePattern: /^base-hash-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function resolveBaseHashParam(params)",
            "const raw = params?.baseHash",
            "return trimmed ? trimmed : null",
        ],
        role: "config-base-hash",
    },
    {
        fileNamePattern: /^config-get-response-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function createConfigGetResponse(snapshot, uiHints)",
            "configRevisionHash: hashRuntimeConfigValue(snapshot.sourceConfig)",
            "appliedConfigHash: getRuntimeConfigAppliedHash()",
        ],
        role: "config-get-response",
    },
    {
        fileNamePattern: /^io-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function createConfigFileSnapshot(params)",
            "async function readConfigFileSnapshotInternal(context, options = {})",
            "async function writeConfigFileFromContext(context, cfg, options, readSnapshot)",
        ],
        role: "config-io",
    },
    {
        fileNamePattern: /^config-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            'const HASHLESS_PATCH_LWW_PATH_PREFIXES = ["ui.prefs"]',
            "const configHandlers = {",
            '"config.get": async',
            '"config.patch": async',
        ],
        role: "config-handlers",
    },
    {
        fileNamePattern: /^merge-patch-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function mergeObjectArraysById(base, patch, options, arrayPath)",
            "function applyMergePatch(base, patch, options = {})",
            "function isMergePatchObjectKeyAllowed(key, parentPath)",
        ],
        role: "config-merge-patch",
    },
    {
        fileNamePattern: /^mutate-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "async function tryWriteSingleTopLevelIncludeMutation(params)",
            "async function replaceConfigFileUnlocked(params)",
            "async function mutateConfigFileWithRetry(params)",
        ],
        role: "config-mutation",
    },
    {
        fileNamePattern: /^redact-snapshot-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            'const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__"',
            "function redactConfigSnapshot(snapshot, uiHints)",
            "function restoreRedactedValues(incoming, original, hints)",
        ],
        role: "config-redaction",
    },
    {
        directory: "dist/control-ui/assets",
        fileNamePattern: /^chat-page-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "sessions.companion.ask",
            "tasks.list",
            "tasks.get",
            "tasks.cancel",
            "runtime!==`subagent`",
            "ob=200,sb=100",
        ],
        role: "control-ui-chat",
    },
    {
        directory: "dist/control-ui/assets",
        fileNamePattern: /^chat-message-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "stream===`plan`",
            "phase===`update`",
            "plan-checklist__body",
            "plan-checklist__count",
        ],
        role: "control-ui-plan-renderer",
    },
    {
        directory: "dist/control-ui/assets",
        fileNamePattern: /^chat-session-rail-[A-Za-z0-9_-]+\.js$/u,
        markers: ["planStatus", "steps.slice(-3)", "openclaw-chat-session-rail"],
        role: "control-ui-plan-rail",
    },
    {
        fileNamePattern: /^tool-catalog-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const CORE_TOOL_DEFINITIONS = [",
            "const CORE_TOOL_BY_ID = new Map",
            "function isKnownCoreToolId(toolId)",
        ],
        role: "core-tool-catalog",
    },
    {
        fileNamePattern: /^server-cron-[A-Za-z0-9_-]+\.js$/u,
        markers: ['params.broadcast("cron"', "onEvent: (evt) =>", "dropIfSlow: true"],
        role: "cron-events",
    },
    {
        fileNamePattern: /^cron-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const cronHandlers",
            "function compactCronListJob",
            '"cron.get"',
            '"cron.runs"',
        ],
        role: "cron-handlers",
    },
    {
        fileNamePattern: /^get-reply-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function resolveElevatedPermissions(params)",
            "function resolveElevatedAllowList(allowFrom, provider, fallbackAllowFrom)",
            "function isApprovedElevatedSender(params)",
        ],
        role: "elevated-tool-runtime",
    },
    {
        fileNamePattern: /^exec-defaults-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function resolveExecConfigState(params)",
            "function resolveNodeExecEligibility(params)",
            "function resolveExecDefaults(params)",
        ],
        role: "exec-defaults-runtime",
    },
    {
        fileNamePattern: /^exec-approvals-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function resolveExecModeFromPolicy(params)",
            "function resolveExecPolicyForMode(mode)",
            "function resolveExecModePolicy(params)",
        ],
        role: "exec-mode-policy",
    },
    {
        fileNamePattern: /^jobs-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function mergeCronDelivery",
            "function applyJobPatch",
            "function assertDeliverySupport",
        ],
        role: "cron-delivery-merge",
    },
    {
        fileNamePattern: /^normalize-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function coerceDelivery",
            "function coerceFailureDestination",
            "function normalizeCronJobPatch",
        ],
        role: "cron-delivery-normalization",
    },
    {
        fileNamePattern: /^list-snapshot-revision-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function readCronTaskRunHistoryPage",
            "function resolveCronListSnapshotRevision",
        ],
        role: "cron-run-history",
    },
    {
        fileNamePattern: /^service-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "async function listPage(state, opts)",
            "async function enqueueRun(state, id, mode)",
            "enqueued: true",
        ],
        role: "cron-service",
    },
    {
        fileNamePattern: /^system-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "async function collectSystemInfo(context)",
            "processInstanceId: getGatewayProcessInstanceId()",
            '"system.info": async',
            "validateSystemInfoParams",
        ],
        role: "system-info-handler",
    },
    {
        fileNamePattern: /^server-methods-list-[A-Za-z0-9_-]+\.js$/u,
        markers: ["const GATEWAY_EVENTS", "connect.challenge"],
        role: "gateway-events",
    },
    {
        fileNamePattern: /^server\.impl-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function createGatewayBroadcaster(params)",
            "const clientSeq",
            "const nextSeq = (clientSeq.get(c) ?? 0) + 1",
            "if (slow && opts?.dropIfSlow)",
            "const eventSeq = isTargeted ? void 0 : nextSeq",
        ],
        role: "gateway-broadcaster",
    },
    {
        fileNamePattern: /^client-info-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const GATEWAY_CLIENT_CAPS",
            'SESSION_SCOPED_EVENTS: "session-scoped-events"',
        ],
        role: "gateway-client-caps",
    },
    {
        fileNamePattern: /^error-codes-[A-Za-z0-9_-]+\.js$/u,
        markers: ["GatewayClientModeSchema", "GATEWAY_CLIENT_MODES"],
        role: "gateway-client-modes",
    },
    {
        fileNamePattern: /^message-handler-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "async function admitGatewayConnect(context)",
            "const isBrowserCopilot = isBrowserCopilotClient(connectParams.client)",
            "GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS",
        ],
        role: "gateway-connect-handler",
    },
    {
        fileNamePattern: /^server-constants-[A-Za-z0-9_-]+\.js$/u,
        markers: ["MAX_PAYLOAD_BYTES", "MAX_PREAUTH_PAYLOAD_BYTES"],
        role: "gateway-limits",
    },
    {
        fileNamePattern: /^server-methods-[A-Za-z0-9_-]+\.js$/u,
        markers: ["src/gateway/server-methods.ts", "const coreGatewayHandlers"],
        role: "gateway-methods",
    },
    {
        fileNamePattern: /^server-ws-runtime-[A-Za-z0-9_-]+\.js$/u,
        markers: ["connect.challenge", "MAX_PREAUTH_PAYLOAD_BYTES"],
        role: "gateway-websocket",
    },
    {
        fileNamePattern: /^restart-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function scheduleGatewaySigusr1Restart(opts)",
            'signal: "SIGUSR1"',
            "cooldownMsApplied,",
            "emitHooksQueued",
        ],
        role: "gateway-restart-scheduler",
    },
    {
        fileNamePattern: /^core-descriptors-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            'name: "tasks.list"',
            'name: "sessions.companion.ask"',
            "controlPlaneWrite: true",
        ],
        role: "method-descriptors",
    },
    {
        fileNamePattern: /^method-scopes-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "SESSIONS_DELETE_WRITE_SCOPE_FIELDS",
            "resolveSessionsDeleteRequiredScopes",
            "Internal controls (emitLifecycleHooks, expected* CAS guards) stay admin-only",
        ],
        role: "method-scopes",
    },
    {
        fileNamePattern: /^openclaw-tools-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const PLAN_STEP_STATUSES",
            "plan can contain at most one in_progress step",
            'name: "update_plan"',
        ],
        role: "plan-tool",
    },
    {
        fileNamePattern: /^index-[A-Za-z0-9_-]+\.d\.ts$/u,
        markers: ["declare const PROTOCOL_VERSION: 4", "ChatEventSchema"],
        role: "protocol-declarations",
    },
    {
        fileNamePattern: /^src-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const TaskLedgerStatusSchema",
            "const SessionsCompanionAskParamsSchema",
        ],
        role: "protocol-schemas",
    },
    {
        fileNamePattern: /^provider-model-id-normalize-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function normalizeGooglePreviewModelId(id)",
            "function normalizeTogetherModelId(id)",
            "function normalizeAntigravityPreviewModelId(id)",
        ],
        role: "provider-model-id-normalization",
    },
    {
        fileNamePattern: /^version-[A-Za-z0-9_-]+\.js$/u,
        markers: ["packages/gateway-protocol/src/version.ts", "PROTOCOL_VERSION"],
        role: "protocol-version",
    },
    {
        fileNamePattern: /^server-runtime-subscriptions-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "SESSION_COMPANION_IDLE_TTL_MS",
            'params.broadcast("task"',
            'action: "restored"',
        ],
        role: "runtime-subscriptions",
    },
    {
        fileNamePattern: /^session-accessor\.sqlite-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function collectSqliteSessionMaintenanceBaseKeys(store, activeSessionKey)",
            "function applySqliteSessionEntryMaintenance(database, params)",
            "async function applySqliteSessionEntryLifecycleMutation(params)",
        ],
        role: "session-accessor-sqlite-maintenance",
    },
    {
        fileNamePattern: /^cleanup-service-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function serializeSessionCleanupResult(params)",
            "async function previewStoreCleanup(params)",
            "async function runSessionsCleanup(params)",
        ],
        role: "session-cleanup-service",
    },
    {
        fileNamePattern: /^session-companion-rpc-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            '"sessions.companion.ask"',
            "SESSION_COMPANION_BUSY",
            '"sessions.companion.reset"',
        ],
        role: "session-companion-rpc",
    },
    {
        fileNamePattern: /^session-companion-ask-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "SESSION_COMPANION_TOOLS",
            "MAX_CONCURRENT_ASKS",
            "The session companion is answering another question.",
        ],
        role: "session-companion-runtime",
    },
    {
        fileNamePattern: /^session-change-event-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function emitSessionsChanged",
            'context.broadcastToConnIds("sessions.changed"',
            "dropIfSlow: true",
        ],
        role: "session-change-event",
    },
    {
        fileNamePattern:
            /^session-accessor\.sqlite-transcript-store-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function appendTranscriptEventInTransaction(database, scope, event, options = {})",
            "function canonicalizeTranscriptEventMedia(event)",
            "const persistedEvent = canonicalizeTranscriptEventMedia(event)",
        ],
        role: "transcript-media-persistence",
    },
    {
        fileNamePattern: /^reset-policy-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            'const DEFAULT_RESET_MODE = "none"',
            "const DEFAULT_RESET_AT_HOUR = 4",
            "function resolveSessionResetPolicy(params)",
        ],
        role: "session-reset-policy",
    },
    {
        fileNamePattern: /^session-event-payload-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function buildGatewaySessionEventFields",
            "updatedAt: sessionRow.updatedAt",
            "sessionId: sessionRow.sessionId",
        ],
        role: "session-event-payload",
    },
    {
        fileNamePattern: /^lifecycle-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "SESSION_LIFECYCLE_CHANGED_ERROR_REASON",
            '"session-changed"',
            "resolveSessionWorkStartError",
        ],
        role: "session-lifecycle",
    },
    {
        fileNamePattern: /^session-utils-list-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function buildSessionsListResult",
            "limitApplied: list.limitApplied",
            "totalCount: list.totalCount",
        ],
        role: "session-list-projection",
    },
    {
        fileNamePattern: /^session-entry-slot-keys-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function collectSessionMaintenancePreserveKeysForStore(params)",
            "function shouldPreserveMaintenanceEntry(params)",
            "function resolveMaintenanceConfig()",
        ],
        role: "session-maintenance-policy",
    },
    {
        fileNamePattern: /^session-reset-service-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "async function performGatewaySessionReset",
            "const nextSessionId = currentEntry?.sessionId ?? randomUUID()",
            "lifecycleRevision: randomUUID()",
        ],
        role: "session-reset-service",
    },
    {
        fileNamePattern: /^sessions-shared-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function emitSessionOperation",
            'context.broadcastToConnIds("session.operation"',
            "dropIfSlow: true",
        ],
        role: "session-operation-event",
    },
    {
        fileNamePattern: /^session-utils-row-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function buildGatewaySessionRow",
            "resolveGatewaySessionThinkingProjectionInternal",
            "effectiveFastMode: fastModeState.mode",
            "contextTokens,",
        ],
        role: "session-row-projection",
    },
    {
        fileNamePattern: /^server-session-events-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "params.sessionEventSubscribers.getAll()",
            'params.broadcastToConnIds("session.message"',
            'params.broadcastToConnIds("sessions.changed"',
        ],
        role: "session-subscription-events",
    },
    {
        fileNamePattern: /^sessions-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const sessionCompactHandlers",
            "const sessionDeleteHandlers",
            '"sessions.reset": async',
            '"sessions.list": async',
        ],
        role: "sessions-handlers",
    },
    {
        fileNamePattern: /^skills-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "async function updateSkillConfigEntry(params)",
            "const skillsHandlers = {",
            '"skills.status":',
            '"skills.update": async',
        ],
        role: "skills-handlers",
    },
    {
        fileNamePattern: /^frontmatter-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function resolveOpenClawMetadata(frontmatter)",
            "function resolveSkillInvocationPolicy(frontmatter)",
            "function resolveSkillKey(skill, entry)",
        ],
        role: "skill-key-resolution",
    },
    {
        fileNamePattern: /^workspace-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function loadSkillEntries(workspaceDir, opts)",
            'source: "openclaw-bundled"',
            'source: "openclaw-node"',
            'source: "openclaw-workspace"',
        ],
        role: "skills-discovery",
    },
    {
        fileNamePattern: /^store-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function buildSkillIndexEntries(entries, opts)",
            "function createSkillIndexEntry(entry, opts, agentSkillSet)",
            "const source = resolveSkillSource(entry.skill)",
        ],
        role: "skills-index",
    },
    {
        fileNamePattern: /^source-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function resolveSkillSource(skill)",
            "function resolveSkillTelemetrySourceValue(value)",
            "function resolveSkillTelemetrySource(skill)",
        ],
        role: "skills-source-resolution",
    },
    {
        fileNamePattern: /^status-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function buildSkillStatus(indexed, context)",
            "function buildWorkspaceSkillStatus(workspaceDir, opts)",
            "filePath: entry.skill.filePath",
            "baseDir: entry.skill.baseDir",
        ],
        role: "skills-status",
    },
    {
        fileNamePattern: /^subagent-control-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "Admin kill path for a subagent session key, bypassing caller ownership checks.",
            "cascadeKillChildren",
            "cascadeKilled",
        ],
        role: "subagent-control",
    },
    {
        fileNamePattern: /^update-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const updateHandlers = {",
            '"update.run": async',
            "startManagedServiceUpdateHandoff",
            "buildUpdateRestartSentinelPayload",
        ],
        role: "update-handlers",
    },
    {
        fileNamePattern: /^update-startup-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const HANDOFF_READY_MARKER",
            "function formatManagedServiceUpdateCommand(params)",
            "async function startManagedServiceUpdateHandoff(params)",
        ],
        role: "update-managed-handoff",
    },
    {
        fileNamePattern: /^update-runner-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const MAX_LOG_CHARS = 8e3",
            "async function runStep(opts)",
            "async function runGatewayUpdate(opts = {})",
        ],
        role: "update-runner",
    },
    {
        fileNamePattern: /^update-control-plane-sentinel-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function buildUpdateRestartSentinelPayload(params)",
            "CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON",
            "function isPendingControlPlaneUpdateRestartSentinel(payload)",
        ],
        role: "update-sentinel",
    },
    {
        fileNamePattern: /^task-registry-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "Task is already terminal.",
            "Subagent completed while cancellation was in progress.",
            "killSubagentRunAdmin",
        ],
        role: "task-registry",
    },
    {
        fileNamePattern: /^task-summary-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const TASK_PROMPT_MAX_CHARS = 4e3",
            "sanitizeTaskPromptText(task.task, TASK_PROMPT_MAX_CHARS)",
        ],
        role: "task-summary",
    },
    {
        fileNamePattern: /^tasks-[A-Za-z0-9_-]+\.js$/u,
        markers: ["LEDGER_STATUS_TO_TASK_STATUSES", '"tasks.list"', '"tasks.cancel"'],
        role: "tasks-handlers",
    },
    {
        fileNamePattern: /^tool-policy-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "const TOOL_NAME_ALIASES = {",
            'bash: "exec"',
            'cron: "automations"',
            "function normalizeToolName(name)",
            "function normalizeToolList(list)",
        ],
        role: "tool-policy-normalization",
    },
    {
        fileNamePattern: /^runtime-(?!api-)[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function resolveWebFetchEnabled(params)",
            "function resolveWebFetchProviderId(params)",
            "function resolveWebFetchDefinition(options)",
        ],
        role: "web-fetch-runtime",
    },
    {
        fileNamePattern: /^runtime-(?!api-)[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "function resolveWebSearchEnabled(params)",
            "function resolveWebSearchProviderId(params)",
            "function resolveWebSearchCandidates(options)",
        ],
        role: "web-search-runtime",
    },
];

const packageMetadataSchema = v.object({
    name: v.literal("openclaw"),
    version: v.string(),
});
const buildInfoSchema = v.strictObject({
    builtAt: v.string(),
    commit: v.string(),
    version: v.string(),
});

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function sortedUnique(values: readonly string[]): string[] {
    return [...new Set(values)].toSorted(compareStrings);
}

function sha256(contents: Uint8Array): string {
    return createHash("sha256").update(contents).digest("hex");
}

function assertContainedPath(root: string, target: string): void {
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error("OpenClaw source artifact escaped the selected package root");
    }
}

async function loadSourceArtifact(
    sourceRoot: string,
    relativePath: string,
    role: SourceArtifact["role"],
    maximumBytes: number
): Promise<LoadedSourceArtifact> {
    const requestedPath = path.resolve(sourceRoot, relativePath);
    assertContainedPath(sourceRoot, requestedPath);
    const artifact = await readBoundedUtf8RegularFile(
        requestedPath,
        sourceRoot,
        maximumBytes,
        `OpenClaw ${role} artifact has invalid file state`,
        `OpenClaw ${role} artifact is not valid UTF-8`
    );
    return {
        bytes: artifact.bytes.byteLength,
        contents: artifact.text,
        path: relativePath,
        role,
        sha256: sha256(artifact.bytes),
    };
}

async function locateDistributionArtifact(
    sourceRoot: string,
    spec: DistributionArtifactSpec
): Promise<LoadedSourceArtifact> {
    const directory = spec.directory ?? "dist";
    const entries = await readdir(path.join(sourceRoot, directory), {
        withFileTypes: true,
    });
    const fileNames = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .toSorted(compareStrings);
    const matches: LoadedSourceArtifact[] = [];
    for (const fileName of fileNames) {
        if (!spec.fileNamePattern.test(fileName)) continue;
        const candidate = await loadSourceArtifact(
            sourceRoot,
            `${directory}/${fileName}`,
            spec.role,
            maximumDistributionArtifactBytes
        );
        if (spec.markers.every((marker) => candidate.contents.includes(marker))) {
            matches.push(candidate);
        }
    }
    if (matches.length !== 1) {
        throw new Error(
            `Expected one OpenClaw ${spec.role} artifact, found ${matches.length}`
        );
    }
    return matches[0]!;
}

function artifactByRole(
    artifacts: readonly LoadedSourceArtifact[],
    role: SourceArtifact["role"]
): LoadedSourceArtifact {
    const artifact = artifacts.find((candidate) => candidate.role === role);
    if (!artifact) throw new Error(`Missing OpenClaw ${role} artifact`);
    return artifact;
}

const reviewedIntegerConstantNames = [
    "MAX_BUFFERED_BYTES",
    "MAX_PAYLOAD_BYTES",
    "MAX_PREAUTH_PAYLOAD_BYTES",
    "MIN_CLIENT_PROTOCOL_VERSION",
    "MIN_NODE_PROTOCOL_VERSION",
    "MIN_PROBE_PROTOCOL_VERSION",
    "PROTOCOL_VERSION",
    "TASK_PROMPT_MAX_CHARS",
] as const;

type ReviewedIntegerConstantName = (typeof reviewedIntegerConstantNames)[number];

function parseIntegerConstant(source: string, name: ReviewedIntegerConstantName): number {
    const prefix = `const ${name} = `;
    const expressions = source
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.startsWith(prefix) && line.endsWith(";"))
        .map((line) => line.slice(prefix.length, -1));
    if (expressions.length !== 1) {
        throw new Error(`OpenClaw source must define ${name} exactly once`);
    }
    const factors = expressions[0]!
        .trim()
        .split("*")
        .map((factor) => factor.trim());
    if (
        factors.length === 0 ||
        factors.some((factor) => !/^\d+(?:e\d+)?$/u.test(factor))
    ) {
        throw new Error(`OpenClaw ${name} is not a reviewed integer product`);
    }
    const result = factors.reduce((product, factor) => product * Number(factor), 1);
    if (!Number.isSafeInteger(result) || result <= 0) {
        throw new Error(`OpenClaw ${name} is outside the reviewed integer range`);
    }
    return result;
}

function extractMethodNames(source: string): {
    agents: string[];
    chat: string[];
    cron: string[];
    sessions: string[];
    tasks: string[];
} {
    const dottedNames = [
        ...source.matchAll(/"([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)"/gu),
    ].map((match) => match[1]!);
    if (!source.includes('methods: ["agent", "agent.wait"]')) {
        throw new Error("OpenClaw source is missing the reviewed agent method group");
    }
    if (!/methods: \[\s*"wake",\s*"cron\.list"/u.test(source)) {
        throw new Error("OpenClaw source is missing the reviewed cron wake method group");
    }
    return {
        agents: sortedUnique([
            "agent",
            ...dottedNames.filter(
                (name) => name.startsWith("agent.") || name.startsWith("agents.")
            ),
        ]),
        chat: sortedUnique(dottedNames.filter((name) => name.startsWith("chat."))),
        cron: sortedUnique([
            "wake",
            ...dottedNames.filter((name) => name.startsWith("cron.")),
        ]),
        sessions: sortedUnique(
            dottedNames.filter(
                (name) => name.startsWith("session.") || name.startsWith("sessions.")
            )
        ),
        tasks: sortedUnique(dottedNames.filter((name) => name.startsWith("tasks."))),
    };
}

function assertRequiredMarkers(
    source: string,
    surface: string,
    markers: readonly string[]
): void {
    for (const marker of markers) {
        if (!source.includes(marker)) {
            throw new Error(
                `OpenClaw ${surface} changed outside the reviewed source-backed shape`
            );
        }
    }
}

function assertForbiddenMarkers(
    source: string,
    surface: string,
    markers: readonly string[]
): void {
    for (const marker of markers) {
        if (source.includes(marker)) {
            throw new Error(
                `OpenClaw ${surface} changed outside the reviewed source-backed shape`
            );
        }
    }
}

function assertMethodPermission(
    source: string,
    method: string,
    scope: "operator.admin" | "operator.read" | "operator.write",
    controlPlaneWrite: boolean
): void {
    assertMethodDescriptorScope(source, method, scope);
    const start = source.indexOf(`name: "${method}"`);
    const end = source.indexOf("},", start);
    const descriptor = source.slice(start, end);
    const isControlPlaneWrite = /controlPlaneWrite: true/u.test(descriptor);
    if (isControlPlaneWrite !== controlPlaneWrite) {
        throw new Error(`OpenClaw permission descriptor changed for ${method}`);
    }
}

function assertMethodDescriptorScope(
    source: string,
    method: string,
    scope: "dynamic" | "operator.admin" | "operator.read" | "operator.write"
): void {
    const start = source.indexOf(`name: "${method}"`);
    if (start === -1)
        throw new Error(`OpenClaw method descriptors are missing ${method}`);
    const end = source.indexOf("},", start);
    if (end === -1 || end - start > 240) {
        throw new Error(`OpenClaw method descriptor is unbounded for ${method}`);
    }
    const descriptor = source.slice(start, end);
    if (!descriptor.includes(`scope: "${scope}"`)) {
        throw new Error(`OpenClaw permission descriptor changed for ${method}`);
    }
}

function assertPlanCompanionAndTasks(artifacts: readonly LoadedSourceArtifact[]): number {
    const planTool = artifactByRole(artifacts, "plan-tool").contents;
    assertRequiredMarkers(planTool, "plan producer", [
        '"pending"',
        '"in_progress"',
        '"completed"',
        "minItems: 1",
        'status === "in_progress"',
        "plan can contain at most one in_progress step",
        'name: "update_plan"',
        'status: "updated"',
    ]);
    assertRequiredMarkers(
        artifactByRole(artifacts, "chat-streaming").contents,
        "plan Gateway projection",
        ['evt.stream === "plan" && evt.data?.phase === "update"', "planSnapshot ="]
    );
    assertRequiredMarkers(
        artifactByRole(artifacts, "chat-run-projection").contents,
        "plan history recovery",
        ["const plan = run?.planSnapshot", "params.snapshot.plan", "steps: []"]
    );
    assertRequiredMarkers(
        artifactByRole(artifacts, "control-ui-plan-renderer").contents,
        "plan UI projection",
        [
            "stream===`plan`",
            "phase===`update`",
            "a===`in_progress`&&n?`pending`:a",
            "plan-checklist__body",
            "plan-checklist__count",
            "e.planStatus=null",
        ]
    );
    assertRequiredMarkers(
        artifactByRole(artifacts, "control-ui-plan-rail").contents,
        "plan session rail",
        ["steps.slice(-3)", "planStatus", "planProgress"]
    );

    const protocolSchemas = artifactByRole(artifacts, "protocol-schemas").contents;
    assertRequiredMarkers(protocolSchemas, "companion protocol", [
        "const SessionsCompanionAskParamsSchema",
        "maxLength: 400",
        "maxLength: 1200",
        "maxItems: 24",
        "Companion answer returned only to the requesting operator.",
    ]);
    assertRequiredMarkers(protocolSchemas, "task protocol", [
        "const TaskLedgerStatusSchema",
        'Type.Literal("queued")',
        'Type.Literal("running")',
        'Type.Literal("completed")',
        'Type.Literal("failed")',
        'Type.Literal("cancelled")',
        'Type.Literal("timed_out")',
        "maxItems: 24",
        "maximum: 500",
        "Returned by tasks.get; omitted from list/event summaries.",
    ]);

    const companionRuntime = artifactByRole(
        artifacts,
        "session-companion-runtime"
    ).contents;
    assertRequiredMarkers(companionRuntime, "companion runtime", [
        '"read"',
        '"sessions_history"',
        '"sessions_search"',
        'visibility: "self"',
        "workspaceOnly: true",
        "enabled: false",
        "SESSION_COMPANION_MAX_EXCHANGES = 24",
        "SESSION_COMPANION_MAX_EXCHANGE_BYTES = 48 * 1024",
        "ASK_TIMEOUT_MS = 6e4",
        "ANSWER_MAX_CHARS = 1200",
        "SEED_MAX_BYTES = 24 * 1024",
        "SEED_MESSAGE_MAX_CHARS = 4e3",
        "MAX_CONCURRENT_ASKS = 6",
        "MAX_ASKS_PER_RATE_WINDOW = 12",
        "MAX_ASKS_PER_CONNECTION_RATE_WINDOW = 4",
        ".slice(-40)",
        "disableMessageTool: true",
    ]);
    assertRequiredMarkers(
        artifactByRole(artifacts, "runtime-subscriptions").contents,
        "companion and task lifecycle",
        [
            "SESSION_COMPANION_IDLE_TTL_MS = 120 * 6e4",
            "SESSION_COMPANION_SWEEP_INTERVAL_MS = 10 * 6e4",
            'payload = { action: "restored" }',
            'params.broadcast("task", payload, { dropIfSlow: true })',
        ]
    );
    assertRequiredMarkers(
        artifactByRole(artifacts, "session-companion-rpc").contents,
        "companion RPC",
        [
            '"sessions.companion.ask"',
            '"sessions.companion.state"',
            '"sessions.companion.reset"',
            "SESSION_COMPANION_BUSY",
            "retryable: true",
        ]
    );

    const descriptors = artifactByRole(artifacts, "method-descriptors").contents;
    assertMethodPermission(descriptors, "sessions.companion.ask", "operator.read", false);
    assertMethodPermission(
        descriptors,
        "sessions.companion.state",
        "operator.read",
        false
    );
    assertMethodPermission(
        descriptors,
        "sessions.companion.reset",
        "operator.write",
        true
    );
    assertMethodPermission(descriptors, "tasks.list", "operator.read", false);
    assertMethodPermission(descriptors, "tasks.get", "operator.read", false);
    assertMethodPermission(descriptors, "tasks.cancel", "operator.write", false);

    assertRequiredMarkers(
        artifactByRole(artifacts, "tasks-handlers").contents,
        "task handlers",
        [
            "DEFAULT_TASKS_LIST_LIMIT = 100",
            "MAX_TASKS_LIST_LIMIT = 500",
            'failed: ["failed", "lost"]',
            "parseCursor",
            "mapTaskSummary(task, { includePrompt: true })",
            "respond(true, {",
        ]
    );
    const taskSummary = artifactByRole(artifacts, "task-summary").contents;
    assertRequiredMarkers(taskSummary, "task prompt projection", [
        "const TASK_PROMPT_MAX_CHARS = 4e3",
        "sanitizeTaskPromptText(task.task, TASK_PROMPT_MAX_CHARS)",
    ]);
    assertRequiredMarkers(
        artifactByRole(artifacts, "task-registry").contents,
        "task cancellation",
        [
            "Task is already terminal.",
            "killSubagentRunAdmin",
            "Subagent completed while cancellation was in progress.",
        ]
    );
    assertRequiredMarkers(
        artifactByRole(artifacts, "subagent-control").contents,
        "subagent task cancellation",
        [
            "Admin kill path for a subagent session key, bypassing caller ownership checks.",
            "cascadeKillChildren",
            "cascadeKilled: cascade.killed",
        ]
    );
    assertRequiredMarkers(
        artifactByRole(artifacts, "control-ui-chat").contents,
        "task and companion UI projection",
        [
            "ob=200,sb=100",
            "runtime!==`subagent`",
            "SESSION_COMPANION_BUSY",
            "slice(-24)",
            "tasks.cancel",
        ]
    );
    return parseIntegerConstant(taskSummary, "TASK_PROMPT_MAX_CHARS");
}

function boundedSourceRegion(
    source: string,
    startMarker: string,
    endMarker: string,
    maximumChars: number,
    surface: string
): string {
    const start = source.indexOf(startMarker);
    const duplicateStart = source.indexOf(startMarker, start + startMarker.length);
    const end = source.indexOf(endMarker, start + startMarker.length);
    if (
        start === -1 ||
        duplicateStart !== -1 ||
        end === -1 ||
        end <= start ||
        end - start > maximumChars
    ) {
        throw new Error(`OpenClaw ${surface} changed outside the reviewed bounded shape`);
    }
    return source.slice(start, end);
}

function indentedFieldNames(region: string, indentation: number): string[] {
    const tabs = String.raw`\t`.repeat(indentation);
    const expression = new RegExp(`^[ ]*${tabs}([A-Za-z_$][A-Za-z0-9_$]*):`, "gmu");
    return sortedUnique([...region.matchAll(expression)].map((match) => match[1]!));
}

function assertExactIndentedFields(
    region: string,
    indentation: number,
    expected: readonly string[],
    surface: string
): void {
    const actual = indentedFieldNames(region, indentation);
    const normalizedExpected = sortedUnique(expected);
    if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) {
        throw new Error(`OpenClaw ${surface} fields changed outside the reviewed shape`);
    }
}

function assertIncludesIndentedFields(
    region: string,
    indentation: number,
    expected: readonly string[],
    surface: string
): void {
    const actual = new Set(indentedFieldNames(region, indentation));
    if (expected.some((field) => !actual.has(field))) {
        throw new Error(`OpenClaw ${surface} fields changed outside the reviewed shape`);
    }
}

function assertTaskNotificationChatSendSemantics(
    artifacts: readonly LoadedSourceArtifact[]
): SourceAuditResult["chat"]["taskNotificationSend"] {
    assertMethodPermission(
        artifactByRole(artifacts, "method-descriptors").contents,
        "chat.send",
        "operator.write",
        false
    );
    const protocol = artifactByRole(artifacts, "protocol-schemas").contents;
    const sendParams = boundedSourceRegion(
        protocol,
        "const ChatSendParamsSchema = closedObject({",
        "/** Cancels the active or named run for a chat session. */",
        8 * 1024,
        "chat.send params"
    );
    assertRequiredMarkers(sendParams, "task notification chat.send params", [
        "sessionKey: ChatSendSessionKeyString",
        "message: Type.String()",
        "idempotencyKey: NonEmptyString",
    ]);

    const handler = artifactByRole(artifacts, "chat-send-handler").contents;
    const sessionContext = boundedSourceRegion(
        handler,
        "function loadChatSendSessionContext(params) {",
        "/** Load and validate the session/model facts shared by later admission and dispatch phases. */",
        8 * 1024,
        "chat.send session context"
    );
    assertRequiredMarkers(sessionContext, "task notification idempotency", [
        "const clientRunId = p.idempotencyKey",
    ]);
    const preAdmission = boundedSourceRegion(
        handler,
        "async function runChatSendPreAdmission(params) {",
        "//#region src/gateway/server-methods/chat-send-admission.ts",
        24 * 1024,
        "chat.send retry acknowledgement"
    );
    assertRequiredMarkers(preAdmission, "task notification retry acknowledgement", [
        "const cached = context.dedupe.get(`chat:${clientRunId}`)",
        "pendingChatSendKey",
        'status: "in_flight"',
        'durableClaim.kind === "accepted"',
        'status: "ok"',
    ]);
    assertRequiredMarkers(handler, "task notification initial acknowledgement", [
        "const ackPayload = {",
        "runId: clientRunId",
        'status: "started"',
        "respond(true, ackPayload",
    ]);

    return {
        acknowledgedStatuses: ["in_flight", "ok", "started"],
        idempotencyKeyIsRunId: true,
        requiredParams: ["idempotencyKey", "message", "sessionKey"],
    };
}

function assertLocalHistoryMediaSemantics(
    artifacts: readonly LoadedSourceArtifact[]
): SourceAuditResult["chat"]["adapter"]["media"]["localHistory"] {
    const mediaFacts = artifactByRole(artifacts, "media-facts").contents;
    const persistedReader = boundedSourceRegion(
        mediaFacts,
        "function readPersistedMediaFacts(message)",
        "const LEGACY_MEDIA_CONTEXT_KEYS =",
        2 * 1024,
        "persisted media reader"
    );
    assertRequiredMarkers(persistedReader, "persisted canonical media envelope", [
        'const metadata = message["__openclaw"]',
        "metadata.media",
        "return Array.isArray(media) ? media : void 0",
    ]);

    const normalizedFact = boundedSourceRegion(
        mediaFacts,
        "function normalizeMediaFact(media, index, defaults = {})",
        "/** True when every path-bearing canonical fact has explicit staging proof. */",
        4 * 1024,
        "canonical media fact"
    );
    assertRequiredMarkers(normalizedFact, "canonical media fact fields", [
        "path: normalizeOptionalString(media.path)",
        "url: normalizeOptionalString(media.url)",
        "contentType,",
        "kind: media.kind ?? defaults.kind ?? kindFromMime(contentType)",
        "fileName: normalizeOptionalString(media.fileName)",
        "sizeBytes: normalizeNonNegativeNumber(media.sizeBytes)",
        "durationMs",
        "width",
        "height",
        "transcribed:",
        "messageId:",
        "workspaceDir",
        "staged:",
        "hydrationSuppressed:",
    ]);

    const canonicalization = boundedSourceRegion(
        mediaFacts,
        "function canonicalizePersistedUserMessageMedia(message)",
        "function stripLegacyMediaContextFields(ctx)",
        16 * 1024,
        "persisted media canonicalization"
    );
    assertRequiredMarkers(canonicalization, "persisted legacy media canonicalization", [
        'const hadTopLevelMedia = Object.hasOwn(record, "media")',
        "media: canonical ?? topLevelMedia",
        'throw new Error("legacy media arrays have ambiguous sparse positional alignment")',
        "MediaType: void 0",
        "MediaTypes: []",
        "delete next.media",
        "for (const key of PERSISTED_LEGACY_MEDIA_KEYS) delete next[key]",
        "openclaw.media = media",
        'next["__openclaw"] = openclaw',
    ]);

    const precedence = boundedSourceRegion(
        mediaFacts,
        "function resolveMediaFactsWithPrecedence(source, legacyProjectionWins)",
        "/** Normalizes canonical facts or, for compatibility callers, legacy parallel fields. */",
        8 * 1024,
        "media carrier precedence"
    );
    assertRequiredMarkers(precedence, "media carrier precedence", [
        "const canonical = normalizeMediaFacts(source.media)",
        "const paths = Array.isArray(source.MediaPaths) ? source.MediaPaths : []",
        "const urls = Array.isArray(source.MediaUrls) ? source.MediaUrls : []",
        "const types = Array.isArray(source.MediaTypes) ? source.MediaTypes : []",
        "const count = Math.max(canonical.length, paths.length, urls.length, types.length, source.MediaPath || source.MediaUrl || source.MediaType ? 1 : 0)",
        "const legacyPath = paths[index] ?? (index === 0 ? source.MediaPath : void 0)",
        "const legacyUrl = urls[index] ?? (paths.length > 0 || index === 0 ? source.MediaUrl : void 0)",
        "const legacyContentType = normalizeOptionalString(types[index]) ?? (index === 0 ? source.MediaType : void 0)",
        "fact?.path ?? legacyPath",
        "fact?.url ?? legacyUrl",
        "fact?.contentType ?? legacyContentType",
    ]);

    const directives = artifactByRole(artifacts, "media-output-directives").contents;
    const directiveParser = boundedSourceRegion(
        directives,
        "function splitMediaFromOutput(raw, options = {})",
        "//#endregion",
        24 * 1024,
        "MEDIA directive parser"
    );
    assertRequiredMarkers(directives, "MEDIA directive validation", [
        "const MEDIA_TOKEN_RE =",
        "if (candidate.length > 4096) return false",
        "if (hasTraversalOrUnsupportedHomeDirPrefix(candidate)) return false",
        String.raw`const FILE_URL_PREFIX_RE = /^file:\/\//i`,
    ]);
    assertRequiredMarkers(directiveParser, "MEDIA directive projection", [
        "const trimmedStart = line.trimStart()",
        '!trimmedStart.toUpperCase().startsWith("MEDIA:")',
        "isInsideFence(fenceSpans, lineOffset)",
        "const candidate = normalizeMediaSource(cleanCandidate(part))",
        "else if (looksLikeLocalPath) foundMediaToken = true",
        "const parsedText = foundMediaToken || hasAudioAsVoice ? cleanedText : trimmedRaw",
    ]);

    const displayProjection = artifactByRole(
        artifacts,
        "chat-display-projection"
    ).contents;
    assertRequiredMarkers(displayProjection, "canonical media history projection", [
        "function hasTranscriptMediaFacts(message)",
        "(readPersistedMediaFacts(message) ?? []).some(isMeaningfulMediaFact)",
        "isEmptyTextOnlyContent(message.content ?? message.text) && !hasTranscriptMediaFacts(message)",
        "function toProjectedMessages(messages)",
    ]);
    assertRequiredMarkers(
        artifactByRole(artifacts, "chat-send-handler").contents,
        "chat history display projection",
        ["projectChatDisplayMessages(recencyFilteredMessages"]
    );

    const persistence = artifactByRole(
        artifacts,
        "transcript-media-persistence"
    ).contents;
    assertRequiredMarkers(persistence, "SQLite media canonicalization", [
        "const persistedEvent = canonicalizeTranscriptEventMedia(event)",
        "event_json: JSON.stringify(persistedEvent)",
        "function canonicalizeTranscriptEventMedia(event)",
        'if (record.type !== "message"',
        "const canonical = canonicalizePersistedUserMessageMedia(message)",
        "message: canonical.message",
    ]);

    assertRequiredMarkers(
        artifactByRole(artifacts, "media-store-root").contents,
        "OpenClaw media store root",
        [
            'const resolveMediaDir = () => path.join(resolveConfigDir(), "media")',
            "const mediaDir = resolveMediaDir()",
            "if (!isPathInside(mediaDir, dir))",
        ]
    );

    return {
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
    };
}

function assertPhase4ChatAdapterSemantics(
    artifacts: readonly LoadedSourceArtifact[]
): Pick<SourceAuditResult["chat"], "adapter" | "methodAccess"> {
    const descriptors = artifactByRole(artifacts, "method-descriptors").contents;
    for (const [method, scope] of [
        ["chat.abort", "operator.write"],
        ["chat.history", "operator.read"],
        ["chat.message.get", "operator.read"],
        ["chat.send", "operator.write"],
        ["models.list", "operator.read"],
        ["sessions.companion.ask", "operator.read"],
        ["sessions.companion.state", "operator.read"],
        ["sessions.messages.subscribe", "operator.read"],
        ["sessions.messages.unsubscribe", "operator.read"],
    ] as const) {
        assertMethodPermission(descriptors, method, scope, false);
    }
    assertMethodPermission(
        descriptors,
        "sessions.companion.reset",
        "operator.write",
        true
    );
    assertMethodDescriptorScope(descriptors, "sessions.patch", "dynamic");

    const protocol = artifactByRole(artifacts, "protocol-schemas").contents;
    const historyParams = boundedSourceRegion(
        protocol,
        "const ChatHistoryParamsSchema = closedObject({",
        "/** Lightweight chat metadata request",
        4 * 1024,
        "chat.history adapter params"
    );
    assertExactIndentedFields(
        historyParams,
        1,
        [
            "agentId",
            "limit",
            "maxChars",
            "messageId",
            "offset",
            "sessionId",
            "sessionKey",
        ],
        "chat.history adapter params"
    );
    assertRequiredMarkers(historyParams, "chat.history bounds", [
        "minimum: 1",
        "maximum: 1e3",
        "maximum: 5e5",
    ]);

    const messageGetParams = boundedSourceRegion(
        protocol,
        "const ChatMessageGetParamsSchema = closedObject({",
        "/** Permissive attachment envelope",
        4 * 1024,
        "chat.message.get adapter"
    );
    assertIncludesIndentedFields(
        messageGetParams,
        1,
        ["agentId", "maxChars", "messageId", "sessionKey"],
        "chat.message.get params"
    );
    assertRequiredMarkers(messageGetParams, "chat.message.get result", [
        'Type.Literal("not_found")',
        'Type.Literal("not_visible")',
        'Type.Literal("oversized")',
    ]);

    const companionExchange = boundedSourceRegion(
        protocol,
        "const SessionCompanionExchangeSchema = closedObject({",
        "/** Asks the read-only companion",
        2 * 1024,
        "sessions.companion exchange"
    );
    assertExactIndentedFields(
        companionExchange,
        1,
        ["answer", "question", "ts"],
        "sessions.companion exchange"
    );
    const companionAskParams = boundedSourceRegion(
        protocol,
        "const SessionsCompanionAskParamsSchema = closedObject({",
        "/** Companion answer returned",
        2 * 1024,
        "sessions.companion.ask params"
    );
    assertExactIndentedFields(
        companionAskParams,
        1,
        ["question", "sessionKey"],
        "sessions.companion.ask params"
    );
    const companionAskResult = boundedSourceRegion(
        protocol,
        "const SessionsCompanionAskResultSchema = closedObject({",
        "/** Selects the in-memory companion thread",
        2 * 1024,
        "sessions.companion.ask result"
    );
    assertExactIndentedFields(
        companionAskResult,
        1,
        ["answer", "ts"],
        "sessions.companion.ask result"
    );
    assertRequiredMarkers(protocol, "sessions.companion state/reset protocol", [
        "const SessionsCompanionStateParamsSchema = closedObject({ sessionKey: NonEmptyString });",
        "const SessionsCompanionStateResultSchema = closedObject({ exchanges: Type.Array(SessionCompanionExchangeSchema, { maxItems: 24 }) });",
        "const SessionsCompanionResetParamsSchema = closedObject({ sessionKey: NonEmptyString });",
        "const SessionsCompanionResetResultSchema = closedObject({ ok: Type.Literal(true) });",
    ]);
    const companionRpc = artifactByRole(artifacts, "session-companion-rpc").contents;
    assertRequiredMarkers(companionRpc, "sessions.companion RPC acknowledgements", [
        "if (!client?.connId)",
        "connId: client.connId",
        "respond(true, await context.sessionCompanion.ask({",
        "respond(true, context.sessionCompanion.state(sessionKey))",
        "context.sessionCompanion.reset(sessionKey)",
        "respond(true, { ok: true })",
    ]);
    const companionRuntime = artifactByRole(artifacts, "runtime-subscriptions").contents;
    const companionReset = boundedSourceRegion(
        companionRuntime,
        "const reset = (sessionKey) => {",
        "return {",
        2 * 1024,
        "sessions.companion reset"
    );
    assertRequiredMarkers(companionReset, "sessions.companion reset", [
        "askRuntime.cancel(key)",
        "threads.delete(key)",
    ]);
    if (
        companionReset.indexOf("askRuntime.cancel(key)") >
        companionReset.indexOf("threads.delete(key)")
    ) {
        throw new Error(
            "OpenClaw sessions.companion reset no longer cancels the active ask before deleting its thread"
        );
    }
    assertRequiredMarkers(companionRuntime, "sessions.companion process state", [
        "const threads = /* @__PURE__ */ new Map()",
        "const thread = threads.get(key)",
        "state(sessionKey)",
    ]);

    const attachmentSchema = boundedSourceRegion(
        protocol,
        "const ChatAttachmentSchema = Type.Object({",
        "/** Attachment list shared by chat.send",
        4 * 1024,
        "chat.send attachment envelope"
    );
    assertIncludesIndentedFields(
        attachmentSchema,
        1,
        ["content", "fileName", "mimeType", "sizeBytes", "type"],
        "chat.send attachment envelope"
    );
    assertRequiredMarkers(attachmentSchema, "chat.send attachment openness", [
        "additionalProperties: true",
    ]);

    const sendParams = boundedSourceRegion(
        protocol,
        "const ChatSendParamsSchema = closedObject({",
        "/** Cancels the active or named run for a chat session. */",
        8 * 1024,
        "chat.send adapter params"
    );
    assertRequiredMarkers(sendParams, "chat.send adapter params", [
        "sessionKey: ChatSendSessionKeyString",
        "message: Type.String()",
        "thinking: Type.Optional(Type.String())",
        'fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")]))',
        "queueMode: Type.Optional(Type.String({ enum:",
        "attachments: Type.Optional(ChatAttachmentsSchema)",
        "idempotencyKey: NonEmptyString",
    ]);

    const abortParams = boundedSourceRegion(
        protocol,
        "const ChatAbortParamsSchema = closedObject({",
        "/** Inserts an operator-visible synthetic message",
        2 * 1024,
        "chat.abort adapter params"
    );
    assertExactIndentedFields(
        abortParams,
        1,
        ["agentId", "preserveSideRuns", "runId", "sessionKey"],
        "chat.abort adapter params"
    );

    const modelChoice = boundedSourceRegion(
        protocol,
        "const ModelChoiceSchema = closedObject({",
        "/** Semantic owner of an agent roster entry. */",
        4 * 1024,
        "models.list row"
    );
    assertIncludesIndentedFields(
        modelChoice,
        1,
        ["id", "name", "provider", "reasoning"],
        "models.list row"
    );
    const modelsParams = boundedSourceRegion(
        protocol,
        "const ModelsListParamsSchema = closedObject({",
        "/** Reads model-provider credential health",
        2 * 1024,
        "models.list params"
    );
    assertExactIndentedFields(
        modelsParams,
        1,
        ["includeProviderCapabilities", "view"],
        "models.list params"
    );
    assertRequiredMarkers(modelsParams, "models.list configured view", [
        'Type.Literal("configured")',
    ]);
    assertRequiredMarkers(
        artifactByRole(artifacts, "models-handlers").contents,
        "models.list handler",
        [
            '"models.list": async',
            'assertValidParams(params, validateModelsListParams, "models.list", respond)',
            "await buildModelsListResult({",
        ]
    );

    const messageSubscribeParams = boundedSourceRegion(
        protocol,
        "const SessionsMessagesSubscribeParamsSchema = closedObject({",
        "/** Removes a live message subscription",
        2 * 1024,
        "sessions.messages.subscribe params"
    );
    assertExactIndentedFields(
        messageSubscribeParams,
        1,
        ["agentId", "includeApprovals", "key"],
        "sessions.messages.subscribe params"
    );
    const messageUnsubscribeParams = boundedSourceRegion(
        protocol,
        "const SessionsMessagesUnsubscribeParamsSchema = closedObject({",
        "/** Aborts the active or named run for a session. */",
        2 * 1024,
        "sessions.messages.unsubscribe params"
    );
    assertExactIndentedFields(
        messageUnsubscribeParams,
        1,
        ["agentId", "key"],
        "sessions.messages.unsubscribe params"
    );

    const chatEvents = boundedSourceRegion(
        protocol,
        "const ChatEventBaseSchema = {",
        "//#endregion",
        8 * 1024,
        "chat private event union"
    );
    assertRequiredMarkers(chatEvents, "chat private event union", [
        'state: Type.Literal("status")',
        'state: Type.Literal("delta")',
        'state: Type.Literal("final")',
        'state: Type.Literal("aborted")',
        'state: Type.Literal("error")',
        "const ChatEventSchema = Type.Union([",
    ]);

    const chatHandler = artifactByRole(artifacts, "chat-send-handler").contents;
    assertRequiredMarkers(chatHandler, "chat history and message hydration", [
        'const max = Math.min(1e3, typeof limit === "number" ? limit : 200)',
        'return typeof metadata?.id === "string" ? metadata.id : void 0',
        "const nextOffset = hasMore ? candidateNextOffset : void 0",
        "...hasMore ? { nextOffset } : {}",
        "...hasMore !== void 0 ? { hasMore } : {}",
        "sessionKey,",
        "sessionId,",
        "messages: bounded.messages",
        'unavailableReason: "not_found"',
        'unavailableReason: "not_visible"',
        'unavailableReason: "oversized"',
    ]);
    assertRequiredMarkers(chatHandler, "chat in-flight history projection", [
        "sessionInfo.activeRunIds = activeRunState.runIds",
        "const boundedInFlightRun = boundInFlightRunSnapshotForChatHistory({",
        "snapshot: resolveInFlightRunSnapshot({",
        "messages: bounded.messages",
        "...boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {}",
    ]);
    const inFlightRunProjection = artifactByRole(
        artifacts,
        "chat-run-projection"
    ).contents;
    assertRequiredMarkers(inFlightRunProjection, "chat in-flight run selection", [
        "for (const [runId, entry] of params.chatAbortControllers)",
        'entry.kind === "agent"',
        "entry.startedAtMs > best.startedAtMs",
        "entry.startedAtMs === best.startedAtMs && runId > best.runId",
        "const run = params.chatRunState.runs.get(best.runId)",
    ]);
    assertRequiredMarkers(inFlightRunProjection, "chat in-flight page budget", [
        "const messagesBytes = jsonUtf8Bytes(params.messages)",
        "messagesBytes + jsonUtf8Bytes(params.snapshot) <= params.maxBytes",
        "messagesBytes + jsonUtf8Bytes(withoutText) <= params.maxBytes",
        "messagesBytes + jsonUtf8Bytes(withoutPlan) <= params.maxBytes",
    ]);
    assertRequiredMarkers(chatHandler, "chat abort acknowledgement", [
        'assertValidParams(params, validateChatAbortParams, "chat.abort", respond)',
        "aborted: runIds.length > 0",
        "runIds",
    ]);

    const sessionsHandler = artifactByRole(artifacts, "sessions-handlers").contents;
    const messageSubscriptions = boundedSourceRegion(
        sessionsHandler,
        '"sessions.messages.subscribe":',
        "//#region src/gateway/server-methods/session-typing-state.ts",
        12 * 1024,
        "session-scoped chat subscription handlers"
    );
    assertRequiredMarkers(
        messageSubscriptions,
        "session-scoped chat subscription acknowledgements",
        [
            "context.subscribeSessionMessageEvents(connId, subscriptionKey)",
            "subscribed: true",
            "key: canonicalKey",
            '"sessions.messages.unsubscribe":',
            "context.unsubscribeSessionMessageEvents(connId, subscriptionKey)",
            "subscribed: false",
        ]
    );

    const patchParams = boundedSourceRegion(
        protocol,
        "const SessionsPatchParamsSchema = closedObject({",
        "/** Updates or clears one plugin namespace value",
        12 * 1024,
        "chat settings params"
    );
    assertRequiredMarkers(patchParams, "chat settings params", [
        "key: NonEmptyString",
        "expectedSessionId: Type.Optional(NonEmptyString)",
        "thinkingLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()]))",
        "fastMode: Type.Optional(Type.Union([",
        "model: Type.Optional(Type.Union([NonEmptyString, Type.Null()]))",
    ]);
    const patchScopes = boundedSourceRegion(
        artifactByRole(artifacts, "method-scopes").contents,
        "* sessions.patch fields a write-scoped operator may mutate",
        "function resolveSessionsCreateRequiredScopes",
        4 * 1024,
        "chat settings scope"
    );
    assertRequiredMarkers(patchScopes, "chat settings admin scope", [
        "Any other field (model, sendPolicy, tool inheritance,",
        "Object.keys(params).every",
        "? [WRITE_SCOPE] : [ADMIN_SCOPE]",
    ]);
    if (
        ["model", "thinkingLevel", "fastMode", "expectedSessionId"].some((field) =>
            new RegExp(`^[\\t ]*"${field}",[\\t ]*$`, "mu").test(patchScopes)
        )
    ) {
        throw new Error("OpenClaw chat settings no longer require operator.admin");
    }
    const patchHandler = boundedSourceRegion(
        sessionsHandler,
        '"sessions.patch": async',
        '"sessions.pluginPatch": async',
        24 * 1024,
        "chat settings acknowledgement"
    );
    assertRequiredMarkers(patchHandler, "chat settings acknowledgement", [
        "p.expectedSessionId !== void 0 && currentLifecycleEntry?.sessionId !== p.expectedSessionId",
        "entry: applied.entry",
        "resolved: {",
        "model: resolvedDisplayModel.model",
        "thinkingLevel: thinkingProjection.effectiveThinkingLevel",
    ]);

    const streaming = artifactByRole(artifacts, "chat-streaming").contents;
    const deltaDelivery = boundedSourceRegion(
        streaming,
        "const flushPayload = {",
        "run.deltaLastBroadcastLen = text.length",
        4 * 1024,
        "chat delta backpressure"
    );
    assertRequiredMarkers(deltaDelivery, "chat delta backpressure", [
        'state: "delta"',
        "dropIfSlow: true",
    ]);
    const terminalDelivery = boundedSourceRegion(
        streaming,
        "const emitChatTerminal =",
        "const sendAgentPayload =",
        8 * 1024,
        "chat terminal backpressure"
    );
    assertRequiredMarkers(terminalDelivery, "chat terminal backpressure", [
        "flushBufferedChatDeltaIfNeeded",
        'state: jobState === "done" ? "final" : "aborted"',
        'state: "error"',
        "sendChatPayload(sessionKey, payload, opts)",
    ]);
    if (terminalDelivery.includes("dropIfSlow: true")) {
        throw new Error("OpenClaw chat terminal delivery no longer closes slow sockets");
    }

    const media = artifactByRole(artifacts, "managed-outgoing-media").contents;
    const mediaHandler = boundedSourceRegion(
        media,
        "async function handleManagedOutgoingMediaHttpRequest",
        "//#endregion",
        16 * 1024,
        "managed outgoing media handler"
    );
    assertRequiredMarkers(media, "managed outgoing media identity", [
        'const OUTGOING_IMAGE_ROUTE_PREFIX = "/api/chat/media/outgoing"',
        "const MANAGED_OUTGOING_ATTACHMENT_ID_RE = /^[0-9a-f]",
        "async function recordMatchesTranscriptMessage",
        "return `${OUTGOING_IMAGE_ROUTE_PREFIX}/${encodeURIComponent(sessionKey)}/${attachmentId}/${variant}`",
    ]);
    assertRequiredMarkers(mediaHandler, "managed outgoing media authorization", [
        'req.method !== "GET" && req.method !== "HEAD"',
        "MANAGED_OUTGOING_ATTACHMENT_ID_RE.test(attachmentId)",
        "authorizeGatewayHttpRequestOrReply({",
        'authorizeOperatorScopesForMethod("chat.history"',
        "resolveOpenAiCompatibleHttpSenderIsOwner",
        "record.sessionKey !== sessionKey",
        "recordMatchesTranscriptMessage(record)",
        "openLocalFileSafely",
        "resolveByteResponse({",
        "rangeHeader: req.headers.range",
    ]);
    const localHistory = assertLocalHistoryMediaSemantics(artifacts);

    return {
        adapter: {
            lanes: {
                abort: "one-shot-write",
                companionAsk: "one-shot-read-mutation",
                companionReset: "one-shot-write",
                companionState: "persistent-read",
                history: "persistent-read",
                messageGet: "persistent-read",
                modelsList: "persistent-read",
                send: "one-shot-write",
                settings: "one-shot-admin",
                subscription: "private-session-scoped",
            },
            media: {
                attachmentId: "uuidv4",
                bearerServerSide: true,
                localHistory,
                ownerRequired: true,
                rangeRequests: true,
                routePrefix: "/api/chat/media/outgoing",
                transcriptAssociationRequired: true,
                variant: "full",
            },
            methods: {
                abort: {
                    method: "chat.abort",
                    requestParams: ["preserveSideRuns", "runId", "sessionKey"],
                    resultFields: ["aborted", "ok", "runIds"],
                },
                companionAsk: {
                    connectionRequired: true,
                    method: "sessions.companion.ask",
                    requestParams: ["question", "sessionKey"],
                    resultFields: ["answer", "ts"],
                },
                companionReset: {
                    method: "sessions.companion.reset",
                    requestParams: ["sessionKey"],
                    resetCancelsActiveAsk: true,
                    resultFields: ["ok"],
                },
                companionState: {
                    connectionIndependent: true,
                    exchangeFields: ["answer", "question", "ts"],
                    method: "sessions.companion.state",
                    requestParams: ["sessionKey"],
                    resultFields: ["exchanges"],
                },
                history: {
                    defaultLimit: 200,
                    inFlightRun: {
                        boundedAgainstPageMessages: true,
                        exactValueStableAcrossPages: false,
                        multipleActiveRunsPossible: true,
                        recomputedPerRequest: true,
                        selection: "newest-visible-run",
                        tieBreak: "runId-descending",
                    },
                    maximumLimit: 1000,
                    messageIdentityPath: "__openclaw.id",
                    messageOrder: "chronological",
                    method: "chat.history",
                    pagination: {
                        hasMoreRequiresNextOffset: true,
                        nextOffsetOnlyWhenHasMore: true,
                        offsetDirection: "older-from-recent-tail",
                    },
                    possibleResponseFields: [
                        "completeSnapshot",
                        "defaults",
                        "fastMode",
                        "hasMore",
                        "inFlightRun",
                        "messages",
                        "nextOffset",
                        "offset",
                        "sessionId",
                        "sessionInfo",
                        "sessionKey",
                        "thinkingLevel",
                        "toolOverrides",
                        "totalMessages",
                        "verboseLevel",
                    ],
                    requestParams: [
                        "agentId",
                        "limit",
                        "maxChars",
                        "messageId",
                        "offset",
                        "sessionId",
                        "sessionKey",
                    ],
                    sessionIdentity: {
                        requestedKeyEchoed: true,
                        sessionIdOptional: true,
                    },
                },
                messageGet: {
                    messageIdentityPath: "__openclaw.id",
                    method: "chat.message.get",
                    requestParams: ["agentId", "maxChars", "messageId", "sessionKey"],
                    successFields: ["message", "ok"],
                    unavailableFields: ["ok", "unavailableReason"],
                    unavailableReasons: ["not_found", "not_visible", "oversized"],
                },
                modelsList: {
                    method: "models.list",
                    requestParams: ["includeProviderCapabilities", "view"],
                    rowFields: ["id", "name", "provider", "reasoning"],
                },
                send: {
                    acknowledgedStatuses: ["in_flight", "ok", "started"],
                    attachmentFields: [
                        "content",
                        "fileName",
                        "mimeType",
                        "sizeBytes",
                        "type",
                    ],
                    idempotencyKeyIsRunId: true,
                    method: "chat.send",
                },
                settings: {
                    generationAcknowledgement: {
                        requestField: "expectedSessionId",
                        requiredOnFencedMutation: true,
                        responseField: "entry.sessionId",
                    },
                    method: "sessions.patch",
                    requestParams: [
                        "expectedSessionId",
                        "fastMode",
                        "key",
                        "model",
                        "thinkingLevel",
                    ],
                    requiredScope: "operator.admin",
                },
            },
            subscription: {
                eventNames: ["agent", "chat"],
                methods: ["sessions.messages.subscribe", "sessions.messages.unsubscribe"],
                requiresSessionMessageSubscription: true,
                slowDeltaPolicy: "drop-event",
                slowTerminalPolicy: "close-socket",
                states: ["aborted", "delta", "error", "final", "status"],
            },
        },
        methodAccess: [
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
        ],
    };
}

function assertPhase4TaskAdapterSemantics(
    artifacts: readonly LoadedSourceArtifact[]
): SourceAuditResult["tasks"]["adapter"] {
    const protocol = artifactByRole(artifacts, "protocol-schemas").contents;
    const summary = boundedSourceRegion(
        protocol,
        "const TaskSummarySchema = closedObject({",
        "/** Task list filters with bounded pagination. */",
        8 * 1024,
        "task summary"
    );
    const summaryFields = [
        "agentId",
        "childSessionKey",
        "createdAt",
        "endedAt",
        "error",
        "flowId",
        "id",
        "kind",
        "lastToolName",
        "ownerKey",
        "parentTaskId",
        "progressSummary",
        "prompt",
        "runId",
        "runtime",
        "sessionKey",
        "sourceId",
        "startedAt",
        "status",
        "taskId",
        "terminalSummary",
        "title",
        "toolUseCount",
        "updatedAt",
    ] as const;
    assertExactIndentedFields(summary, 1, summaryFields, "task summary");
    assertRequiredMarkers(summary, "task summary timestamps", [
        "createdAt: Type.Optional(TimestampSchema)",
        "updatedAt: Type.Optional(TimestampSchema)",
        "startedAt: Type.Optional(TimestampSchema)",
        "endedAt: Type.Optional(TimestampSchema)",
        "prompt: Type.Optional(Type.String())",
    ]);
    assertRequiredMarkers(protocol, "task timestamp representations", [
        "const TimestampSchema = Type.Union([Type.String(), Type.Integer({ minimum: 0 })]);",
    ]);

    const listParams = boundedSourceRegion(
        protocol,
        "const TasksListParamsSchema = closedObject({",
        "/** Task list page response. */",
        4 * 1024,
        "tasks.list params"
    );
    assertExactIndentedFields(
        listParams,
        1,
        ["agentId", "cursor", "limit", "sessionKey", "status"],
        "tasks.list params"
    );
    assertRequiredMarkers(listParams, "tasks.list status and bounds", [
        "Type.Union([TaskLedgerStatusSchema, Type.Array(TaskLedgerStatusSchema)])",
        "minimum: 1",
        "maximum: 500",
    ]);
    const listResult = boundedSourceRegion(
        protocol,
        "const TasksListResultSchema = closedObject({",
        "/** Lookup request for one task id. */",
        2 * 1024,
        "tasks.list result"
    );
    assertExactIndentedFields(
        listResult,
        1,
        ["nextCursor", "tasks"],
        "tasks.list result"
    );
    assertRequiredMarkers(protocol, "tasks.get protocol", [
        "const TasksGetParamsSchema = closedObject({ taskId: NonEmptyString });",
        "const TasksGetResultSchema = closedObject({ task: TaskSummarySchema });",
    ]);
    const cancelParams = boundedSourceRegion(
        protocol,
        "const TasksCancelParamsSchema = closedObject({",
        "/** Cancel result, including the task snapshot when it was found. */",
        2 * 1024,
        "tasks.cancel params"
    );
    assertExactIndentedFields(
        cancelParams,
        1,
        ["reason", "taskId"],
        "tasks.cancel params"
    );
    const cancelResult = boundedSourceRegion(
        protocol,
        "const TasksCancelResultSchema = closedObject({",
        "/** Approval request raised by a plugin",
        2 * 1024,
        "tasks.cancel result"
    );
    assertExactIndentedFields(
        cancelResult,
        1,
        ["cancelled", "found", "reason", "task"],
        "tasks.cancel result"
    );

    const handlers = artifactByRole(artifacts, "tasks-handlers").contents;
    assertRequiredMarkers(handlers, "task handler response semantics", [
        String.raw`if (!/^\d+$/.test(cursor.trim())) return null`,
        "const nextOffset = cursor + page.tasks.length",
        "tasks: page.tasks.map((task) => mapTaskSummary(task))",
        "...page.hasMore ? { nextCursor: String(nextOffset) } : {}",
        "respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`))",
        "respond(true, { task: mapTaskSummary(task, { includePrompt: true }) })",
        "found: result.found",
        "cancelled: result.cancelled",
        "...result.task ? { task: mapTaskSummary(result.task) } : {}",
    ]);
    const events = artifactByRole(artifacts, "runtime-subscriptions").contents;
    assertRequiredMarkers(events, "task event payloads", [
        'action: "upserted"',
        "task: mapTaskSummary(event.task)",
        'action: "deleted"',
        "taskId: event.taskId",
        'payload = { action: "restored" }',
        'params.broadcast("task", payload, { dropIfSlow: true })',
    ]);

    return {
        cancel: {
            method: "tasks.cancel",
            notFoundIsRpcSuccess: true,
            requestParams: ["reason", "taskId"],
            resultFields: ["cancelled", "found", "reason", "task"],
            taskOptional: true,
        },
        event: {
            deletedFields: ["action", "taskId"],
            delivery: "best-effort-drop-if-slow",
            restoredFields: ["action"],
            summariesOmitPrompt: true,
            upsertedFields: ["action", "task"],
        },
        get: {
            method: "tasks.get",
            notFound: "invalid-request-rpc-error",
            promptIncluded: true,
            requestParams: ["taskId"],
            resultFields: ["task"],
        },
        list: {
            cursor: "decimal-offset",
            cursorIncrement: "returned-row-count",
            method: "tasks.list",
            nextCursorOnlyWhenHasMore: true,
            promptIncluded: false,
            requestParams: ["agentId", "cursor", "limit", "sessionKey", "status"],
            resultFields: ["nextCursor", "tasks"],
            statusAcceptsScalarOrArray: true,
        },
        summary: {
            endedAtOptionalForEveryStatus: true,
            fields: [...summaryFields],
            promptOptional: true,
            timestampFields: ["createdAt", "endedAt", "startedAt", "updatedAt"],
            timestampRepresentations: ["integer", "string"],
        },
    };
}

function assertSystemInfoSemantics(
    artifacts: readonly LoadedSourceArtifact[]
): SourceAuditResult["cron"]["adapter"]["operations"]["systemInfo"] {
    const protocol = artifactByRole(artifacts, "protocol-schemas").contents;
    const params = boundedSourceRegion(
        protocol,
        "/** Empty request payload for Gateway host system information. */",
        "const UtilityModelStatusSchema",
        1024,
        "system.info params"
    );
    assertRequiredMarkers(params, "system.info params", [
        "const SystemInfoParamsSchema = closedObject({});",
    ]);
    const result = boundedSourceRegion(
        protocol,
        "const SystemInfoResultSchema = closedObject({",
        "//#region packages/gateway-protocol/src/schema/task-suggestions.ts",
        8 * 1024,
        "system.info result"
    );
    const responseFields = [
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
    ] as const;
    assertExactIndentedFields(result, 1, responseFields, "system.info result");
    assertRequiredMarkers(result, "system.info process identity", [
        "processInstanceId: Type.Optional(Type.String({ minLength: 1 }))",
    ]);

    const handler = artifactByRole(artifacts, "system-info-handler").contents;
    const collection = boundedSourceRegion(
        handler,
        "async function collectSystemInfo(context) {",
        "/** Gateway handlers for identity, host information, heartbeat toggles, and presence events. */",
        16 * 1024,
        "system.info collection"
    );
    assertRequiredMarkers(collection, "system.info process identity collection", [
        "processInstanceId: getGatewayProcessInstanceId()",
    ]);
    const method = boundedSourceRegion(
        handler,
        '"system.info": async',
        '"system-event":',
        2048,
        "system.info handler"
    );
    assertRequiredMarkers(method, "system.info handler", [
        'assertValidParams(params, validateSystemInfoParams, "system.info", respond)',
        "respond(true, await collectSystemInfo(context), void 0)",
    ]);
    assertMethodPermission(
        artifactByRole(artifacts, "method-descriptors").contents,
        "system.info",
        "operator.read",
        false
    );

    return {
        method: "system.info",
        processInstanceId: { minimumCharacters: 1, optional: true },
        requestParams: [],
        responseFields: [...responseFields],
        responseSchema: "closed-object",
    };
}

function assertPhase4SessionsSemantics(
    artifacts: readonly LoadedSourceArtifact[]
): SourceAuditResult["sessions"]["adapter"] {
    const protocol = artifactByRole(artifacts, "protocol-schemas").contents;
    const listParams = boundedSourceRegion(
        protocol,
        "const SessionsListParamsSchema = closedObject({",
        "/** Searches one agent's indexed session transcripts",
        8 * 1024,
        "sessions.list params"
    );
    assertExactIndentedFields(
        listParams,
        1,
        [
            "activeMinutes",
            "agentId",
            "archived",
            "boardFace",
            "configuredAgentsOnly",
            "creatorId",
            "includeDerivedTitles",
            "includeGlobal",
            "includeLastMessage",
            "includeUnknown",
            "label",
            "limit",
            "offset",
            "requireLastInteraction",
            "search",
            "sortBy",
            "spawnedBy",
        ],
        "sessions.list params"
    );
    const rowSchema = boundedSourceRegion(
        protocol,
        "const SessionRowSchema = Type.Object({",
        "//#region packages/gateway-protocol/src/schema/sessions-catalog.ts",
        16 * 1024,
        "session row"
    );
    assertIncludesIndentedFields(
        rowSchema,
        1,
        [
            "channel",
            "contextTokens",
            "createdAt",
            "createdVia",
            "displayName",
            "key",
            "kind",
            "label",
            "model",
            "modelProvider",
            "parentSessionKey",
            "sessionId",
            "spawnedBy",
            "status",
            "totalTokens",
            "totalTokensFresh",
            "updatedAt",
        ],
        "session row"
    );
    const resetParams = boundedSourceRegion(
        protocol,
        "const SessionsResetParamsSchema = closedObject({",
        "/** Deletes a session record and optionally its transcript. */",
        2 * 1024,
        "sessions.reset params"
    );
    assertExactIndentedFields(
        resetParams,
        1,
        ["agentId", "key", "reason"],
        "sessions.reset params"
    );
    const deleteParams = boundedSourceRegion(
        protocol,
        "const SessionsDeleteParamsSchema = closedObject({",
        "/** Lists the gateway-owned custom session group catalog",
        4 * 1024,
        "sessions.delete params"
    );
    assertExactIndentedFields(
        deleteParams,
        1,
        [
            "agentId",
            "archivedOnly",
            "deleteTranscript",
            "emitLifecycleHooks",
            "expectedLifecycleRevision",
            "expectedSessionId",
            "expectedSessionUpdatedAt",
            "key",
        ],
        "sessions.delete params"
    );
    const compactParams = boundedSourceRegion(
        protocol,
        "const SessionsCompactParamsSchema = closedObject({",
        "/** Lists compaction checkpoints for one session. */",
        2 * 1024,
        "sessions.compact params"
    );
    assertExactIndentedFields(
        compactParams,
        1,
        ["agentId", "key", "maxLines"],
        "sessions.compact params"
    );

    const listProjection = artifactByRole(artifacts, "session-list-projection").contents;
    const listResult = boundedSourceRegion(
        listProjection,
        "function buildSessionsListResult(params) {",
        "function filterAndSortSessionEntries(params)",
        4 * 1024,
        "sessions.list response"
    );
    assertRequiredMarkers(listResult, "sessions.list response", [
        "ts: list.now",
        "path: list.storePath",
        "count: sessions.length",
        "totalCount: list.totalCount",
        "limitApplied: list.limitApplied",
        "offset: list.offset > 0 ? list.offset : void 0",
        "nextOffset: list.nextOffset",
        "hasMore: list.hasMore",
        "creators: list.creators",
        "defaults: getSessionDefaults",
        "sessions",
    ]);

    const rowProjection = boundedSourceRegion(
        artifactByRole(artifacts, "session-row-projection").contents,
        "function buildGatewaySessionRow(params) {",
        "//#endregion",
        48 * 1024,
        "sessions.list row projection"
    );
    assertRequiredMarkers(rowProjection, "sessions.list provider row fields", [
        "\t\tchannel,",
        "\t\tcontextTokens,",
        "\t\tcreatedAt: entry?.createdAt",
        "\t\tcreatedVia: entry?.createdVia",
        "\t\tdisplayName,",
        "\t\teffectiveFastMode: fastModeState.mode",
        "\t\televatedLevel: entry?.elevatedLevel",
        "\t\tendedAt: subagentRun ? subagentEndedAt : entry?.endedAt",
        "\t\tfastMode: entry?.fastMode",
        "\t\tkey,",
        "\t\tkind: gatewayKind",
        "\t\tlabel: entry?.label",
        "\t\tmodel: rowModel",
        "\t\tmodelProvider: rowModelProvider",
        "\t\tparentSessionKey: entry?.parentSessionKey",
        "\t\treasoningLevel: entry?.reasoningLevel",
        "\t\truntimeMs: subagentRun ? subagentRuntimeMs : entry?.runtimeMs",
        "\t\tsessionId: entry?.sessionId",
        "\t\tspawnedBy: subagentOwner || entry?.spawnedBy",
        "\t\tstartedAt: subagentRun ? subagentStartedAt : entry?.startedAt",
        "\t\tstatus: subagentRun ? subagentStatus : entry?.status",
        "\t\tthinkingDefault: thinkingProjection.thinkingDefault",
        "\t\tthinkingLevel: thinkingProjection.thinkingLevel",
        "\t\tthinkingLevels: thinkingProjection.thinkingLevels",
        "\t\tthinkingOptions: thinkingProjection.thinkingOptions",
        "\t\ttotalTokens,",
        "\t\ttotalTokensFresh,",
        "\t\tupdatedAt,",
        "\t\tverboseLevel: entry?.verboseLevel",
    ]);

    const handlers = artifactByRole(artifacts, "sessions-handlers").contents;
    assertRequiredMarkers(handlers, "session adapter acknowledgements", [
        "const sessionCompactHandlers",
        "ok: result.ok",
        "compacted: result.compacted",
        "reason: result.reason",
        "result: result.result",
        '"incognitoDeleted" in result',
        "deleted: true",
        "entry: result.entry",
        "resolved: result.resolved",
        "const sessionDeleteHandlers",
        "archived = deletion.archivedTranscripts.map",
        "worktreePreserved = {",
        "deleted,",
        "archived,",
        "activeRunIds: activeRunState.runIds",
        "hasActiveRun: activeRunState.active",
    ]);
    assertRequiredMarkers(handlers, "session event subscription acknowledgement", [
        '"sessions.subscribe":',
        "context.subscribeSessionEvents(connId)",
        "subscribed: Boolean(connId)",
    ]);
    const subscriptionHandler = boundedSourceRegion(
        handlers,
        '"sessions.subscribe":',
        '"sessions.unsubscribe":',
        2048,
        "sessions.subscribe handler"
    );
    if (/\bparams\b/u.test(subscriptionHandler)) {
        throw new Error(
            "OpenClaw sessions.subscribe gained an unreviewed parameter surface"
        );
    }
    assertRequiredMarkers(handlers, "session lifecycle conflict", [
        "expectedLifecycleRevision",
        "expectedSessionId",
        "expectedSessionUpdatedAt",
        "ErrorCodes.INVALID_REQUEST",
        "details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON }",
    ]);
    assertRequiredMarkers(handlers, "main session delete protection", [
        "const mainKey = resolveMainSessionKey(cfg)",
        'target.canonicalKey === "global"',
        "requestedAgentId !== resolveDefaultAgentId(cfg)",
        "target.canonicalKey === mainKey && !isSelectedNonDefaultGlobal",
        "Cannot delete the main session (${mainKey}).",
    ]);

    const lifecycle = artifactByRole(artifacts, "session-lifecycle").contents;
    assertRequiredMarkers(lifecycle, "session lifecycle reason", [
        'const SESSION_LIFECYCLE_CHANGED_ERROR_REASON = "session-changed"',
    ]);
    const sessionEvent = artifactByRole(artifacts, "session-change-event").contents;
    assertRequiredMarkers(sessionEvent, "session change event", [
        'context.broadcastToConnIds("sessions.changed"',
        "ts: Date.now()",
        "...buildGatewaySessionEventFields({",
        "dropIfSlow: true",
    ]);
    assertRequiredMarkers(
        artifactByRole(artifacts, "session-event-payload").contents,
        "session change lifecycle projection",
        ["updatedAt: sessionRow.updatedAt ?? void 0", "sessionId: sessionRow.sessionId"]
    );
    assertRequiredMarkers(handlers, "session lifecycle event reasons", [
        'reason: "compact"',
        "compacted: true",
        'reason: "delete"',
        'const reason = p.reason === "new" ? "new" : "reset"',
    ]);
    assertRequiredMarkers(
        artifactByRole(artifacts, "session-reset-service").contents,
        "session reset transcript generation",
        [
            "const nextSessionId = currentEntry?.sessionId ?? randomUUID()",
            "sessionId: nextSessionId",
            "lifecycleRevision: randomUUID()",
        ]
    );
    const subscriptionEvents = artifactByRole(
        artifacts,
        "session-subscription-events"
    ).contents;
    assertRequiredMarkers(subscriptionEvents, "session subscription message event", [
        "params.sessionEventSubscribers.getAll()",
        'params.broadcastToConnIds("session.message"',
    ]);
    const transcriptSnapshot = boundedSourceRegion(
        subscriptionEvents,
        "if (update.message === void 0) {",
        "const idempotencyKey =",
        8 * 1024,
        "session transcript snapshot event"
    );
    const transcriptMessage = boundedSourceRegion(
        subscriptionEvents,
        "if (message) {",
        "const sessionEventConnIds =",
        8 * 1024,
        "session transcript message event"
    );
    const transcriptFallback = boundedSourceRegion(
        subscriptionEvents,
        "const sessionEventConnIds =",
        "/** Creates a lifecycle-event broadcaster",
        8 * 1024,
        "session transcript fallback event"
    );
    assertRequiredMarkers(transcriptSnapshot, "session transcript snapshot event", [
        'params.broadcastToConnIds("sessions.changed"',
    ]);
    assertRequiredMarkers(transcriptMessage, "session transcript message event", [
        'params.broadcastToConnIds("session.message"',
    ]);
    if (
        transcriptSnapshot.includes("dropIfSlow") ||
        transcriptMessage.includes("dropIfSlow")
    ) {
        throw new Error(
            "OpenClaw session transcript close-on-slow paths changed outside the reviewed shape"
        );
    }
    assertRequiredMarkers(transcriptFallback, "session transcript fallback event", [
        'params.broadcastToConnIds("sessions.changed"',
        "dropIfSlow: true",
    ]);
    assertRequiredMarkers(
        artifactByRole(artifacts, "session-operation-event").contents,
        "session subscription operation event",
        [
            "function emitSessionOperation",
            "context.getSessionEventSubscriberConnIds()",
            'context.broadcastToConnIds("session.operation"',
            "dropIfSlow: true",
        ]
    );
    assertRequiredMarkers(
        artifactByRole(artifacts, "runtime-subscriptions").contents,
        "session observer subscription audience",
        [
            "function createSessionObserverAudience(params)",
            "params.sessionEventSubscribers?.getAll()",
            'deps.broadcastToConnIds("session.observer"',
            "audience.recipients(",
        ]
    );
    assertRequiredMarkers(
        artifactByRole(artifacts, "chat-streaming").contents,
        "session subscription tool event",
        [
            "sessionEventSubscribers.getAll()",
            'broadcastToConnIds("session.tool"',
            "dropIfSlow: true",
        ]
    );

    const descriptors = artifactByRole(artifacts, "method-descriptors").contents;
    assertMethodDescriptorScope(descriptors, "sessions.compact", "operator.admin");
    assertMethodDescriptorScope(descriptors, "sessions.delete", "dynamic");
    assertMethodDescriptorScope(descriptors, "sessions.list", "operator.read");
    assertMethodDescriptorScope(descriptors, "sessions.subscribe", "operator.read");
    assertMethodDescriptorScope(descriptors, "sessions.reset", "operator.admin");
    const methodScopes = artifactByRole(artifacts, "method-scopes").contents;
    assertRequiredMarkers(methodScopes, "sessions.delete dynamic scope", [
        "Internal controls (emitLifecycleHooks, expected* CAS guards) stay admin-only",
        "const SESSIONS_DELETE_WRITE_SCOPE_FIELDS",
        "if (params.archivedOnly !== true) return [ADMIN_SCOPE]",
        "return Object.keys(params).every",
        "? [WRITE_SCOPE] : [ADMIN_SCOPE]",
    ]);

    return {
        acknowledgements: {
            compact: {
                optionalFields: ["archived", "kept", "reason", "result"],
                requiredFields: ["compacted", "key", "ok"],
                successfulRpcCanReportOkFalse: true,
            },
            delete: {
                okLiteral: true,
                optionalFields: ["worktreePreserved"],
                requiredFields: ["archived", "deleted", "key", "ok"],
                worktreePreservedFields: ["branch", "id", "path"],
            },
            reset: {
                okLiteral: true,
                optionalFields: ["deleted", "entry", "resolved"],
                requiredFields: ["key", "ok"],
            },
        },
        deleteLifecycle: {
            acceptedParams: [
                "agentId",
                "archivedOnly",
                "deleteTranscript",
                "emitLifecycleHooks",
                "expectedLifecycleRevision",
                "expectedSessionId",
                "expectedSessionUpdatedAt",
                "key",
            ],
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
            requestParams: [
                "deleteTranscript",
                "expectedSessionId",
                "expectedSessionUpdatedAt",
                "key",
            ],
        },
        event: {
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
        },
        list: {
            acceptedParams: [
                "activeMinutes",
                "agentId",
                "archived",
                "boardFace",
                "configuredAgentsOnly",
                "creatorId",
                "includeDerivedTitles",
                "includeGlobal",
                "includeLastMessage",
                "includeUnknown",
                "label",
                "limit",
                "offset",
                "requireLastInteraction",
                "search",
                "sortBy",
                "spawnedBy",
            ],
            derivedRowFields: ["activeRunIds", "hasActiveRun"],
            requestParams: [
                "archived",
                "includeGlobal",
                "includeUnknown",
                "limit",
                "sortBy",
            ],
            responseMetadata: [
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
            ],
            rowFields: [
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
            ],
        },
        methodAccess: [
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
        ],
        subscription: {
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
        },
    };
}

function assertOpenClawOperationsSemantics(
    artifacts: readonly LoadedSourceArtifact[]
): SourceAuditResult["operations"] {
    const protocol = artifactByRole(artifacts, "protocol-schemas").contents;
    const cleanupParams = boundedSourceRegion(
        protocol,
        "/** Repairs or removes invalid session records from the selected agent scope. */",
        "/** Reads short previews for selected session keys. */",
        2 * 1024,
        "sessions.cleanup params"
    );
    assertExactIndentedFields(
        cleanupParams,
        1,
        ["activeKey", "agent", "allAgents", "enforce", "fixDmScope", "fixMissing"],
        "sessions.cleanup params"
    );
    assertRequiredMarkers(cleanupParams, "sessions.cleanup optional params", [
        "agent: Type.Optional(NonEmptyString)",
        "allAgents: Type.Optional(Type.Boolean())",
        "enforce: Type.Optional(Type.Boolean())",
        "activeKey: Type.Optional(NonEmptyString)",
        "fixMissing: Type.Optional(Type.Boolean())",
        "fixDmScope: Type.Optional(Type.Boolean())",
    ]);
    assertForbiddenMarkers(cleanupParams, "sessions.cleanup request authority", [
        "idempotencyKey",
        "timeoutMs",
    ]);

    const updateParams = boundedSourceRegion(
        protocol,
        "/** Request payload for running an update/restart flow with optional channel delivery context. */",
        "/** UI metadata attached to config schema paths. */",
        2 * 1024,
        "update.run params"
    );
    assertExactIndentedFields(
        updateParams,
        1,
        [
            "continuationMessage",
            "deliveryContext",
            "note",
            "restartDelayMs",
            "sessionKey",
            "timeoutMs",
        ],
        "update.run params"
    );
    assertRequiredMarkers(updateParams, "update.run optional params", [
        "sessionKey: Type.Optional(Type.String())",
        "deliveryContext: Type.Optional(ConfigDeliveryContextSchema)",
        "note: Type.Optional(Type.String())",
        "continuationMessage: Type.Optional(Type.String())",
        "restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 }))",
        "timeoutMs: Type.Optional(Type.Integer({ minimum: 1 }))",
    ]);
    assertForbiddenMarkers(updateParams, "update.run replay authority", [
        "idempotencyKey",
        "abortSignal",
    ]);

    const descriptors = artifactByRole(artifacts, "method-descriptors").contents;
    assertMethodPermission(descriptors, "sessions.cleanup", "operator.admin", false);
    assertMethodPermission(descriptors, "update.run", "operator.admin", true);

    const sessionHandlers = artifactByRole(artifacts, "sessions-handlers").contents;
    const cleanupHandler = boundedSourceRegion(
        sessionHandlers,
        '"sessions.cleanup": async',
        '"sessions.preview":',
        8 * 1024,
        "sessions.cleanup handler"
    );
    assertRequiredMarkers(cleanupHandler, "sessions.cleanup handler", [
        'assertValidParams(params, validateSessionsCleanupParams, "sessions.cleanup", respond)',
        "const { mode, appliedSummaries } = await runSessionsCleanup({",
        "agent: params.agent",
        "allAgents: params.allAgents",
        "enforce: params.enforce",
        "activeKey: params.activeKey",
        "fixMissing: params.fixMissing",
        "fixDmScope: params.fixDmScope",
        "serializeSessionCleanupResult({",
        "summaries: appliedSummaries",
        'reason: "cleanup"',
        "errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error))",
    ]);

    const cleanupService = artifactByRole(artifacts, "session-cleanup-service").contents;
    const cleanupSerialization = boundedSourceRegion(
        cleanupService,
        "function serializeSessionCleanupResult(params) {",
        "function pruneMissingTranscriptEntries(params) {",
        2 * 1024,
        "sessions.cleanup serialization"
    );
    assertRequiredMarkers(cleanupSerialization, "sessions.cleanup serialization", [
        "if (params.summaries.length === 1) return params.summaries[0] ?? {}",
        "allAgents: true",
        "mode: params.mode",
        "dryRun: params.dryRun",
        "stores: params.summaries",
    ]);
    const cleanupExecution = boundedSourceRegion(
        cleanupService,
        "async function runSessionsCleanup(params) {",
        "/** Purge session store entries for a deleted agent",
        32 * 1024,
        "sessions.cleanup execution"
    );
    const cleanupLifecycleMutationCall =
        "const lifecycleResult = await applySqliteSessionEntryLifecycleMutation({";
    const cleanupDiskBudgetCall =
        "const appliedDiskBudget = await enforceSqliteSessionHistoryDiskBudget({";
    assertRequiredMarkers(cleanupExecution, "sessions.cleanup execution", [
        "const maintenance = resolveMaintenanceConfig()",
        'const mode = opts.enforce ? "enforce" : maintenance.mode',
        "fixMissing: Boolean(opts.fixMissing)",
        "fixDmScope: Boolean(opts.fixDmScope)",
        cleanupLifecycleMutationCall,
        "activeSessionKey: opts.activeKey",
        "maintenanceOverride: {",
        'const appliedUnreferencedArtifacts = mode === "warn" ? null : await pruneUnreferencedSessionArtifacts({',
        cleanupDiskBudgetCall,
        "agentId: target.agentId",
        "storePath: target.storePath",
        "mode: appliedReport.mode",
        "dryRun: false",
        "beforeCount: appliedReport.beforeCount",
        "afterCount: appliedReport.afterCount",
        "missing: missingApplied",
        "dmScopeRetired: dmScopeRetiredApplied",
        "modelRunPruned: appliedReport.modelRunPruned",
        "pruned: appliedReport.pruned",
        "capped: appliedReport.capped",
        "unreferencedArtifacts,",
        "diskBudget: appliedDiskBudget",
        "wouldMutate:",
        "applied: true",
        "appliedCount: lifecycleResult.afterCount",
    ]);
    if (
        cleanupExecution.indexOf(cleanupLifecycleMutationCall) >
        cleanupExecution.indexOf(cleanupDiskBudgetCall)
    ) {
        throw new Error(
            "OpenClaw sessions.cleanup no longer applies lifecycle mutation before disk budget enforcement"
        );
    }

    const maintenancePolicy = artifactByRole(
        artifacts,
        "session-maintenance-policy"
    ).contents;
    const activePreservation = boundedSourceRegion(
        maintenancePolicy,
        "/** Collects every runtime and active-work key protected from automatic maintenance. */",
        "//#endregion",
        2 * 1024,
        "session cleanup active preservation"
    );
    assertRequiredMarkers(activePreservation, "session cleanup active preservation", [
        "collectSessionMaintenancePreserveKeys(params.baseKeys)",
        "collectActiveSessionWorkAdmissionKeys({",
        "storePath: params.storePath",
        "store: params.store",
    ]);
    const entryPreservation = boundedSourceRegion(
        maintenancePolicy,
        "function isProtectedSessionMaintenanceEntry(sessionKey, entry) {",
        "function getActiveSessionMaintenanceWarning(params) {",
        4 * 1024,
        "session cleanup entry preservation"
    );
    assertRequiredMarkers(entryPreservation, "session cleanup entry preservation", [
        "if (isPrimarySessionMaintenanceKey(sessionKey)) return true",
        "if (parseSessionThreadInfoFast(sessionKey).threadId) return true",
        "if (isTelegramTopicSessionKey(sessionKey)) return true",
        "if (isExternalGroupOrChannelSessionKey(sessionKey)) return true",
        'return chatType === "group" || chatType === "channel" || chatType === "thread"',
        "if (params.entry?.archivedAt !== void 0) return true",
        "params.entry?.modelSelectionLocked === true",
        "params.preserveKeys?.has(params.key) === true",
    ]);
    const maintenanceConfig = boundedSourceRegion(
        maintenancePolicy,
        "function resolveMaintenanceConfig() {",
        "//#endregion",
        2 * 1024,
        "session cleanup maintenance config"
    );
    assertRequiredMarkers(maintenanceConfig, "session cleanup maintenance config", [
        "getRuntimeConfig().session?.maintenance",
        "return resolveMaintenanceConfigFromInput(maintenance)",
    ]);
    const artifactPruning = boundedSourceRegion(
        maintenancePolicy,
        "async function pruneUnreferencedSessionArtifacts(params) {",
        "async function enforceSessionDiskBudget(params) {",
        16 * 1024,
        "session cleanup unreferenced artifact result"
    );
    assertRequiredMarkers(
        artifactPruning,
        "session cleanup unreferenced artifact result",
        [
            "scannedFiles: files.length + promptBlobFiles.length",
            "removedFiles,",
            "freedBytes,",
            "olderThanMs",
        ]
    );
    const diskBudget = boundedSourceRegion(
        maintenancePolicy,
        "async function enforceSessionDiskBudget(params) {",
        "//#endregion",
        32 * 1024,
        "session cleanup disk budget result"
    );
    assertRequiredMarkers(diskBudget, "session cleanup disk budget result", [
        "totalBytesBefore: totalBefore",
        "totalBytesAfter: total",
        "removedFiles,",
        "removedEntries,",
        "freedBytes,",
        "maxBytes,",
        "highWaterBytes,",
        "overBudget: true",
    ]);

    const sqliteMaintenance = artifactByRole(
        artifacts,
        "session-accessor-sqlite-maintenance"
    ).contents;
    const sqliteEntryMaintenance = boundedSourceRegion(
        sqliteMaintenance,
        "function collectSqliteSessionMaintenanceBaseKeys(store, activeSessionKey) {",
        "function finalizeSqliteSessionEntryMaintenancePlansBestEffort(scope, plans) {",
        24 * 1024,
        "SQLite session cleanup preservation"
    );
    assertRequiredMarkers(sqliteEntryMaintenance, "SQLite session cleanup preservation", [
        'currentKey = normalizeStoreSessionKey(store[currentKey]?.parentSessionKey ?? "")',
        "collectSessionMaintenancePreserveKeysForStore({",
        "baseKeys: collectSqliteSessionMaintenanceBaseKeys(store, params.activeSessionKey)",
        "pruneStaleEntries(store, maintenance.pruneAfterMs",
        "capEntryCount(store, maintenance.maxEntries",
        "preserveKeys",
    ]);
    const lifecycleMutation = boundedSourceRegion(
        sqliteMaintenance,
        "async function applySqliteSessionEntryLifecycleMutation(params) {",
        "/** Purges entries owned by a deleted agent from SQLite session rows. */",
        32 * 1024,
        "SQLite cleanup lifecycle mutation"
    );
    assertRequiredMarkers(lifecycleMutation, "SQLite cleanup lifecycle mutation", [
        "if (!sqliteSessionEntriesEqual(entry, removal.expectedEntry))",
        'activeSessionKey: params.activeSessionKey ?? ""',
        "forceMaintenance: params.maintenanceOverride !== void 0",
        "maintenanceConfig: params.maintenanceOverride ? {",
    ]);

    const updateHandlers = artifactByRole(artifacts, "update-handlers").contents;
    const managedRestartPolicy = boundedSourceRegion(
        updateHandlers,
        "const MANAGED_HANDOFF_RESTART_DELAY_MS = 2e3;",
        "const updateHandlers = {",
        8 * 1024,
        "managed update restart policy"
    );
    assertRequiredMarkers(managedRestartPolicy, "managed update restart policy", [
        "const resolvedDelayMs = restartDelayMs ?? MANAGED_HANDOFF_RESTART_DELAY_MS",
        'if (supervisor !== "systemd") return resolvedDelayMs',
        "return Math.max(resolvedDelayMs, MANAGED_HANDOFF_RESTART_DELAY_MS)",
        'if (supervisor === "systemd") return Boolean(env.OPENCLAW_SYSTEMD_UNIT?.trim())',
    ]);
    const updateRunHandler = boundedSourceRegion(
        updateHandlers,
        '"update.run": async',
        "//#endregion",
        48 * 1024,
        "update.run handler"
    );
    assertRequiredMarkers(updateRunHandler, "update.run handler", [
        'assertValidParams(params, validateUpdateRunParams, "update.run", respond)',
        "const timeoutMsRaw = params.timeoutMs",
        "Math.max(1e3, Math.floor(timeoutMsRaw))",
        'const requiresManagedServiceHandoff = installSurface.kind === "global" || installSurface.kind === "git" && supervisor !== null',
        "const hasHandoffContext = supervisor ? hasManagedServiceHandoffContext(process.env, supervisor) : false",
        "const started = await startManagedServiceUpdateHandoff({",
        'ownsManagedServiceHandoff = started.status === "started"',
        "...started.pid ? { pid: started.pid } : {}",
        "command: started.command",
        'message: "Another managed update is already running; retry after it completes."',
        "managedHandoffRestart = scheduleGatewaySigusr1Restart({",
        'reason: "update.run"',
        "skipDeferral: true",
        "skipCooldown: true",
        "result = await runGatewayUpdate({",
        "allowGatewayServiceRepair: false",
        "allowGatewayActivation: false",
        "const payload = buildUpdateRestartSentinelPayload({",
        "await writeRestartSentinel(payload)",
        'const updateWasPackageSwap = result.status === "ok" && result.mode !== "git"',
        'ok: result.status === "ok" || handoff?.status === "started"',
        "result,",
        "...handoff ? { handoff } : {}",
        "restart,",
        "sentinel: {",
        "persisted: sentinelPersisted",
        "payload",
    ]);
    if (updateRunHandler.includes("respond(false")) {
        throw new Error(
            "OpenClaw update.run operational settlement changed outside the reviewed shape"
        );
    }
    assertForbiddenMarkers(updateRunHandler, "update.run replay authority", [
        "abortSignal",
        "idempotencyKey",
    ]);

    const managedHandoff = artifactByRole(artifacts, "update-managed-handoff").contents;
    assertRequiredMarkers(managedHandoff, "managed update readiness deadline", [
        "HANDOFF_READY_TIMEOUT_MS = 3e4",
    ]);
    const handoffCommand = boundedSourceRegion(
        managedHandoff,
        "function resolveUpdateCliArgv(params) {",
        "function resolveGatewayServiceRecovery(supervisor, env) {",
        8 * 1024,
        "managed update command"
    );
    assertRequiredMarkers(handoffCommand, "managed update command", [
        '"update"',
        '"--yes"',
        '"--json"',
        'updateArgs.push("--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1e3))))',
        'args.push("--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1e3))))',
    ]);
    const handoffSpawn = boundedSourceRegion(
        managedHandoff,
        "async function waitForHandoffReady(child) {",
        "function buildManagedServiceHandoffUnavailableMessage(command) {",
        24 * 1024,
        "managed update handoff"
    );
    assertRequiredMarkers(handoffSpawn, "managed update handoff", [
        "buffered.includes(HANDOFF_READY_MARKER)",
        'new Error("managed update handoff did not signal readiness within 30 seconds")',
        '"--user"',
        '"--scope"',
        '"--collect"',
        "detached: true",
        "sensitivePaths: [",
        "scriptPath",
        "paramsPath",
        "metaPath",
        "child.unref()",
        "if (active) return {",
        "...await active",
        'status: "joined"',
    ]);
    assertRequiredMarkers(managedHandoff, "managed update sensitive cleanup", [
        "function cleanupSensitiveFiles()",
        "cleanupSensitiveFiles();",
    ]);

    const updateRunner = artifactByRole(artifacts, "update-runner").contents;
    assertRequiredMarkers(updateRunner, "update result status", ['status: "ok"']);
    const updateStep = boundedSourceRegion(
        updateRunner,
        "async function runStep(opts) {",
        "function normalizeFallbackFailureReason(stepName) {",
        8 * 1024,
        "update command step"
    );
    assertRequiredMarkers(updateStep, "update command step", [
        "const { runCommand, name, argv, cwd, timeoutMs",
        "const result = await runCommand(argv, {",
        "timeoutMs,",
        "command,",
        "cwd,",
        "stdoutTail: trimLogTail(result.stdout, MAX_LOG_CHARS)",
        "stderrTail,",
    ]);
    const updateRunnerEntry = boundedSourceRegion(
        updateRunner,
        "async function runGatewayUpdate(opts = {}) {",
        "//#endregion",
        8 * 1024,
        "update runner entry"
    );
    assertRequiredMarkers(updateRunnerEntry, "update runner entry", [
        "const timeoutMs = opts.timeoutMs ?? 12e5",
        "return await runGitUpdate({",
        "return await runGlobalUpdate({",
        'status: "skipped"',
        'reason: "not-git-install"',
    ]);

    const updateSentinel = artifactByRole(artifacts, "update-sentinel").contents;
    const sentinelPayload = boundedSourceRegion(
        updateSentinel,
        "function buildUpdateRestartSentinelPayload(params) {",
        "//#endregion",
        8 * 1024,
        "update restart sentinel"
    );
    assertRequiredMarkers(sentinelPayload, "update restart sentinel", [
        'kind: "update"',
        "status: result.status",
        "message: meta.note ?? null",
        "doctorHint: formatDoctorNonInteractiveHint()",
        "root: result.root",
        "handoffId: meta.handoffId",
        "before: result.before ?? null",
        "after: result.after ?? null",
        "steps: result.steps.map((step) => ({",
        "command: step.command",
        "cwd: step.cwd",
        "stdoutTail: step.stdoutTail ?? null",
        "stderrTail: step.stderrTail ?? null",
    ]);

    return {
        domain: "operations",
        methodAccess: [
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
        ],
        methods: ["sessions.cleanup", "update.run"],
        schemaVersion: 1,
        sessionsCleanup: {
            handlerValidatesParams: true,
            method: "sessions.cleanup",
            mutation: {
                diskBudgetEnforcedAfterEntryMaintenance: true,
                entryStateRecheckedBeforeRemoval: true,
                unreferencedArtifactsPrunedOutsideWarnMode: true,
                usesSqliteLifecycleMutation: true,
            },
            outcome: {
                automaticReplaySafe: false,
                handlerTimeoutParameter: false,
                idempotencyParameter: false,
                postDispatchTransportTimeout: "outcome-unknown",
            },
            preservation: {
                activeKeyAndParentsPreserved: true,
                activeWorkAdmissionsPreserved: true,
                archivedEntriesPreserved: true,
                groupChannelAndThreadEntriesPreserved: true,
                modelSelectionLockedEntriesPreserved: true,
                primarySessionsPreserved: true,
                registeredRuntimeKeysPreserved: true,
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
                appliedStoreFields: [
                    "agentId",
                    "storePath",
                    "mode",
                    "dryRun",
                    "beforeCount",
                    "afterCount",
                    "missing",
                    "dmScopeRetired",
                    "modelRunPruned",
                    "pruned",
                    "capped",
                    "unreferencedArtifacts",
                    "diskBudget",
                    "wouldMutate",
                    "applied",
                    "appliedCount",
                ],
                diskBudgetFields: [
                    "totalBytesBefore",
                    "totalBytesAfter",
                    "removedFiles",
                    "removedEntries",
                    "freedBytes",
                    "maxBytes",
                    "highWaterBytes",
                    "overBudget",
                ],
                formattedUpstreamErrorMustBeSanitized: true,
                multiStoreFields: ["allAgents", "mode", "dryRun", "stores"],
                sensitivePaths: ["storePath", "stores[].storePath"],
                unreferencedArtifactFields: [
                    "scannedFiles",
                    "removedFiles",
                    "freedBytes",
                    "olderThanMs",
                ],
            },
            semantics: {
                activeKeyOptional: true,
                enforceTrueOverridesConfiguredMode: true,
                fixDmScopeDefaultsFalse: true,
                fixMissingDefaultsFalse: true,
                maintenanceConfigSource: "session.maintenance",
                rpcAlwaysAppliesRatherThanDryRuns: true,
            },
        },
        updateRun: {
            handlerValidatesParams: true,
            managedHandoff: {
                activeFlightJoinedWithoutSecondSpawn: true,
                detachedChild: true,
                gitRequiresSupervisor: true,
                globalInstallRequiresHandoff: true,
                readyMarkerTimeoutMs: 30_000,
                sensitiveTemporaryFilesRemoved: true,
                startedHandoffCountsAsAccepted: true,
                systemdMinimumRestartDelayMs: 2000,
                systemdRequiresUnitContext: true,
                systemdUsesUserScope: true,
            },
            method: "update.run",
            outcome: {
                automaticReplaySafe: false,
                handlerAbortSignal: false,
                idempotencyParameter: false,
                operationalErrorsUseRpcSuccess: true,
                postDispatchTransportTimeout: "outcome-unknown",
            },
            request: {
                acceptedParams: [
                    "continuationMessage",
                    "deliveryContext",
                    "note",
                    "restartDelayMs",
                    "sessionKey",
                    "timeoutMs",
                ],
                closedObject: true,
                requiredParams: [],
                restartDelayMinimumMs: 0,
                timeoutMinimumMs: 1,
            },
            response: {
                okWhenHandoffStarted: true,
                okWhenResultStatusOk: true,
                resultStatuses: ["error", "ok", "skipped"],
                sentinelPersistenceBestEffort: true,
                sensitivePaths: [
                    "handoff.command",
                    "handoff.message",
                    "handoff.pid",
                    "result.root",
                    "result.steps[].command",
                    "result.steps[].cwd",
                    "result.steps[].stderrTail",
                    "result.steps[].stdoutTail",
                    "restart.pid",
                    "sentinel.payload",
                ],
                topLevelFields: ["ok", "result", "handoff", "restart", "sentinel"],
            },
            restart: {
                directSuccessSchedulesSigusr1: true,
                managedSystemdSkipsCooldownAndDeferral: true,
                packageSwapSkipsCooldownAndDeferral: true,
            },
            timeout: {
                defaultRunnerPerStepMs: 1_200_000,
                handlerFloorMs: 1000,
                perStepRatherThanWholeOperation: true,
            },
        },
    };
}

function assertPhase4CronSemantics(
    artifacts: readonly LoadedSourceArtifact[]
): SourceAuditResult["cron"]["adapter"] {
    const systemInfo = assertSystemInfoSemantics(artifacts);
    const protocol = artifactByRole(artifacts, "protocol-schemas").contents;
    const idAliases = boundedSourceRegion(
        protocol,
        "function cronIdOrJobIdParams(extraFields) {",
        "const CronRunLogJobIdSchema",
        2 * 1024,
        "cron id aliases"
    );
    assertRequiredMarkers(idAliases, "cron id aliases", [
        "id: NonEmptyString",
        "jobId: NonEmptyString",
    ]);

    const listParams = boundedSourceRegion(
        protocol,
        "const CronListParamsSchema = closedObject({",
        "/** Empty request payload for scheduler status. */",
        4 * 1024,
        "cron.list params"
    );
    assertExactIndentedFields(
        listParams,
        1,
        [
            "agentId",
            "compact",
            "enabled",
            "includeDeliveryPreviews",
            "includeDisabled",
            "lastRunStatus",
            "limit",
            "offset",
            "query",
            "scheduleKind",
            "sortBy",
            "sortDir",
        ],
        "cron.list params"
    );
    const commonParams = boundedSourceRegion(
        protocol,
        "const CronCommonOptionalFields = {",
        "function cronIdOrJobIdParams(extraFields)",
        2 * 1024,
        "cron common mutation params"
    );
    assertExactIndentedFields(
        commonParams,
        1,
        ["agentId", "deleteAfterRun", "description", "enabled", "sessionKey"],
        "cron common mutation params"
    );
    const updateParams = boundedSourceRegion(
        protocol,
        "const CronUpdateParamsSchema = cronIdOrJobIdParams({",
        "/** Removes a cron job by id or legacy jobId alias. */",
        6 * 1024,
        "cron.update params"
    );
    assertExactIndentedFields(
        updateParams,
        1,
        ["expectedConfigRevision", "patch"],
        "cron.update params"
    );
    assertExactIndentedFields(
        updateParams,
        2,
        [
            "delivery",
            "displayName",
            "failureAlert",
            "name",
            "pacing",
            "payload",
            "schedule",
            "sessionTarget",
            "state",
            "trigger",
            "wakeMode",
        ],
        "cron.update patch"
    );
    assertRequiredMarkers(updateParams, "cron.update common patch", [
        "...CronCommonOptionalFields",
    ]);
    const failureDestinationSchema = boundedSourceRegion(
        protocol,
        "const CronFailureDestinationSchema = closedObject({",
        "const CronFailureDestinationPatchSchema = closedObject({",
        2 * 1024,
        "cron delivery failure destination"
    );
    assertExactIndentedFields(
        failureDestinationSchema,
        1,
        ["accountId", "channel", "mode", "to"],
        "cron delivery failure destination"
    );
    assertRequiredMarkers(failureDestinationSchema, "cron delivery failure destination", [
        "channel: Type.Optional(CronAnnounceChannelSchema)",
        "to: Type.Optional(NonBlankString)",
        "accountId: Type.Optional(NonEmptyString)",
        'mode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("webhook")]))',
    ]);
    const failureDestinationPatchSchema = boundedSourceRegion(
        protocol,
        "const CronFailureDestinationPatchSchema = closedObject({",
        "const CronCompletionDestinationSchema = closedObject({",
        2 * 1024,
        "cron delivery failure destination patch"
    );
    assertExactIndentedFields(
        failureDestinationPatchSchema,
        1,
        ["accountId", "channel", "mode", "to"],
        "cron delivery failure destination patch"
    );
    assertRequiredMarkers(
        failureDestinationPatchSchema,
        "cron delivery failure destination patch",
        [
            "channel: Type.Optional(Type.Union([CronAnnounceChannelSchema, Type.Null()]))",
            "to: Type.Optional(Type.Union([NonBlankString, Type.Null()]))",
            "accountId: Type.Optional(Type.Union([NonEmptyString, Type.Null()]))",
            'Type.Literal("announce")',
            'Type.Literal("webhook")',
            "Type.Null()",
        ]
    );
    const completionDestinationSchema = boundedSourceRegion(
        protocol,
        "const CronCompletionDestinationSchema = closedObject({",
        "const CronDeliverySharedProperties = {",
        1024,
        "cron delivery completion destination"
    );
    assertExactIndentedFields(
        completionDestinationSchema,
        1,
        ["mode", "to"],
        "cron delivery completion destination"
    );
    assertRequiredMarkers(
        completionDestinationSchema,
        "cron delivery completion destination",
        ['mode: Type.Literal("webhook")', "to: NonBlankString"]
    );
    const deliverySharedSchema = boundedSourceRegion(
        protocol,
        "const CronDeliverySharedProperties = {",
        "const CronDeliveryPatchSharedProperties = {",
        2 * 1024,
        "cron delivery shared fields"
    );
    assertExactIndentedFields(
        deliverySharedSchema,
        1,
        ["accountId", "bestEffort", "channel", "failureDestination", "threadId"],
        "cron delivery shared fields"
    );
    assertRequiredMarkers(deliverySharedSchema, "cron delivery shared fields", [
        "channel: Type.Optional(CronAnnounceChannelSchema)",
        "threadId: Type.Optional(Type.Union([Type.String(), Type.Number()]))",
        "accountId: Type.Optional(NonEmptyString)",
        "bestEffort: Type.Optional(Type.Boolean())",
        "failureDestination: Type.Optional(CronFailureDestinationSchema)",
    ]);
    const deliveryPatchSharedSchema = boundedSourceRegion(
        protocol,
        "const CronDeliveryPatchSharedProperties = {",
        "const CronDeliveryNoopSchema = closedObject({",
        2 * 1024,
        "cron delivery patch shared fields"
    );
    assertExactIndentedFields(
        deliveryPatchSharedSchema,
        1,
        ["accountId", "bestEffort", "channel", "failureDestination", "threadId"],
        "cron delivery patch shared fields"
    );
    assertRequiredMarkers(
        deliveryPatchSharedSchema,
        "cron delivery patch shared fields",
        [
            "channel: Type.Optional(Type.Union([CronAnnounceChannelSchema, Type.Null()]))",
            "Type.String()",
            "Type.Number()",
            "Type.Null()",
            "accountId: Type.Optional(Type.Union([NonEmptyString, Type.Null()]))",
            "bestEffort: Type.Optional(Type.Boolean())",
            "failureDestination: Type.Optional(Type.Union([CronFailureDestinationPatchSchema, Type.Null()]))",
        ]
    );
    const deliveryVariants = boundedSourceRegion(
        protocol,
        "const CronDeliveryNoopSchema = closedObject({",
        "/** Patch shape for cron delivery policy updates. */",
        4 * 1024,
        "cron delivery variants"
    );
    assertRequiredMarkers(deliveryVariants, "cron delivery variants", [
        'mode: Type.Literal("none")',
        'mode: Type.Literal("announce")',
        'mode: Type.Literal("webhook")',
        "...CronDeliverySharedProperties",
        "completionDestination: Type.Optional(CronCompletionDestinationSchema)",
        "to: Type.Optional(NonBlankString)",
        "to: NonBlankString",
        "const CronDeliverySchema = Type.Union([",
        "CronDeliveryNoopSchema",
        "CronDeliveryAnnounceSchema",
        "CronDeliveryWebhookSchema",
    ]);
    const deliveryPatchSchema = boundedSourceRegion(
        protocol,
        "const CronDeliveryPatchSchema = closedObject({",
        "const CronFailureNotificationDeliverySchema = closedObject({",
        2 * 1024,
        "cron delivery patch"
    );
    assertExactIndentedFields(
        deliveryPatchSchema,
        1,
        ["completionDestination", "mode", "to"],
        "cron delivery patch"
    );
    assertRequiredMarkers(deliveryPatchSchema, "cron delivery patch", [
        'Type.Literal("none")',
        'Type.Literal("announce")',
        'Type.Literal("webhook")',
        "...CronDeliveryPatchSharedProperties",
        "completionDestination: Type.Optional(Type.Union([CronCompletionDestinationSchema, Type.Null()]))",
        "to: Type.Optional(Type.Union([NonBlankString, Type.Null()]))",
    ]);
    const runParams = boundedSourceRegion(
        protocol,
        "const CronRunParamsSchema = cronIdOrJobIdParams({",
        "/** Query params for cron run history. */",
        2 * 1024,
        "cron.run params"
    );
    assertExactIndentedFields(
        runParams,
        1,
        ["expectedProcessInstanceId", "mode"],
        "cron.run params"
    );
    const runsParams = boundedSourceRegion(
        protocol,
        "const CronRunsParamsSchema = closedObject({",
        "closedObject({\n\tts: Type.Integer({ minimum: 0 })",
        4 * 1024,
        "cron.runs params"
    );
    assertExactIndentedFields(
        runsParams,
        1,
        [
            "agentId",
            "deliveryStatus",
            "deliveryStatuses",
            "id",
            "jobId",
            "limit",
            "offset",
            "query",
            "runId",
            "scope",
            "sortDir",
            "status",
            "statuses",
        ],
        "cron.runs params"
    );

    const jobSchema = boundedSourceRegion(
        protocol,
        "const CronJobSchema = closedObject({",
        "/** Query params for listing cron jobs with filters and pagination. */",
        8 * 1024,
        "cron job result"
    );
    assertIncludesIndentedFields(
        jobSchema,
        1,
        [
            "agentId",
            "configRevision",
            "createdAtMs",
            "delivery",
            "description",
            "enabled",
            "id",
            "name",
            "payload",
            "schedule",
            "sessionTarget",
            "state",
            "updatedAtMs",
            "wakeMode",
        ],
        "cron job result"
    );
    const scheduleSchema = boundedSourceRegion(
        protocol,
        "const CronScheduleSchema = Type.Union([",
        "/** Headless condition script evaluated before a recurring cron payload runs. */",
        8 * 1024,
        "cron schedule result"
    );
    assertRequiredMarkers(scheduleSchema, "cron schedule result", [
        'kind: Type.Literal("at")',
        "at: NonEmptyString",
        'kind: Type.Literal("every")',
        "everyMs:",
        "anchorMs:",
        'kind: Type.Literal("cron")',
        "expr: NonEmptyString",
        "tz:",
        "staggerMs:",
        'kind: Type.Literal("on-exit")',
        "command: NonEmptyString",
        'kind: Type.Literal("stream")',
        "command: Type.Array",
        "cwd:",
        "mode:",
        "match:",
        "batchMs:",
        "maxBatchBytes:",
    ]);
    const payloadHelpers = boundedSourceRegion(
        protocol,
        "function cronAgentTurnPayloadSchema(params) {",
        "/** Session target accepted by cron jobs. */",
        8 * 1024,
        "cron payload result"
    );
    assertRequiredMarkers(payloadHelpers, "cron payload result", [
        'kind: Type.Literal("agentTurn")',
        "message: params.message",
        "model:",
        "thinking:",
        "timeoutSeconds:",
        "lightContext:",
        'kind: Type.Literal("command")',
        "argv: params.argv",
        'kind: Type.Literal("script")',
        "script: params.script",
    ]);
    assertRequiredMarkers(protocol, "cron reported payload result", [
        'kind: Type.Literal("systemEvent")',
        "text: NonEmptyString",
        'kind: Type.Literal("heartbeat")',
    ]);
    const stateSchema = boundedSourceRegion(
        protocol,
        "const CronJobStateSchema = closedObject({",
        "/** Persisted cron job definition returned by scheduler list/get APIs. */",
        8 * 1024,
        "cron job state result"
    );
    assertIncludesIndentedFields(
        stateSchema,
        1,
        [
            "consecutiveErrors",
            "lastDeliveryStatus",
            "lastDurationMs",
            "lastErrorReason",
            "lastRunAtMs",
            "lastRunStatus",
            "nextRunAtMs",
            "runningAtMs",
            "streamStatus",
        ],
        "cron job state result"
    );
    const runEntrySchema = boundedSourceRegion(
        protocol,
        "const CronRunsParamsSchema = closedObject({",
        "//#region packages/gateway-protocol/src/schema/environments.ts",
        10 * 1024,
        "cron run entry result"
    );
    assertIncludesIndentedFields(
        runEntrySchema,
        1,
        [
            "deliveryStatus",
            "durationMs",
            "errorReason",
            "jobId",
            "model",
            "provider",
            "runAtMs",
            "runId",
            "status",
            "summary",
            "ts",
            "usage",
        ],
        "cron run entry result"
    );
    assertRequiredMarkers(runEntrySchema, "cron run usage result", [
        "input_tokens:",
        "output_tokens:",
        "total_tokens:",
        "cache_read_tokens:",
        "cache_write_tokens:",
    ]);

    const handlers = artifactByRole(artifacts, "cron-handlers").contents;
    assertRequiredMarkers(handlers, "cron adapter handlers", [
        '"cron.get": async',
        "respond(true, cronJobReadView(job), void 0)",
        '"cron.list": async',
        "p.compact === true",
        "jobs: page.jobs.map(compactCronListJob)",
        "p.includeDeliveryPreviews === false",
        '"cron.update": async',
        "expectedConfigRevision",
        'code: "CRON_JOB_CHANGED"',
        '"cron.remove": async',
        "if (!result.removed)",
        '"cron.run": async',
        "expectedProcessInstanceId",
        "processInstanceId: getGatewayProcessInstanceId()",
        '"cron.runs": async',
        "readCronTaskRunHistoryPage",
    ]);
    const compactJob = boundedSourceRegion(
        handlers,
        "function compactCronListJob(job) {",
        "async function assertValidCronUpdatePatch(params)",
        6 * 1024,
        "cron compact list result"
    );
    assertRequiredMarkers(compactJob, "cron compact list result", [
        "id: job.id",
        "name: job.name",
        "declarationKey:",
        "displayName:",
        "owner:",
        "enabled: job.enabled",
        "nextRunAtMs:",
        "scheduleKind:",
        "trigger:",
        "lastRunAtMs:",
        "lastRunStatus:",
        "lastRunError:",
        "lastDelivered:",
        "lastDeliveryStatus:",
        "lastDeliveryError:",
        "lastFailureNotificationDelivered:",
        "lastFailureNotificationDeliveryStatus:",
        "lastFailureNotificationDeliveryError:",
    ]);

    const deliveryNormalization = artifactByRole(
        artifacts,
        "cron-delivery-normalization"
    ).contents;
    const coerceDelivery = boundedSourceRegion(
        deliveryNormalization,
        "function coerceDelivery(delivery) {",
        "function normalizeSessionTarget(raw) {",
        8 * 1024,
        "cron delivery normalization"
    );
    assertRequiredMarkers(coerceDelivery, "cron delivery normalization", [
        'if ("channel" in delivery && delivery.channel === null) next.channel = null',
        'if ("to" in delivery && delivery.to === null) next.to = null',
        'if ("threadId" in delivery && delivery.threadId === null) next.threadId = null',
        'if ("accountId" in delivery && delivery.accountId === null) next.accountId = null',
        'if ("failureDestination" in next) if (next.failureDestination === null) next.failureDestination = null',
        'if ("completionDestination" in next) if (next.completionDestination === null) next.completionDestination = null',
        "function coerceFailureDestination(value) {",
        'if ("mode" in next) if (next.mode === null) next.mode = null',
    ]);

    const deliveryMergeSource = artifactByRole(artifacts, "cron-delivery-merge").contents;
    const deliveryMerge = boundedSourceRegion(
        deliveryMergeSource,
        "function mergeCronDelivery(existing, patch, implicitMode) {",
        "function mergeCronFailureAlert(existing, patch) {",
        12 * 1024,
        "cron delivery merge"
    );
    assertRequiredMarkers(deliveryMerge, "cron delivery merge", [
        'if (previousMode !== next.mode && (previousMode === "webhook" || next.mode === "webhook")) next.to = void 0',
        'if (next.mode === "webhook") {',
        "next.channel = void 0",
        "next.threadId = void 0",
        "next.accountId = void 0",
        'if (!hasCompletionDestinationPatch && (next.mode === "none" || next.mode === "webhook")) next.completionDestination = void 0',
        'if ("channel" in patch) next.channel = normalizeOptionalString(patch.channel)',
        'if ("to" in patch) next.to = normalizeOptionalString(patch.to)',
        'if ("threadId" in patch) next.threadId = normalizeOptionalThreadValue(patch.threadId)',
        'if ("accountId" in patch) next.accountId = normalizeOptionalString(patch.accountId)',
        "if (patch.completionDestination == null) next.completionDestination = void 0",
        "if (patch.failureDestination == null) next.failureDestination = void 0",
    ]);

    const service = artifactByRole(artifacts, "cron-service").contents;
    const listPage = boundedSourceRegion(
        service,
        "async function listPage(state, opts) {",
        "//#region src/cron/service/ops-run.ts",
        12 * 1024,
        "cron.list page result"
    );
    assertRequiredMarkers(listPage, "cron.list page result", [
        "jobs,",
        "snapshotRevision,",
        "total,",
        "offset,",
        "limit,",
        "hasMore: nextOffset < total",
        "nextOffset: nextOffset < total ? nextOffset : null",
    ]);
    assertRequiredMarkers(service, "cron.run acknowledgement", [
        'reason: "already-running"',
        'reason: "not-due"',
        'reason: "invalid-spec"',
        "async function enqueueRun(state, id, mode)",
        "ok: true",
        "enqueued: true",
        "runId",
    ]);
    assertRequiredMarkers(handlers, "cron.run invalid-spec fallback", [
        "if (isInvalidCronSessionTargetIdError(error))",
        "ok: true",
        "ran: false",
        'reason: "invalid-spec"',
    ]);

    const runHistory = artifactByRole(artifacts, "cron-run-history").contents;
    const historyPage = boundedSourceRegion(
        runHistory,
        "function readCronTaskRunHistoryPage(options) {",
        "//#region src/cron/list-snapshot-revision.ts",
        12 * 1024,
        "cron.runs page result"
    );
    assertRequiredMarkers(historyPage, "cron.runs page result", [
        "entries,",
        "total,",
        "offset: boundedOffset",
        "limit,",
        "hasMore: nextOffset < total",
        "nextOffset: nextOffset < total ? nextOffset : null",
    ]);

    const cronEvent = artifactByRole(artifacts, "cron-events").contents;
    assertRequiredMarkers(cronEvent, "cron event", [
        'params.broadcast("cron"',
        "dropIfSlow: true",
    ]);
    const descriptors = artifactByRole(artifacts, "method-descriptors").contents;
    assertMethodDescriptorScope(descriptors, "cron.get", "operator.read");
    assertMethodDescriptorScope(descriptors, "cron.list", "operator.read");
    assertMethodDescriptorScope(descriptors, "cron.remove", "operator.admin");
    assertMethodDescriptorScope(descriptors, "cron.run", "operator.admin");
    assertMethodDescriptorScope(descriptors, "cron.runs", "operator.read");
    assertMethodDescriptorScope(descriptors, "cron.update", "operator.admin");

    return {
        delivery: {
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
        },
        event: { delivery: "best-effort-drop-if-slow", name: "cron" },
        jobProjection: {
            deliveryFields: [
                "accountId",
                "bestEffort",
                "channel",
                "completionDestination",
                "failureDestination",
                "mode",
                "threadId",
                "to",
            ],
            fields: [
                "agentId",
                "configRevision",
                "createdAtMs",
                "delivery",
                "description",
                "enabled",
                "id",
                "name",
                "payload",
                "schedule",
                "sessionTarget",
                "state",
                "updatedAtMs",
                "wakeMode",
            ],
            payloadFields: [
                "argv",
                "kind",
                "lightContext",
                "message",
                "model",
                "script",
                "text",
                "thinking",
                "timeoutSeconds",
            ],
            scheduleFields: [
                "anchorMs",
                "at",
                "batchMs",
                "command",
                "cwd",
                "everyMs",
                "expr",
                "kind",
                "match",
                "maxBatchBytes",
                "mode",
                "staggerMs",
                "tz",
            ],
            stateFields: [
                "consecutiveErrors",
                "lastDeliveryStatus",
                "lastDurationMs",
                "lastErrorReason",
                "lastRunAtMs",
                "lastRunStatus",
                "nextRunAtMs",
                "runningAtMs",
                "streamStatus",
            ],
        },
        methodAccess: [
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
        ],
        operations: {
            get: {
                acceptedParams: ["id", "jobId"],
                method: "cron.get",
                requestParams: ["id"],
                result: "job-projection",
            },
            list: {
                acceptedParams: [
                    "agentId",
                    "compact",
                    "enabled",
                    "includeDeliveryPreviews",
                    "includeDisabled",
                    "lastRunStatus",
                    "limit",
                    "offset",
                    "query",
                    "scheduleKind",
                    "sortBy",
                    "sortDir",
                ],
                compactJobFields: [
                    "declarationKey",
                    "displayName",
                    "enabled",
                    "id",
                    "lastDelivered",
                    "lastDeliveryError",
                    "lastDeliveryStatus",
                    "lastFailureNotificationDelivered",
                    "lastFailureNotificationDeliveryError",
                    "lastFailureNotificationDeliveryStatus",
                    "lastRunAtMs",
                    "lastRunError",
                    "lastRunStatus",
                    "name",
                    "nextRunAtMs",
                    "owner",
                    "scheduleKind",
                    "trigger",
                ],
                compactOmittedJobFields: [
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
                ],
                fullJobProjectionRequiresCompactFalse: true,
                method: "cron.list",
                requestLiterals: { compact: false, includeDeliveryPreviews: false },
                requestParams: [
                    "compact",
                    "enabled",
                    "includeDeliveryPreviews",
                    "lastRunStatus",
                    "limit",
                    "offset",
                    "query",
                    "scheduleKind",
                    "sortBy",
                    "sortDir",
                ],
                resultFields: [
                    "hasMore",
                    "jobs",
                    "limit",
                    "nextOffset",
                    "offset",
                    "snapshotRevision",
                    "total",
                ],
            },
            remove: {
                acknowledgement: { removed: true },
                acceptedParams: ["id", "jobId"],
                method: "cron.remove",
                requestParams: ["id"],
                resultFields: ["removed"],
            },
            run: {
                acceptedParams: ["expectedProcessInstanceId", "id", "jobId", "mode"],
                acknowledgementVariants: [
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
                ],
                method: "cron.run",
                requestLiterals: { mode: "force" },
                requestParams: ["expectedProcessInstanceId", "id", "mode"],
            },
            runs: {
                acceptedParams: [
                    "agentId",
                    "deliveryStatus",
                    "deliveryStatuses",
                    "id",
                    "jobId",
                    "limit",
                    "offset",
                    "query",
                    "runId",
                    "scope",
                    "sortDir",
                    "status",
                    "statuses",
                ],
                entryFields: [
                    "deliveryStatus",
                    "durationMs",
                    "errorReason",
                    "jobId",
                    "model",
                    "provider",
                    "runAtMs",
                    "runId",
                    "status",
                    "summary",
                    "ts",
                    "usage",
                ],
                method: "cron.runs",
                requestLiterals: { scope: "job" },
                requestParams: [
                    "deliveryStatuses",
                    "id",
                    "limit",
                    "offset",
                    "scope",
                    "sortDir",
                    "statuses",
                ],
                resultFields: [
                    "entries",
                    "hasMore",
                    "limit",
                    "nextOffset",
                    "offset",
                    "total",
                ],
                usageFields: [
                    "cache_read_tokens",
                    "cache_write_tokens",
                    "input_tokens",
                    "output_tokens",
                    "total_tokens",
                ],
            },
            systemInfo,
            update: {
                acceptedParams: ["expectedConfigRevision", "id", "jobId", "patch"],
                acceptedPatchFields: [
                    "agentId",
                    "deleteAfterRun",
                    "delivery",
                    "description",
                    "displayName",
                    "enabled",
                    "failureAlert",
                    "name",
                    "pacing",
                    "payload",
                    "schedule",
                    "sessionKey",
                    "sessionTarget",
                    "state",
                    "trigger",
                    "wakeMode",
                ],
                method: "cron.update",
                requestParams: ["expectedConfigRevision", "id", "patch"],
                requestPatchFields: [
                    "delivery",
                    "description",
                    "enabled",
                    "name",
                    "payload",
                    "schedule",
                    "wakeMode",
                ],
                result: "job-projection",
            },
        },
    };
}

function extractGatewayEvents(source: string): string[] {
    const block = source.match(/const GATEWAY_EVENTS = \[([\s\S]*?)\];/u)?.[1];
    if (!block) throw new Error("OpenClaw source is missing the gateway event catalog");
    return sortedUnique(
        [...block.matchAll(/"([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)*)"/gu)].map(
            (match) => match[1]!
        )
    );
}

function selectRequiredEvents(
    gatewayEvents: readonly string[],
    selected: readonly string[]
): string[] {
    const available = new Set(gatewayEvents);
    for (const event of selected) {
        if (!available.has(event)) {
            throw new Error(`OpenClaw gateway event catalog is missing ${event}`);
        }
    }
    return sortedUnique(selected);
}

function assertChatStreamingPolicy(
    chatSource: string,
    declarationSource: string
): number {
    const chatThrottle = chatSource.match(
        /now - \(run\.deltaSentAt \?\? 0\) < (\d+)/u
    )?.[1];
    const agentThrottle = chatSource.match(/now - last < (\d+)/u)?.[1];
    if (!chatThrottle || chatThrottle !== agentThrottle) {
        throw new Error("OpenClaw chat and agent delta throttles do not match");
    }
    const throttleMs = Number(chatThrottle);
    if (!Number.isSafeInteger(throttleMs) || throttleMs <= 0) {
        throw new Error("OpenClaw chat delta throttle is invalid");
    }
    const requiredSourceMarkers = [
        'if (evt.stream === "assistant") return "assistant"',
        'if (evt.stream === "thinking") return "thinking"',
        'if (toolPhase === "start"',
        '=== "start" && (isControlUiVisible || hasSessionMessageSubscribers)',
        "flushBufferedChatDeltaIfNeeded(sessionKey, opts?.agentId",
        "chatRunState.clearRun(clientRunId)",
    ];
    for (const marker of requiredSourceMarkers) {
        if (!chatSource.includes(marker)) {
            throw new Error(
                "OpenClaw chat streaming policy changed outside the reviewed shape"
            );
        }
    }
    const terminalStart = chatSource.indexOf("const emitChatTerminal =");
    const terminalFlush = chatSource.indexOf(
        "flushBufferedChatDeltaIfNeeded(sessionKey, opts?.agentId",
        terminalStart
    );
    const terminalClear = chatSource.indexOf(
        "chatRunState.clearRun(clientRunId);",
        terminalStart
    );
    if (
        terminalStart === -1 ||
        terminalFlush < terminalStart ||
        terminalClear < terminalFlush ||
        terminalClear - terminalStart > 4096
    ) {
        throw new Error(
            "OpenClaw chat terminal handling no longer flushes before clearing state"
        );
    }
    for (const state of ["status", "delta", "final", "aborted", "error"]) {
        if (!declarationSource.includes(`state: Type.TLiteral<"${state}">`)) {
            throw new Error(
                `OpenClaw protocol declarations are missing chat state ${state}`
            );
        }
    }
    return throttleMs;
}

function assertGatewayHandshake(
    websocketSource: string,
    declarationSource: string
): void {
    const requiredWebsocketMarkers = [
        'type: "event"',
        'event: "connect.challenge"',
        'method: "connect"',
    ];
    const requiredDeclarationMarkers = [
        'type: Type.TLiteral<"hello-ok">',
        'type: Type.TLiteral<"req">',
        'type: Type.TLiteral<"res">',
        'type: Type.TLiteral<"event">',
    ];
    if (
        !requiredWebsocketMarkers.every((marker) => websocketSource.includes(marker)) ||
        !requiredDeclarationMarkers.every((marker) => declarationSource.includes(marker))
    ) {
        throw new Error("OpenClaw gateway handshake changed outside the reviewed shape");
    }
}

function assertGatewayBroadcastSequence(source: string): {
    readonly dropIfSlowAdvances: true;
    readonly firstSequence: 1;
    readonly scope: "per-client";
    readonly targetedOmitsSequence: true;
} {
    const nextSequence = "const nextSeq = (clientSeq.get(c) ?? 0) + 1";
    const slowBranch = "if (slow && opts?.dropIfSlow)";
    const advance = "if (!isTargeted) clientSeq.set(c, nextSeq)";
    const targeted = "const eventSeq = isTargeted ? void 0 : nextSeq";
    assertRequiredMarkers(source, "Gateway broadcaster sequence policy", [
        "function createGatewayBroadcaster(params)",
        "const clientSeq = /* @__PURE__ */ new WeakMap()",
        nextSequence,
        slowBranch,
        advance,
        targeted,
    ]);
    const slowIndex = source.indexOf(slowBranch);
    const slowAdvanceIndex = source.indexOf(advance, slowIndex);
    const slowContinueIndex = source.indexOf("continue;", slowIndex);
    const targetedIndex = source.indexOf(targeted, slowContinueIndex);
    const deliveredAdvanceIndex = source.indexOf(advance, targetedIndex);
    if (
        slowIndex === -1 ||
        slowAdvanceIndex < slowIndex ||
        slowContinueIndex < slowAdvanceIndex ||
        targetedIndex < slowContinueIndex ||
        deliveredAdvanceIndex < targetedIndex
    ) {
        throw new Error(
            "OpenClaw Gateway broadcast sequencing changed outside the reviewed shape"
        );
    }
    return {
        dropIfSlowAdvances: true,
        firstSequence: 1,
        scope: "per-client",
        targetedOmitsSequence: true,
    };
}

function assertGatewaySessionScopedEventsCapability(
    artifacts: readonly LoadedSourceArtifact[]
): SourceAuditResult["gateway"]["sessionScopedEvents"] {
    const clientCaps = artifactByRole(artifacts, "gateway-client-caps").contents;
    assertRequiredMarkers(clientCaps, "Gateway session-scoped event capability", [
        "const GATEWAY_CLIENT_CAPS",
        'BACKEND: "backend"',
        'SESSION_SCOPED_EVENTS: "session-scoped-events"',
    ]);
    const clientModes = artifactByRole(artifacts, "gateway-client-modes").contents;
    const modeSchema = "const GatewayClientModeSchema = Type.Enum(GATEWAY_CLIENT_MODES)";
    if (clientModes.split(modeSchema).length !== 2) {
        throw new Error(
            "OpenClaw Gateway client mode schema changed outside the reviewed shape"
        );
    }
    const connectParams = boundedSourceRegion(
        artifactByRole(artifacts, "protocol-schemas").contents,
        "const ConnectParamsSchema = closedObject({",
        "const HelloOkSchema = closedObject({",
        8 * 1024,
        "Gateway connect params"
    );
    const capsShape = "caps: Type.Optional(Type.Array(NonEmptyString, { default: [] }))";
    if (connectParams.split(capsShape).length !== 2) {
        throw new Error(
            "OpenClaw Gateway connect caps changed outside the reviewed shape"
        );
    }
    assertRequiredMarkers(connectParams, "Gateway backend connect mode", [
        "mode: GatewayClientModeSchema",
    ]);
    const connectAdmission = boundedSourceRegion(
        artifactByRole(artifacts, "gateway-connect-handler").contents,
        "const isBrowserCopilot = isBrowserCopilotClient(connectParams.client)",
        "if (isBrowserCopilot && !browserCopilotOrigin)",
        4 * 1024,
        "Gateway session-scoped capability admission"
    );
    assertRequiredMarkers(
        connectAdmission,
        "Gateway session-scoped capability admission",
        [
            "if (isBrowserCopilot &&",
            "hasGatewayClientCap(connectParams.caps, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS)",
        ]
    );
    if (connectAdmission.includes("GATEWAY_CLIENT_MODES.BACKEND")) {
        throw new Error(
            "OpenClaw Gateway unexpectedly restricts backend session-scoped capabilities"
        );
    }
    const broadcaster = artifactByRole(artifacts, "gateway-broadcaster").contents;
    const subscriptionEvents = boundedSourceRegion(
        broadcaster,
        "const SESSION_SUBSCRIPTION_EVENTS = /* @__PURE__ */ new Set([",
        "]);",
        1024,
        "Gateway session-scoped event filter"
    );
    const filteredEvents = [...subscriptionEvents.matchAll(/^\s*"([\w.]+)",?\s*$/gmu)]
        .map((match) => match[1])
        .filter((event): event is string => event !== undefined);
    const expectedEvents = ["agent", "chat", "chat.side_result", "session.observer"];
    if (JSON.stringify(filteredEvents) !== JSON.stringify(expectedEvents)) {
        throw new Error(
            "OpenClaw session-scoped event filter changed outside the reviewed shape"
        );
    }
    assertRequiredMarkers(broadcaster, "Gateway session-scoped event routing", [
        "hasGatewayClientCap(c.connect.caps, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS)",
        "SESSION_SUBSCRIPTION_EVENTS.has(event)",
        "params.sessionMessageSubscribers?.get(sessionKey).has(c.connId)",
    ]);
    return {
        backendModeAccepted: true,
        capability: "session-scoped-events",
        connectParameter: {
            defaultEmptyArray: true,
            element: "non-empty-string",
            optional: true,
        },
        filteredEvents: ["agent", "chat", "chat.side_result", "session.observer"],
        requiresSessionMessageSubscription: true,
    };
}

const reviewedAgentAccessCoreToolIds = [
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

const reviewedSkillSourceTaxonomy = [
    "agents-skills-personal",
    "agents-skills-project",
    "openclaw-bundled",
    "openclaw-extra",
    "openclaw-managed",
    "openclaw-node",
    "openclaw-workspace",
    "unknown",
] as const;

const reviewedGoogleModelAliases = [
    "gemini-3-pro=>gemini-3.1-pro-preview",
    "gemini-3-pro-preview=>gemini-3.1-pro-preview",
    "gemini-3-flash=>gemini-3-flash-preview",
    "gemini-3.1-pro=>gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite-preview=>gemini-3.1-flash-lite",
    "gemini-3.1-flash=>gemini-3-flash-preview",
    "gemini-3.1-flash-preview=>gemini-3-flash-preview",
    "gemma-4-26b=>gemma-4-26b-a4b-it",
] as const;

const reviewedTogetherModelAliases = [
    "moonshotai/Kimi-K2.5=>moonshotai/Kimi-K2.6",
] as const;

const reviewedAgentModelScopeCollections = ["defaults", "entries", "list"] as const;
const reviewedAgentSelectionFields = [
    "imageModel",
    "model",
    "pdfModel",
    "utilityModel",
    "voiceModel",
] as const;
const reviewedMediaSelectionFields = ["image", "music", "video"] as const;
const reviewedModelSelectionShapes = ["fallbacks[]", "primary", "string"] as const;
const reviewedNestedAgentModelPaths = [
    "compaction.memoryFlush.model",
    "compaction.model",
    "heartbeat.model",
    "models.<key>",
    "subagents.fallbacks[]",
    "subagents.model",
    "subagents.primary",
] as const;

function assertSourceMarkerExactlyOnce(
    source: string,
    marker: string,
    surface: string
): void {
    if (source.split(marker).length !== 2) {
        throw new Error(
            `OpenClaw ${surface} changed outside the reviewed source-backed shape`
        );
    }
}

function assertAgentAccessSemantics(
    artifacts: readonly LoadedSourceArtifact[]
): SourceAuditResult["settings"]["agentAccess"] {
    const agentConfigSchema = artifactByRole(artifacts, "agent-config-schema").contents;
    const agentEntriesSchema = boundedSourceRegion(
        agentConfigSchema,
        "//#region src/config/zod-schema.agents.ts",
        "const BindingMatchSchema = object({",
        4 * 1024,
        "agents.entries config schema"
    );
    assertRequiredMarkers(agentEntriesSchema, "agents.entries config schema", [
        "const AgentEntryConfigSchema = preprocess((value, ctx) => {",
        "if (!isBlockedObjectKey(key)) continue",
        'message: "agent entries must not contain blocked object keys"',
        "}, AgentEntrySchema.omit({ id: true }))",
        "const AgentsSchema = object({",
        'entries: record(string().regex(/^[a-z0-9_][a-z0-9_-]{0,63}$/i, "Invalid agent id"), AgentEntryConfigSchema).optional()',
        "const defaultCount = Object.values(value.entries ?? {}).filter((agent) => agent.default === true).length",
        "if (defaultCount !== 1)",
        "agents.entries must contain exactly one default=true entry",
    ]);

    const agentToolsSchema = artifactByRole(artifacts, "agent-tools-schema").contents;
    const commonToolPolicy = boundedSourceRegion(
        agentToolsSchema,
        "const CommonToolPolicyFields = {",
        "const MessageToolConfigSchema = object({",
        2 * 1024,
        "agent common tool policy"
    );
    assertRequiredMarkers(commonToolPolicy, "agent common tool policy", [
        "allow: array(string()).optional()",
        "alsoAllow: array(string()).optional()",
        "deny: array(string()).optional()",
    ]);
    const agentToolsPolicy = boundedSourceRegion(
        agentToolsSchema,
        "const AgentToolsSchema = object({",
        "const MemorySearchSchema = object({",
        4 * 1024,
        "agent tools policy"
    );
    assertRequiredMarkers(agentToolsPolicy, "agent tools policy", [
        "...CommonToolPolicyFields",
        "addAllowAlsoAllowConflictIssue(value, ctx,",
        '"agent tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)"',
    ]);
    const agentEntrySchema = boundedSourceRegion(
        agentToolsSchema,
        "const AgentEntrySchema = object({",
        "const ToolsSchema = object({",
        8 * 1024,
        "agent entry tools schema"
    );
    assertRequiredMarkers(agentEntrySchema, "agent entry tools schema", [
        "id: string()",
        "tools: AgentToolsSchema",
        "}).strict()",
    ]);

    const automationsIdentity = artifactByRole(
        artifacts,
        "automations-tool-name"
    ).contents;
    assertRequiredMarkers(automationsIdentity, "automations tool identity", [
        'const AUTOMATIONS_TOOL_NAME = "automations"',
        'const LEGACY_AUTOMATIONS_TOOL_NAMES = ["cron"]',
        'return name === "automations" || LEGACY_AUTOMATIONS_TOOL_NAMES.includes(name)',
    ]);

    const coreToolCatalog = artifactByRole(artifacts, "core-tool-catalog").contents;
    const coreToolDefinitions = boundedSourceRegion(
        coreToolCatalog,
        "const CORE_TOOL_DEFINITIONS = [",
        "const CORE_TOOL_BY_ID = new Map",
        32 * 1024,
        "core tool catalog"
    );
    assertSourceMarkerExactlyOnce(
        coreToolDefinitions,
        "id: AUTOMATIONS_TOOL_NAME",
        "core automations tool catalog entry"
    );
    for (const toolId of reviewedAgentAccessCoreToolIds) {
        if (toolId === "automations") continue;
        assertSourceMarkerExactlyOnce(
            coreToolDefinitions,
            `id: "${toolId}"`,
            `core ${toolId} tool catalog entry`
        );
    }

    const toolPolicy = artifactByRole(artifacts, "tool-policy-normalization").contents;
    assertRequiredMarkers(toolPolicy, "tool policy alias normalization", [
        "const TOOL_NAME_ALIASES = {",
        'bash: "exec"',
        'cron: "automations"',
        "function normalizeToolName(name)",
        "return TOOL_NAME_ALIASES[normalized] ?? normalized",
        "return list.map(normalizeToolName).filter(Boolean)",
    ]);

    const configHandlers = artifactByRole(artifacts, "config-handlers").contents;
    assertRequiredMarkers(configHandlers, "config.patch exact replacement intent", [
        "function formatConfigPatchPath(parentPath, key)",
        "return parentPath ? `${parentPath}.${key}` : key",
        "function normalizeConfigPatchReplacePath(value)",
        'if (trimmed.endsWith("[]")) return trimmed.slice(0, -2).replace(',
        "return trimmed.replace(",
        'return new Set(values.filter((value) => typeof value === "string").map(normalizeConfigPatchReplacePath).filter((value) => value.length > 0))',
        ").filter((path) => !params.replacePaths.has(path))",
    ]);
    const mergePatch = artifactByRole(artifacts, "config-merge-patch").contents;
    const applyMergePatch = boundedSourceRegion(
        mergePatch,
        "function applyMergePatch(base, patch, options = {}) {",
        "//#endregion",
        4 * 1024,
        "config merge-patch array replacement"
    );
    assertRequiredMarkers(applyMergePatch, "config merge-patch array replacement", [
        "const path = formatMergePatchPath(options.path, key)",
        "if (value === null) {",
        "delete result[key]",
        "if (options.replaceArrayPaths?.has(path)) {",
        "result[key] = value",
        "const mergedArray = mergeObjectArraysById(result[key], value, options, path)",
    ]);

    return {
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
            reviewedToolIds: [...reviewedAgentAccessCoreToolIds],
        },
        entries: {
            blockedObjectKeysRejected: true,
            defaultEntryCount: 1,
            idCaseInsensitive: true,
            idMaximumLength: 64,
            idMinimumLength: 1,
            idPattern: "^[a-z0-9_][a-z0-9_-]{0,63}$",
            inlineIdOmitted: true,
            storagePath: "agents.entries",
            storageShape: "record-by-id",
        },
        toolsPolicy: {
            aliases: ["bash=>exec", "cron=>automations"],
            nonEmptyAllowAndAlsoAllowConflictRejected: true,
            optionalStringArrayFields: ["allow", "alsoAllow", "deny"],
        },
    };
}

function assertSettingsSemantics(
    artifacts: readonly LoadedSourceArtifact[]
): SourceAuditResult["settings"] {
    const agentAccess = assertAgentAccessSemantics(artifacts);
    const agentToolsSchema = artifactByRole(artifacts, "agent-tools-schema").contents;
    const heartbeatSchema = boundedSourceRegion(
        agentToolsSchema,
        "const HeartbeatSchema = object({",
        "const SandboxDockerSchema = object({",
        8 * 1024,
        "agent heartbeat schema"
    );
    assertRequiredMarkers(heartbeatSchema, "agent heartbeat schema", [
        "target: string().optional()",
    ]);
    assertRequiredMarkers(agentToolsSchema, "agent heartbeat attachment", [
        "heartbeat: HeartbeatSchema",
    ]);
    const agentConfigSchema = artifactByRole(artifacts, "agent-config-schema").contents;
    const agentDefaultsSchema = boundedSourceRegion(
        agentConfigSchema,
        "const AgentDefaultsSchema = object({",
        "const AgentEntryConfigSchema = preprocess",
        32 * 1024,
        "agent heartbeat defaults schema"
    );
    assertRequiredMarkers(agentDefaultsSchema, "agent heartbeat defaults schema", [
        "heartbeat: HeartbeatSchema.unwrap().safeExtend({ agentId: string().trim().min(1).optional() }).optional()",
    ]);
    const descriptors = artifactByRole(artifacts, "method-descriptors").contents;
    assertMethodPermission(descriptors, "config.get", "operator.read", false);
    assertMethodPermission(descriptors, "config.patch", "operator.admin", true);
    assertMethodPermission(descriptors, "skills.status", "operator.read", false);
    assertMethodPermission(descriptors, "skills.update", "operator.admin", false);

    const protocol = artifactByRole(artifacts, "protocol-schemas").contents;
    const configGetParams = boundedSourceRegion(
        protocol,
        "/** Empty request payload for reading the current raw config. */",
        "/** Full raw config replacement request with optional base hash guard. */",
        1024,
        "config.get params"
    );
    assertRequiredMarkers(configGetParams, "config.get params", [
        "const ConfigGetParamsSchema = closedObject({});",
    ]);
    const configPatchParams = boundedSourceRegion(
        protocol,
        "const ConfigApplyLikeParamProperties = {",
        "/** Empty request payload for fetching the generated config schema. */",
        4 * 1024,
        "config.patch params"
    );
    assertExactIndentedFields(
        configPatchParams,
        1,
        [
            "baseHash",
            "deliveryContext",
            "note",
            "raw",
            "replacePaths",
            "restartDelayMs",
            "sessionKey",
        ],
        "config.patch params"
    );
    assertRequiredMarkers(configPatchParams, "config.patch params", [
        "raw: NonEmptyString",
        "baseHash: Type.Optional(NonEmptyString)",
        "replacePaths: Type.Optional(Type.Array(NonEmptyString, { maxItems: 256 }))",
    ]);
    const skillsStatusParams = boundedSourceRegion(
        protocol,
        "/** Reads installed skill status, optionally for a selected agent. */",
        "/** Empty request payload for listing available skill bins. */",
        1024,
        "skills.status params"
    );
    assertRequiredMarkers(skillsStatusParams, "skills.status params", [
        "const SkillsStatusParamsSchema = closedObject({ agentId: Type.Optional(NonEmptyString) });",
    ]);
    const skillsUpdateParams = boundedSourceRegion(
        protocol,
        "const SkillsUpdateParamsSchema = Type.Union([closedObject({",
        "}), closedObject({",
        2 * 1024,
        "skills.update local params"
    );
    assertExactIndentedFields(
        skillsUpdateParams,
        1,
        ["apiKey", "enabled", "env", "skillKey"],
        "skills.update local params"
    );
    assertRequiredMarkers(skillsUpdateParams, "skills.update local params", [
        "skillKey: NonEmptyString",
        "enabled: Type.Optional(Type.Boolean())",
        "apiKey: Type.Optional(Type.String())",
        "env: Type.Optional(Type.Record(NonEmptyString, Type.String()))",
    ]);

    const baseHash = artifactByRole(artifacts, "config-base-hash").contents;
    assertRequiredMarkers(baseHash, "config base hash normalization", [
        "function resolveBaseHashParam(params)",
        'if (typeof raw !== "string") return null',
        "const trimmed = raw.trim()",
        "return trimmed ? trimmed : null",
    ]);

    const getResponse = artifactByRole(artifacts, "config-get-response").contents;
    assertRequiredMarkers(getResponse, "config.get response", [
        "...redactConfigSnapshot(snapshot, uiHints)",
        "configRevisionHash: hashRuntimeConfigValue(snapshot.sourceConfig)",
        "appliedConfigHash: getRuntimeConfigAppliedHash()",
        "createConfigGetResponse(await readConfigFileSnapshot(), params.loadUiHints())",
    ]);
    assertRequiredMarkers(getResponse, "config.get response cache", [
        'if (!getHotReloadStatus || getHotReloadStatus() !== "active") return createConfigGetResponse(await readConfigFileSnapshot(), params.loadUiHints())',
        "const appliedConfigHash = getRuntimeConfigAppliedHash()",
        "const pluginRegistryVersion = getActivePluginRegistryVersion()",
        "configGetResponseCache?.getHotReloadStatus === getHotReloadStatus",
        "configGetResponseCache.appliedConfigHash === appliedConfigHash",
        "configGetResponseCache.pluginRegistryVersion === pluginRegistryVersion",
        "return await configGetResponseCache.promise",
        "const promise = (async () => createConfigGetResponse(await readConfigFileSnapshot(), params.loadUiHints()))()",
        "if (configGetResponseCache?.promise === promise) configGetResponseCache = void 0",
        "function invalidateConfigGetResponseCache()",
        "configGetResponseCache = void 0",
    ]);

    const redaction = artifactByRole(artifacts, "config-redaction").contents;
    assertRequiredMarkers(redaction, "config redaction sentinel", [
        'const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__"',
        "function redactConfigSnapshot(snapshot, uiHints)",
        "const redactedConfig = redactObject(snapshot.config, uiHints)",
        "const { pluginMetadataSnapshot: _pluginMetadataSnapshot, ...publicSnapshot } = snapshot",
        "function restoreRedactedValues(incoming, original, hints)",
        'assertNoRedactedSentinel(restored, "")',
        "throw new RedactionError(params.path)",
    ]);
    const redactedSnapshot = boundedSourceRegion(
        redaction,
        "function redactConfigSnapshot(snapshot, uiHints) {",
        "* Deep-walk `incoming`",
        8 * 1024,
        "config.get redacted snapshot"
    );
    assertRequiredMarkers(redactedSnapshot, "config.get redacted snapshot", [
        "sourceConfig: redactedResolved",
        "runtimeConfig: redactedConfig",
        "config: redactedConfig",
        "raw: redactedRaw",
        "parsed: redactedParsed",
        "resolved: redactedResolved",
        "raw: null",
        "parsed: null",
    ]);

    const configIo = artifactByRole(artifacts, "config-io").contents;
    const configSnapshotFactory = boundedSourceRegion(
        configIo,
        "function createConfigFileSnapshot(params) {",
        "async function finalizeReadConfigSnapshotInternalResult(deps, result, options) {",
        8 * 1024,
        "config snapshot projection"
    );
    assertRequiredMarkers(configSnapshotFactory, "config snapshot projection", [
        "includedPaths: [...params.includedPaths ?? []]",
        "sourceConfig,",
        "resolved: sourceConfig",
        "runtimeConfig,",
        "config: runtimeConfig",
        "hash: params.hash",
    ]);
    const configSnapshotRead = boundedSourceRegion(
        configIo,
        "function listResolvedIncludePaths(includeFilePathsForWatch) {",
        "async function readConfigFileSnapshotFromContext(context, options = {}) {",
        48 * 1024,
        "config snapshot read"
    );
    assertRequiredMarkers(configSnapshotRead, "config snapshot read", [
        "return [...includeFilePathsForWatch].toSorted()",
        'const rawHash = await deps.measure("config.snapshot.read.hash", () => hashConfigRaw$1(raw))',
        "const effectiveParsed = parsedRes.parsed",
        "resolveConfigIncludesForRead(effectiveParsed, configPath, deps, includeFileHashesForWrite, includeFileTargetsForWrite, includeFilePathsForWatch",
        'deps.measure("config.snapshot.read.env", () => resolveConfigForRead(resolved, deps.env, deps.lowerPrecedenceEnv))',
        "const rosterMigration = migratePersistedImplicitMainRoster(readResolution.resolvedConfigRaw)",
        "const effectiveConfigRaw = rosterMigration.config",
        "const snapshotRaw = raw",
        "const snapshotParsed = effectiveParsed",
        "const snapshotHash = rawHash",
        'materializeRuntimeConfig(validated.config, "snapshot"',
        "sourceConfig: coerceConfig(effectiveConfigRaw)",
        "runtimeConfig: snapshotConfig",
        "includedPaths: listResolvedIncludePaths(includeFilePathsForWatch)",
    ]);
    const configEnvironmentRead = boundedSourceRegion(
        configIo,
        "function resolveConfigForRead(resolvedIncludes, env, lowerPrecedenceEnv = {}) {",
        "function snapshotEnv(env) {",
        2 * 1024,
        "config environment read"
    );
    assertRequiredMarkers(configEnvironmentRead, "config environment read", [
        "resolvedConfigRaw: resolveConfigEnvVars(resolvedIncludes, env",
        "envSnapshotForRestore: { ...env }",
    ]);
    const configEnvironmentRestore = boundedSourceRegion(
        configIo,
        "function restoreEnvVarRefs(incoming, parsed, env = process.env) {",
        "function parentPath(value) {",
        8 * 1024,
        "config environment reference restoration"
    );
    assertRequiredMarkers(
        configEnvironmentRestore,
        "config environment reference restoration",
        [
            "if (tryResolveString(parsed, env) === incoming) return parsed",
            "return incoming",
        ]
    );
    const configWrite = boundedSourceRegion(
        configIo,
        "function hasJSON5Comments(raw) {",
        "//#region src/config/io.factory.ts",
        64 * 1024,
        "config root write"
    );
    assertRequiredMarkers(configWrite, "config root write", [
        "return true",
        "function warnIfJSON5CommentsWillBeStripped(params)",
        "`Config write will strip JSON5 comments from ${params.filePath}.`",
        String.raw`const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n")`,
        "const nextHash = hashConfigRaw$1(json)",
        "persistedHash: nextHash",
        "persistedConfig: stampedOutputConfig",
    ]);
    const configWriteDispatch = boundedSourceRegion(
        configIo,
        "async function writeConfigFile(cfg, options = {}) {",
        "async function finalizeCommittedConfigWrite(params) {",
        32 * 1024,
        "config post-commit dispatch"
    );
    assertRequiredMarkers(configWriteDispatch, "config post-commit dispatch", [
        "const writeResult = await io.writeConfigFile(nextCfg, {",
        "return await finalizeCommittedConfigWrite({",
        "writeResult,",
    ]);
    const configWriteSettlement = boundedSourceRegion(
        configIo,
        "async function finalizeCommittedConfigWrite(params) {",
        "//#endregion",
        32 * 1024,
        "config post-commit settlement"
    );
    assertRequiredMarkers(configWriteSettlement, "config post-commit settlement", [
        "const freshSnapshot = await io.readConfigFileSnapshot()",
        "await finalizeRuntimeSnapshotWrite({",
        "if (await rollbackConfigFileWriteIfUnchanged({",
        "committedHash: writeResult.persistedHash",
        "writeResult[configWritePostCommitRollback]?.()",
        "throw new ConfigRuntimeRefreshError(`${formatErrorMessage(error)} Rollback failed: ${formatErrorMessage(rollbackError)}`, { cause: error })",
        "throw error",
    ]);

    const configMutation = artifactByRole(artifacts, "config-mutation").contents;
    const includeTargetMutation = boundedSourceRegion(
        configMutation,
        "async function tryWriteSingleTopLevelIncludeMutation(params) {",
        "function resolveConfigWriteResult(result, fallbackConfig) {",
        24 * 1024,
        "included config mutation"
    );
    assertRequiredMarkers(includeTargetMutation, "included config mutation", [
        'if (changedKeys.length !== 1 || changedKeys[0] === "<root>") return null',
        "const includePath = getSingleTopLevelIncludeTarget({",
        "await writeRootBoundJsonFile({",
        "refreshed = await readConfigSnapshotForMutation({",
        "const persistedHash = resolveConfigSnapshotHash(refreshedSnapshot)",
        "persistedHash,",
        "persistedConfig: refreshedSnapshot.sourceConfig",
    ]);

    const configHandlers = artifactByRole(artifacts, "config-handlers").contents;
    const configGetHandler = boundedSourceRegion(
        configHandlers,
        '"config.get": async',
        '"config.schema":',
        2 * 1024,
        "config.get handler"
    );
    assertRequiredMarkers(configGetHandler, "config.get handler", [
        'assertValidParams(params, validateConfigGetParams, "config.get", respond)',
        "respond(true, await readConfigGetResponse({",
        "loadUiHints: () => loadSchemaWithPlugins().uiHints",
    ]);
    const configPatchHandler = boundedSourceRegion(
        configHandlers,
        '"config.patch": async',
        '"config.apply": async',
        48 * 1024,
        "config.patch handler"
    );
    assertRequiredMarkers(configPatchHandler, "config.patch handler", [
        'assertValidParams(params, validateConfigPatchParams, "config.patch", respond)',
        "const hashlessPatch = resolveBaseHashParam(params) === null",
        "const normalizedPatch = normalizeSubmittedConfigModelRefs(parsedRes.parsed, modelIdNormalizationPolicies)",
        "if (hashlessPatch && !hasHashlessPatchLwwStructure(normalizedPatch))",
        "applyMergePatch(snapshot.config, normalizedPatch, {",
        "mergeObjectArraysById: true",
        "replaceArrayPaths: replacePaths",
        "restoreRedactedValues(merged, snapshot.config, schemaPatch.uiHints)",
        "if (hashlessPatch && !restoredChangedPaths.every(isHashlessPatchLwwPath))",
        "const validationCandidate = normalizeSubmittedConfigModelRefs(stripBundledProviderRuntimeDefaults({",
        "candidate: restoredMerge.result",
        "sourceConfig: snapshot.sourceConfig",
        "const sourceValidated = validateConfigObjectRawWithPlugins(validationCandidate)",
        "const writeConfig = validationCandidate",
        "const validated = validateConfigObjectWithPlugins(validationCandidate)",
        "respondConfigPatchNoop({",
        "await respondWithConfigRestartWrite({",
    ]);
    assertRequiredMarkers(configHandlers, "config.get write invalidation", [
        "async function commitGatewayConfigWrite(params)",
        "config: result.nextConfig",
        "hash: result.persistedHash",
        "invalidateConfigGetResponseCache()",
    ]);

    const channelsSchema = boundedSourceRegion(
        artifactByRole(artifacts, "channel-config-schema").contents,
        "const ChannelsSchema = object({",
        "//#endregion",
        4 * 1024,
        "channel config schema"
    );
    assertExactIndentedFields(
        channelsSchema,
        1,
        ["defaults", "modelByChannel"],
        "channel reserved config keys"
    );
    assertRequiredMarkers(channelsSchema, "channel config schema", [
        "}).passthrough().superRefine((value, ctx) => {",
    ]);
    const channelEnabledDefault = boundedSourceRegion(
        artifactByRole(artifacts, "channel-enabled-default").contents,
        "function isConfiguredChannel(cfg, channelId) {",
        "function listConfiguredOfficialExternalRepairHints(cfg) {",
        2 * 1024,
        "channel enabled default"
    );
    assertRequiredMarkers(channelEnabledDefault, "channel enabled default", [
        "const entry = channels[channelId]",
        "return entry.enabled !== false",
    ]);

    const modelInputNormalization = artifactByRole(
        artifacts,
        "model-input-normalization"
    ).contents;
    const modelSelectionKeysRegion = boundedSourceRegion(
        modelInputNormalization,
        "const MODEL_SELECTION_KEYS = [",
        "];",
        1024,
        "model selection keys"
    );
    const observedModelSelectionKeys = [
        ...modelSelectionKeysRegion.matchAll(/^\s*"([A-Za-z]+)",?\s*$/gmu),
    ].map((match) => match[1]!);
    if (
        JSON.stringify(observedModelSelectionKeys) !==
        JSON.stringify(["model", "imageModel", "voiceModel", "pdfModel"])
    ) {
        throw new Error("OpenClaw model selection keys changed");
    }
    const mediaModelKeysRegion = boundedSourceRegion(
        modelInputNormalization,
        "const MEDIA_MODEL_KEYS = [",
        "];",
        1024,
        "media model keys"
    );
    const observedMediaModelKeys = [
        ...mediaModelKeysRegion.matchAll(/^\s*"([A-Za-z]+)",?\s*$/gmu),
    ].map((match) => match[1]!);
    if (
        JSON.stringify(observedMediaModelKeys) !==
        JSON.stringify(["image", "video", "music"])
    ) {
        throw new Error("OpenClaw media model keys changed");
    }
    const modelSelectionNormalization = boundedSourceRegion(
        modelInputNormalization,
        "function normalizeModelSelection(value) {",
        "function normalizeStringModelRef(value) {",
        4 * 1024,
        "model selection normalization"
    );
    assertRequiredMarkers(modelSelectionNormalization, "model selection normalization", [
        'if (typeof value === "string") return normalizeAgentModelRefForConfig(value)',
        'if (typeof value.primary === "string") assign("primary", normalizeAgentModelRefForConfig(value.primary))',
        "if (Array.isArray(value.fallbacks))",
        "normalizeAgentModelRefForConfig(fallback)",
    ]);
    const agentModelScopeNormalization = boundedSourceRegion(
        modelInputNormalization,
        "function normalizeAgentModelScope(value) {",
        "function normalizeAgentScopes(agents) {",
        12 * 1024,
        "agent model scope normalization"
    );
    assertRequiredMarkers(
        agentModelScopeNormalization,
        "agent model scope normalization",
        [
            "for (const key of MODEL_SELECTION_KEYS)",
            'assign("utilityModel", normalizeStringModelRef(value.utilityModel))',
            "for (const key of MEDIA_MODEL_KEYS)",
            'assign("heartbeat", normalizeNestedModelField(value.heartbeat, "model", normalizeStringModelRef))',
            'assign("subagents", normalizeNestedModelField(value.subagents, "model", normalizeModelSelection))',
            'normalizeNestedModelField(value.compaction, "model", normalizeStringModelRef)',
            'normalizeNestedModelField(compaction.memoryFlush, "model", normalizeStringModelRef)',
            'assign("models", normalizeAgentModelMapForConfig(value.models))',
        ]
    );
    const agentScopesNormalization = boundedSourceRegion(
        modelInputNormalization,
        "function normalizeAgentScopes(agents) {",
        "function normalizeProviderCatalogs(models, modelIdNormalizationPolicies) {",
        8 * 1024,
        "agent scopes model normalization"
    );
    assertRequiredMarkers(agentScopesNormalization, "agent scopes model normalization", [
        'Object.hasOwn(agents, "defaults")',
        'assign("defaults", normalizeAgentModelScope(agents.defaults))',
        "if (isRecord(agents.entries))",
        "Object.entries(agents.entries).map",
        "normalizeAgentModelScope(entry)",
        "if (Array.isArray(agents.list))",
        "originalList.map(normalizeAgentModelScope)",
    ]);
    const providerCatalogNormalization = boundedSourceRegion(
        modelInputNormalization,
        "function normalizeProviderCatalogs(models, modelIdNormalizationPolicies) {",
        "/** Canonicalize model refs submitted through a config mutation API before persistence. */",
        8 * 1024,
        "provider catalog model normalization"
    );
    assertRequiredMarkers(
        providerCatalogNormalization,
        "provider catalog model normalization",
        [
            "isRecord(models.providers)",
            "Object.entries(models.providers).map",
            "Array.isArray(providerValue.models)",
            'typeof model.id !== "string"',
            "normalizeConfiguredProviderCatalogModelId(providerId, trimmed, modelIdNormalizationPolicies)",
        ]
    );
    const submittedModelNormalization = boundedSourceRegion(
        modelInputNormalization,
        "function normalizeSubmittedConfigModelRefs(cfg, modelIdNormalizationPolicies) {",
        "//#endregion",
        4 * 1024,
        "submitted config model normalization"
    );
    assertRequiredMarkers(
        submittedModelNormalization,
        "submitted config model normalization",
        [
            "const agents = normalizeAgentScopes(cfg.agents)",
            "const models = normalizeProviderCatalogs(cfg.models, modelIdNormalizationPolicies)",
        ]
    );
    const modelRefNormalizationArtifact = artifactByRole(
        artifacts,
        "model-ref-normalization"
    ).contents;
    const googleProviderIds = boundedSourceRegion(
        modelRefNormalizationArtifact,
        "const GOOGLE_PROVIDER_IDS = /* @__PURE__ */ new Set([",
        "]);",
        1024,
        "model ref Google providers"
    );
    const observedGoogleProviderIds = [
        ...googleProviderIds.matchAll(/^\s*"([a-z-]+)",?\s*$/gmu),
    ].map((match) => match[1]!);
    if (
        JSON.stringify(observedGoogleProviderIds) !==
        JSON.stringify(["google", "google-gemini-cli", "google-vertex"])
    ) {
        throw new Error("OpenClaw model ref Google providers changed");
    }
    const modelRefNormalization = boundedSourceRegion(
        modelRefNormalizationArtifact,
        "function normalizeAgentModelRefForConfig(model) {",
        "function mergeAgentModelEntryForConfig(existing, incoming) {",
        4 * 1024,
        "model ref normalization"
    );
    assertRequiredMarkers(modelRefNormalization, "model ref normalization", [
        'GOOGLE_PROVIDER_IDS.has(provider) || modelSuffix.startsWith("google/") ? normalizeGooglePreviewModelId(modelSuffix)',
        'provider === "together" ? normalizeTogetherModelId(modelSuffix)',
    ]);
    const providerModelIdNormalization = artifactByRole(
        artifacts,
        "provider-model-id-normalization"
    ).contents;
    const googleModelIdNormalization = boundedSourceRegion(
        providerModelIdNormalization,
        "function normalizeGooglePreviewModelId(id) {",
        "function normalizeTogetherModelId(id) {",
        4 * 1024,
        "Google model id normalization"
    );
    assertRequiredMarkers(googleModelIdNormalization, "Google model id normalization", [
        'if (id === "gemini-3-pro" || id === "gemini-3-pro-preview") return "gemini-3.1-pro-preview"',
        'if (id === "gemini-3-flash") return "gemini-3-flash-preview"',
        'if (id === "gemini-3.1-pro") return "gemini-3.1-pro-preview"',
        'if (id === "gemini-3.1-flash-lite-preview") return "gemini-3.1-flash-lite"',
        'if (id === "gemini-3.1-flash" || id === "gemini-3.1-flash-preview") return "gemini-3-flash-preview"',
        'if (id === "gemma-4-26b") return "gemma-4-26b-a4b-it"',
    ]);
    if ([...googleModelIdNormalization.matchAll(/\bif \(/gu)].length !== 7) {
        throw new Error("OpenClaw Google model id aliases changed");
    }
    const togetherModelIdNormalization = boundedSourceRegion(
        providerModelIdNormalization,
        "function normalizeTogetherModelId(id) {",
        "function normalizeAntigravityPreviewModelId(id) {",
        1024,
        "Together model id normalization"
    );
    assertRequiredMarkers(
        togetherModelIdNormalization,
        "Together model id normalization",
        ['if (id === "moonshotai/Kimi-K2.5") return "moonshotai/Kimi-K2.6"', "return id"]
    );
    if ([...togetherModelIdNormalization.matchAll(/\bif \(/gu)].length !== 1) {
        throw new Error("OpenClaw Together model id aliases changed");
    }

    const elevatedPermissions = boundedSourceRegion(
        artifactByRole(artifacts, "elevated-tool-runtime").contents,
        "function resolveElevatedPermissions(params) {",
        "function collapseInlineHorizontalWhitespace(value) {",
        16 * 1024,
        "elevated tool defaults"
    );
    assertRequiredMarkers(elevatedPermissions, "elevated tool defaults", [
        "const globalEnabled = globalConfig?.enabled !== false",
        "const agentEnabled = agentConfig?.enabled !== false",
        "const enabled = globalEnabled && agentEnabled",
    ]);
    const agentToAgentPolicy = boundedSourceRegion(
        artifactByRole(artifacts, "agent-to-agent-runtime").contents,
        "function createAgentToAgentPolicy(cfg) {",
        "function actionPrefix(action) {",
        8 * 1024,
        "agent-to-agent default"
    );
    assertRequiredMarkers(agentToAgentPolicy, "agent-to-agent default", [
        "const enabled = routingA2A?.enabled === true",
        "if (!enabled) return false",
    ]);

    const webFetchEnabled = boundedSourceRegion(
        artifactByRole(artifacts, "web-fetch-runtime").contents,
        "function resolveWebFetchEnabled(params) {",
        "function resolveFetchConfig(config) {",
        1024,
        "web_fetch enabled default"
    );
    assertRequiredMarkers(webFetchEnabled, "web_fetch enabled default", [
        'if (typeof params.fetch?.enabled === "boolean") return params.fetch.enabled',
        "return true",
    ]);
    const webSearchEnabled = boundedSourceRegion(
        artifactByRole(artifacts, "web-search-runtime").contents,
        "function resolveWebSearchEnabled(params) {",
        "function hasEntryCredential(provider, config, search, agentDir) {",
        1024,
        "web_search enabled default"
    );
    assertRequiredMarkers(webSearchEnabled, "web_search enabled default", [
        'if (typeof params.search?.enabled === "boolean") return params.search.enabled',
        "if (params.sandboxed) return true",
        "return true",
    ]);

    const resetPolicy = artifactByRole(artifacts, "session-reset-policy").contents;
    const sessionResetPolicy = boundedSourceRegion(
        resetPolicy,
        "function resolveSessionResetPolicy(params) {",
        "/** Evaluates whether a persisted session is still fresh under the resolved reset policy. */",
        8 * 1024,
        "session reset policy"
    );
    assertRequiredMarkers(sessionResetPolicy, "session reset policy", [
        "const configured = Boolean(baseReset || typeReset)",
        'const inheritedTypeMode = typeReset && baseReset?.mode !== "none" ? baseReset?.mode : void 0',
        'const mode = typeReset?.mode ?? inheritedTypeMode ?? (typeReset ? "daily" : void 0) ?? baseReset?.mode ?? (baseReset ? "daily" : DEFAULT_RESET_MODE)',
        "const atHour = normalizeResetAtHour(typeReset?.atHour ?? baseReset?.atHour ?? DEFAULT_RESET_AT_HOUR)",
        'else if (mode === "idle") idleMinutes = 0',
    ]);

    const execDefaults = artifactByRole(artifacts, "exec-defaults-runtime").contents;
    const execConfigState = boundedSourceRegion(
        execDefaults,
        "function resolveExecConfigState(params) {",
        "/** Resolves whether node exec is usable and any effective node binding. */",
        4 * 1024,
        "exec config defaults"
    );
    assertRequiredMarkers(execConfigState, "exec config defaults", [
        'globalExec?.host ?? "auto"',
    ]);
    const execDefaultResolution = boundedSourceRegion(
        execDefaults,
        "function resolveExecDefaults(params) {",
        "//#endregion",
        16 * 1024,
        "exec effective defaults"
    );
    assertRequiredMarkers(execDefaultResolution, "exec effective defaults", [
        'const defaultSecurity = resolved.effectiveHost === "sandbox" ? "deny" : "full"',
        'const approvalDefaults = resolved.effectiveHost === "sandbox" ? void 0 : resolveExecApprovalsFromFile({',
        'ask: "off"',
        "applyExecPolicyLayer(applySessionLegacyExecPolicyLayer(applyExecPolicyLayer(applyExecPolicyLayer({",
        "}, globalExec), agentExec), params.sessionEntry), params.execOverrides)",
        "const security = approvalDefaults?.security !== void 0 ? minSecurity(modePolicy.security, approvalDefaults.security) : modePolicy.security",
        "const ask = approvalDefaults?.ask !== void 0 ? maxAsk(modePolicy.ask, approvalDefaults.ask) : modePolicy.ask",
    ]);
    const execModePolicy = boundedSourceRegion(
        artifactByRole(artifacts, "exec-mode-policy").contents,
        "function resolveExecPolicyForMode(mode) {",
        "const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS",
        8 * 1024,
        "exec mode policy"
    );
    const observedExecModePolicies = [
        ...execModePolicy.matchAll(
            /case "([a-z]+)": return \{\s*security: "([a-z-]+)",\s*ask: "([a-z-]+)",\s*autoReview: (true|false)\s*\};/gu
        ),
    ]
        .map(
            (match) =>
                `${match[1]}:${match[2]}:${match[3]}:${match[4] === "true" ? "auto-review" : "no-auto-review"}`
        )
        .toSorted(compareStrings);
    const reviewedExecModePolicies = [
        "allowlist:allowlist:off:no-auto-review",
        "ask:allowlist:on-miss:no-auto-review",
        "auto:allowlist:on-miss:auto-review",
        "deny:deny:off:no-auto-review",
        "full:full:off:no-auto-review",
    ] as const;
    if (
        JSON.stringify(observedExecModePolicies) !==
        JSON.stringify(reviewedExecModePolicies)
    ) {
        throw new Error("OpenClaw exec mode policy changed");
    }
    assertRequiredMarkers(execModePolicy, "exec mode policy", [
        "if (!params.mode) return {",
        "mode: resolveExecModeFromPolicy({",
        "autoReview: false",
    ]);
    assertRequiredMarkers(configHandlers, "config.patch base hash", [
        'const HASHLESS_PATCH_LWW_PATH_PREFIXES = ["ui.prefs"]',
        "if (baseHash !== snapshotHash)",
        'errorShape(ErrorCodes.INVALID_REQUEST, "config changed since last load; re-run config.get and retry")',
        "baseHash: resolveConfigSnapshotHash(params.snapshot) ?? void 0",
    ]);
    assertRequiredMarkers(configHandlers, "config.patch restart sentinel", [
        "const sentinelPersisted = await tryWriteRestartSentinelPayload(payload)",
        "const restart = restartRequirement.scheduleDirectRestart ? scheduleGatewaySigusr1Restart({",
        "changedPaths: params.changedPaths",
        "sentinel: {",
        "persisted: sentinelPersisted",
        "payload",
    ]);
    const restartSentinelPayload = boundedSourceRegion(
        configHandlers,
        "function buildConfigRestartSentinelPayload(params) {",
        "async function tryWriteRestartSentinelPayload(payload) {",
        2 * 1024,
        "config.patch restart sentinel payload"
    );
    assertRequiredMarkers(
        restartSentinelPayload,
        "config.patch restart sentinel payload",
        ["stats: {", "requiresRestart: params.requiresRestart"]
    );
    const restartWriteResponse = boundedSourceRegion(
        configHandlers,
        "async function respondWithConfigRestartWrite(params) {",
        "function shouldDisconnectSharedAuthClientsForConfigWrite(params) {",
        4 * 1024,
        "config.patch restart response"
    );
    assertRequiredMarkers(restartWriteResponse, "config.patch restart response", [
        "path: params.writeResult.path",
        "...params.writeResult.hash ? { hash: params.writeResult.hash } : {}",
        "config: redactConfigObject(params.writeResult.config, params.uiHints)",
        "sentinel: {",
        "persisted: sentinelPersisted",
        "payload",
    ]);

    const restartScheduler = boundedSourceRegion(
        artifactByRole(artifacts, "gateway-restart-scheduler").contents,
        "function scheduleGatewaySigusr1Restart(opts) {",
        "//#endregion",
        16 * 1024,
        "Gateway restart scheduler"
    );
    const schedulerResultFields = [
        "coalesced",
        "cooldownMsApplied",
        "delayMs",
        "emitHooksQueued",
        "mode",
        "ok",
        "pid",
        "reason",
        "signal",
    ] as const;
    const schedulerLines = restartScheduler.split(/\r?\n/u);
    const schedulerReturnBodies: string[][] = [];
    for (let index = 0; index < schedulerLines.length; index += 1) {
        if (schedulerLines[index]?.trim() !== "return {") continue;
        const body: string[] = [];
        for (index += 1; index < schedulerLines.length; index += 1) {
            const line = schedulerLines[index]!;
            if (line.trim() === "};") break;
            body.push(line.trim());
        }
        schedulerReturnBodies.push(body);
    }
    if (schedulerReturnBodies.length === 0) {
        throw new Error("OpenClaw Gateway restart scheduler success shape changed");
    }
    for (const body of schedulerReturnBodies) {
        const fields = body
            .map((line) => /^([A-Za-z_$][A-Za-z0-9_$]*)(?::|,|$)/u.exec(line)?.[1])
            .filter((field): field is string => field !== undefined)
            .toSorted(compareStrings);
        if (
            fields.length !== body.length ||
            JSON.stringify(fields) !== JSON.stringify(schedulerResultFields) ||
            !body.includes("ok: true,")
        ) {
            throw new Error("OpenClaw Gateway restart scheduler success shape changed");
        }
    }

    const skillDiscovery = artifactByRole(artifacts, "skills-discovery").contents;
    const localSkillDiscovery = boundedSourceRegion(
        skillDiscovery,
        "function loadSkillEntries(workspaceDir, opts) {",
        "function filterArchivedSkillEntries(entries) {",
        48 * 1024,
        "skill source discovery"
    );
    const remoteSkillDiscovery = boundedSourceRegion(
        skillDiscovery,
        "function mergeRemoteNodeSkillEntries(localEntries, options) {",
        "function resetRemoteNodeSkillsForTests() {",
        16 * 1024,
        "remote skill source discovery"
    );
    const discoveredSources = sortedUnique(
        [localSkillDiscovery, remoteSkillDiscovery].flatMap((region) =>
            [...region.matchAll(/source: "([a-z-]+)"/gu)].map((match) => match[1]!)
        )
    );
    const skillSourceResolution = boundedSourceRegion(
        artifactByRole(artifacts, "skills-source-resolution").contents,
        "function resolveSkillSource(skill) {",
        "function resolveSkillTelemetrySourceValue(value) {",
        2 * 1024,
        "skill source resolution"
    );
    assertRequiredMarkers(skillSourceResolution, "skill source resolution", [
        'const canonical = normalizeOptionalString(compatSkill.source) ?? ""',
        "if (canonical) return canonical",
        'return (normalizeOptionalString(compatSkill.sourceInfo?.source) ?? "") || "unknown"',
    ]);
    const sourceTaxonomy = sortedUnique([...discoveredSources, "unknown"]);
    if (JSON.stringify(sourceTaxonomy) !== JSON.stringify(reviewedSkillSourceTaxonomy)) {
        throw new Error("OpenClaw skill source taxonomy changed");
    }
    const skillKeyResolution = boundedSourceRegion(
        artifactByRole(artifacts, "skill-key-resolution").contents,
        "function resolveSkillKey(skill, entry) {",
        "//#endregion",
        1024,
        "skill key resolution"
    );
    assertRequiredMarkers(skillKeyResolution, "skill key resolution", [
        "return entry?.metadata?.skillKey ?? skill.name",
    ]);
    const skillIndex = boundedSourceRegion(
        artifactByRole(artifacts, "skills-index").contents,
        "function createSkillIndexEntry(entry, opts, agentSkillSet) {",
        "//#endregion",
        4 * 1024,
        "skill source index"
    );
    assertRequiredMarkers(skillIndex, "skill source index", [
        "const skillKey = resolveSkillKey(entry.skill, entry)",
        "const source = resolveSkillSource(entry.skill)",
        'bundled: source === "openclaw-bundled" || source === "unknown" && opts?.bundledNames?.has(name) === true',
    ]);

    const mergePatch = artifactByRole(artifacts, "config-merge-patch").contents;
    const mergePatchKeyPolicy = boundedSourceRegion(
        mergePatch,
        "function isMergePatchObjectKeyAllowed(key, parentPath) {",
        "function mergeObjectArraysById(base, patch, options, arrayPath) {",
        1024,
        "config merge-patch blocked-key policy"
    );
    assertRequiredMarkers(mergePatchKeyPolicy, "config merge-patch blocked-key policy", [
        "if (!isBlockedObjectKey(key)) return true",
        'return parentPath === "browser.profiles" && (key === "constructor" || key === "prototype")',
    ]);

    const skillsHandlers = artifactByRole(artifacts, "skills-handlers").contents;
    const skillsWorkspace = boundedSourceRegion(
        skillsHandlers,
        "function resolveSkillsAgentWorkspace(params, context) {",
        "const SKILL_PROPOSAL_RESPONSE_HANDLED",
        4 * 1024,
        "skills workspace resolution"
    );
    assertRequiredMarkers(skillsWorkspace, "skills workspace resolution", [
        "const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg)",
        "if (agentIdRaw && !listAgentIds(cfg).includes(agentId))",
        "workspaceDir: resolveAgentWorkspaceDir(cfg, agentId)",
    ]);
    const skillsStatusHandler = boundedSourceRegion(
        skillsHandlers,
        '"skills.status":',
        '"skills.securityVerdicts":',
        2 * 1024,
        "skills.status handler"
    );
    assertRequiredMarkers(skillsStatusHandler, "skills.status handler", [
        'assertValidParams(params, validateSkillsStatusParams, "skills.status", respond)',
        "const resolved = resolveSkillsAgentWorkspace(params, context)",
        "respond(true, buildRemoteAwareWorkspaceSkillStatus(resolved), void 0)",
    ]);
    assertRequiredMarkers(skillsHandlers, "skills.status remote eligibility", [
        "function buildRemoteAwareWorkspaceSkillStatus(resolved)",
        "nodeSkills = resolveNodeExecEligibility({",
        "remote: getRemoteSkillEligibility({ advertiseExecNode: nodeSkills.canExec })",
    ]);

    const skillMutation = boundedSourceRegion(
        skillsHandlers,
        "function patchSkillConfigEntry(cfg, skillKey, patch) {",
        "async function updateSkillConfigEntry(params) {",
        4 * 1024,
        "skills.update mutation"
    );
    assertRequiredMarkers(skillMutation, "skills.update mutation", [
        "const entries = { ...cfg.skills?.entries }",
        "const current = entries[skillKey] ? { ...entries[skillKey] } : {}",
        'if (typeof patch.enabled === "boolean") current.enabled = patch.enabled',
        'if (typeof patch.apiKey === "string") {',
        "const trimmed = normalizeSecretInput(patch.apiKey)",
        'if (trimmed === "__OPENCLAW_REDACTED__")',
        "else if (trimmed) current.apiKey = trimmed",
        "else delete current.apiKey",
        'if (patch.env && typeof patch.env === "object")',
        "const trimmedKey = key.trim()",
        "if (!trimmedKey) continue",
        "const trimmedVal = value.trim()",
        'if (trimmedVal === "__OPENCLAW_REDACTED__") continue',
        "if (!trimmedVal) delete nextEnv[trimmedKey]",
        "else nextEnv[trimmedKey] = trimmedVal",
        "entries[skillKey] = current",
        "...cfg",
        "...cfg.skills",
        "entries",
    ]);
    const updateSkillConfigEntry = boundedSourceRegion(
        skillsHandlers,
        "async function updateSkillConfigEntry(params) {",
        "//#endregion",
        2 * 1024,
        "skills.update config write"
    );
    assertRequiredMarkers(updateSkillConfigEntry, "skills.update config write", [
        "mutateConfigFileWithRetry({",
        'afterWrite: { mode: "auto" }',
        "const next = patchSkillConfigEntry(draft, params.skillKey, params)",
        "Object.assign(draft, next)",
        "return next.skills?.entries?.[params.skillKey] ?? {}",
        "})).result ?? {}",
    ]);
    assertForbiddenMarkers(updateSkillConfigEntry, "skills.update config write", [
        "normalizeSubmittedConfigModelRefs",
    ]);
    const configMutationRetry = boundedSourceRegion(
        configMutation,
        "async function transformConfigFileWithRetry(params) {",
        "async function mutateConfigFile(params) {",
        8 * 1024,
        "config mutation retry"
    );
    assertRequiredMarkers(configMutationRetry, "config mutation retry", [
        "const maxAttempts = params.maxAttempts ?? DEFAULT_CONFIG_MUTATION_RETRY_ATTEMPTS",
        "for (let attempt = 0; attempt < maxAttempts; attempt += 1)",
        "if (err instanceof ConfigMutationConflictError && err.retryable && attempt < maxAttempts - 1) continue",
    ]);
    assertRequiredMarkers(configMutation, "config mutation base", [
        'const baseConfig = params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig',
    ]);
    const skillsUpdateHandler = boundedSourceRegion(
        skillsHandlers,
        '"skills.update": async',
        "//#endregion",
        8 * 1024,
        "skills.update handler"
    );
    assertRequiredMarkers(skillsUpdateHandler, "skills.update handler", [
        'assertValidParams(params, validateSkillsUpdateParams, "skills.update", respond)',
        '"source" in params && params.source === "clawhub"',
        "const updated = await updateSkillConfigEntry(p)",
        "ok: true",
        "skillKey: p.skillKey",
        "config: redactConfigObject(updated)",
    ]);

    const skillsStatus = artifactByRole(artifacts, "skills-status").contents;
    const skillStatusRow = boundedSourceRegion(
        skillsStatus,
        "function buildSkillStatus(indexed, context) {",
        "function buildWorkspaceSkillStatus(workspaceDir, opts) {",
        16 * 1024,
        "skills.status row"
    );
    assertRequiredMarkers(skillStatusRow, "skills.status row", [
        "const skillKey = indexed.skillKey",
        "const disabled = skillConfig?.enabled === false",
        "const eligible = !disabled && !blockedByAllowlist && requirementsSatisfied",
        "name: entry.skill.name",
        "description: entry.skill.description",
        "source: skillSource",
        "bundled,",
        "filePath: entry.skill.filePath",
        "baseDir: entry.skill.baseDir",
        "skillKey,",
        "eligible,",
    ]);
    const skillStatusEnvelope = boundedSourceRegion(
        skillsStatus,
        "function buildWorkspaceSkillStatus(workspaceDir, opts) {",
        "//#endregion",
        16 * 1024,
        "skills.status envelope"
    );
    assertRequiredMarkers(skillStatusEnvelope, "skills.status envelope", [
        "workspaceDir,",
        "managedSkillsDir,",
        "agentId: opts?.agentId",
        "agentSkillFilter,",
        "skills: skillIndexEntries.map((entry) => buildSkillStatus(entry, {",
    ]);

    return {
        agentAccess,
        channels: {
            providerEntriesArePassthrough: true,
            providerEntryEnabledUnlessExplicitlyFalse: true,
            reservedConfigKeys: ["defaults", "modelByChannel"],
        },
        configGet: {
            cache: {
                bypassedUnlessHotReloadActive: true,
                explicitWriteInvalidation: true,
                keyFields: [
                    "getHotReloadStatus-identity",
                    "appliedConfigHash",
                    "pluginRegistryVersion",
                ],
                rejectedPromiseEvicted: true,
                sharedInFlightPromise: true,
            },
            handlerValidatesParams: true,
            method: "config.get",
            requestParams: [],
            response: {
                authoredParsedPrecedesEnvironmentResolution: true,
                invalidSnapshotClearsConfigPayloads: true,
                pluginMetadataOmitted: true,
                redactedSnapshotFields: [
                    "config",
                    "parsed",
                    "raw",
                    "resolved",
                    "runtimeConfig",
                    "sourceConfig",
                ],
                revisionHashFields: ["appliedConfigHash", "configRevisionHash"],
                snapshotHashPreserved: true,
                uiHintsDriveRedaction: true,
            },
        },
        configPatch: {
            baseHash: {
                blankIsAbsent: true,
                generalWritesRequireHash: true,
                hashlessLastWriterWinsPaths: ["ui.prefs"],
                mismatchRejected: true,
                protocolOptional: true,
                writeUsesSnapshotHash: true,
            },
            handlerValidatesParams: true,
            method: "config.patch",
            modelNormalization: {
                agentScopeCollections: [...reviewedAgentModelScopeCollections],
                agentSelectionFields: [...reviewedAgentSelectionFields],
                appliedBeforeMerge: true,
                dynamicEnvironmentRefs: {
                    canonicalizedResolvedValueDoesNotRestoreOriginalReference: true,
                    resolvedBeforeSnapshotValidation: true,
                    restoredOnlyWhenResolvedValueUnchanged: true,
                },
                googleAliases: [...reviewedGoogleModelAliases],
                googleProviderIds: ["google", "google-gemini-cli", "google-vertex"],
                mediaSelectionFields: [...reviewedMediaSelectionFields],
                modelSelectionShapes: [...reviewedModelSelectionShapes],
                nestedAgentModelPaths: [...reviewedNestedAgentModelPaths],
                nestedGoogleModelIdsNormalized: true,
                normalizesAgentScopes: true,
                normalizesProviderCatalogs: true,
                providerCatalogModelPath: "models.providers[].models[].id",
                togetherAliases: [...reviewedTogetherModelAliases],
                togetherProviderId: "together",
                wholeMergedCandidateNormalizedBeforeValidation: true,
            },
            redaction: {
                getAndWriteResponsesRedacted: true,
                patchRestoresSensitiveValuesFromSnapshot: true,
                reservedOrUnrestorableSentinelRejected: true,
                sentinel: "__OPENCLAW_REDACTED__",
            },
            requestParams: [
                "baseHash",
                "deliveryContext",
                "note",
                "raw",
                "replacePaths",
                "restartDelayMs",
                "sessionKey",
            ],
            restart: {
                changedPathsDriveRequirement: true,
                directRestartConditional: true,
                schedulerSuccess: {
                    ok: true,
                    resultFields: [...schedulerResultFields],
                },
                sentinelPersistenceBestEffort: true,
                sentinelRequiresRestartPath: "sentinel.payload.stats.requiresRestart",
                sentinelResultFields: ["payload", "persisted"],
            },
            write: {
                arraysMergeById: true,
                heartbeatTargetPath: "agents.defaults.heartbeat.target",
                heartbeatTargetSchema: "optional-string",
                noChangeReturnsNoop: true,
                nullDeletesObjectKeys: true,
                rawFormat: "json5-object",
                replacePathsSupported: true,
            },
        },
        domain: "settings",
        exec: {
            approvalFileConstrainsNonSandbox: true,
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
            omittedModeDerivedFromSecurityAndAsk: true,
            policyLayerOrder: ["global", "agent", "session-legacy", "request-overrides"],
        },
        io: {
            snapshot: {
                configAlias: "runtimeConfig",
                includedPathsSource: "sorted-resolved-include-watch-paths",
                parsedSource: "authored-root-before-environment-resolution",
                resolvedAlias: "sourceConfig",
                runtimeConfigSource: "validated-materialized-source-config",
                snapshotHashSource: "root-raw-bytes",
                sourceConfigSource:
                    "include-resolved-environment-resolved-migrated-config",
            },
            write: {
                includeTargetPersistedConfigSource: "refreshed-resolved-source-config",
                includeTargetPersistedHashSource: "refreshed-root-snapshot-hash",
                jsonFormat: "json-two-space-trailing-newline",
                json5CommentsWarnedAndStripped: true,
                rootPersistedHashSource: "serialized-root-json-bytes",
                settlement: {
                    canonicalRereadBeforeRuntimeRefresh: true,
                    persistedBeforeCanonicalReread: true,
                    postCommitFailureCanBeMutationOutcomeUnknown: true,
                    rollbackFailureSurfaced: true,
                    rollbackFalseCanLeaveCommittedBytes: true,
                    runtimeRefreshFailureAttemptsHashGuardedRollback: true,
                },
            },
        },
        methodAccess: [
            { controlPlaneWrite: false, name: "config.get", scope: "operator.read" },
            { controlPlaneWrite: true, name: "config.patch", scope: "operator.admin" },
            { controlPlaneWrite: false, name: "skills.status", scope: "operator.read" },
            { controlPlaneWrite: false, name: "skills.update", scope: "operator.admin" },
        ],
        schemaVersion: 1,
        sessionReset: {
            absentPolicyMode: "none",
            defaultAtHour: 4,
            explicitIdleModePreserved: true,
            explicitNoneModePreserved: true,
            idleWithoutMinutesDefaultsToZero: true,
            presentPolicyWithoutMode: "daily",
        },
        toolActivationDefaults: {
            agentToAgentRequiresExplicitTrue: true,
            elevatedEnabledUnlessExplicitlyFalse: true,
            webFetchEnabledWhenOmitted: true,
            webSearchEnabledWhenOmitted: true,
        },
        skillsStatus: {
            row: {
                disabledFrom: "skills.entries[skillKey].enabled-equals-false",
                eligibleRequiresNotDisabled: true,
                reviewedFields: [
                    "baseDir",
                    "bundled",
                    "description",
                    "disabled",
                    "eligible",
                    "filePath",
                    "name",
                    "skillKey",
                    "source",
                ],
            },
            handlerValidatesParams: true,
            method: "skills.status",
            requestParams: ["agentId"],
            source: {
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
                taxonomy: [...reviewedSkillSourceTaxonomy],
            },
            workspace: {
                defaultAgentResolved: true,
                remoteEligibilityIncluded: true,
                unknownExplicitAgentRejected: true,
                upstreamHostPathFields: [
                    "managedSkillsDir",
                    "skills[].baseDir",
                    "skills[].filePath",
                    "workspaceDir",
                ],
            },
        },
        skillsUpdate: {
            handler: {
                apiKeySemantics: [
                    "redacted-sentinel-preserves",
                    "blank-deletes",
                    "nonblank-sets",
                ],
                afterWriteMode: "auto",
                configMutationUsesRetry: true,
                enabledBooleanOnly: true,
                envSemantics: [
                    "blank-key-ignored",
                    "redacted-sentinel-preserves",
                    "blank-value-deletes",
                    "nonblank-value-sets",
                ],
                localEntryPath: "skills.entries[skillKey]",
                mutationBase: "source-config-default",
                responseConfigRedacted: true,
                resultFields: ["config", "ok", "skillKey"],
                wholeConfigModelNormalization: false,
            },
            handlerValidatesParams: true,
            method: "skills.update",
            request: {
                baseHashAccepted: false,
                localParams: ["apiKey", "enabled", "env", "skillKey"],
                unpatchableConfigEntryKeys: ["constructor", "prototype"],
            },
        },
    };
}

function publicArtifacts(artifacts: readonly LoadedSourceArtifact[]): SourceArtifact[] {
    return artifacts
        .map(({ bytes, path: artifactPath, role, sha256: digest }) => ({
            bytes,
            path: artifactPath,
            role,
            sha256: digest,
        }))
        .toSorted((left, right) => compareStrings(left.role, right.role));
}

/**
 * Audits only the installed package metadata and reviewed distribution artifacts.
 * It never reads OpenClaw state, configuration, credentials, or session data.
 * @param selectedSourceRoot Absolute path to an explicitly selected package root.
 * @returns Strict, redacted protocol facts and hashes for reviewed public artifacts.
 */
export async function auditInstalledOpenClaw(
    selectedSourceRoot: string
): Promise<SourceAuditResult> {
    if (!path.isAbsolute(selectedSourceRoot) || selectedSourceRoot.includes("\0")) {
        throw new TypeError("OpenClaw source root must be an absolute path");
    }
    const sourceRoot = await realpath(selectedSourceRoot);
    const sourceRootStat = await stat(sourceRoot);
    if (!sourceRootStat.isDirectory()) {
        throw new Error("OpenClaw source root is not a directory");
    }
    const packageArtifact = await loadSourceArtifact(
        sourceRoot,
        "package.json",
        "package-metadata",
        maximumPackageMetadataBytes
    );
    const buildInfoArtifact = await loadSourceArtifact(
        sourceRoot,
        "dist/build-info.json",
        "build-info",
        maximumBuildInfoBytes
    );
    const packageMetadata = v.parse(
        packageMetadataSchema,
        JSON.parse(packageArtifact.contents) as unknown
    );
    const buildInfo = v.parse(
        buildInfoSchema,
        JSON.parse(buildInfoArtifact.contents) as unknown
    );
    if (packageMetadata.version !== buildInfo.version) {
        throw new Error("OpenClaw package and build-info versions differ");
    }

    const distributionArtifacts = await Promise.all(
        distributionArtifactSpecs.map((spec) =>
            locateDistributionArtifact(sourceRoot, spec)
        )
    );
    const artifacts = [packageArtifact, buildInfoArtifact, ...distributionArtifacts];
    const versionSource = artifactByRole(artifacts, "protocol-version").contents;
    const protocolVersion = parseIntegerConstant(versionSource, "PROTOCOL_VERSION");
    const minimumClientProtocolVersion = parseIntegerConstant(
        versionSource,
        "MIN_CLIENT_PROTOCOL_VERSION"
    );
    const minimumNodeProtocolVersion = parseIntegerConstant(
        versionSource,
        "MIN_NODE_PROTOCOL_VERSION"
    );
    const minimumProbeProtocolVersion = parseIntegerConstant(
        versionSource,
        "MIN_PROBE_PROTOCOL_VERSION"
    );
    const declarations = artifactByRole(artifacts, "protocol-declarations").contents;
    if (!declarations.includes(`declare const PROTOCOL_VERSION: ${protocolVersion};`)) {
        throw new Error("OpenClaw runtime and declaration protocol versions differ");
    }

    const limitsSource = artifactByRole(artifacts, "gateway-limits").contents;
    const methods = extractMethodNames(
        artifactByRole(artifacts, "gateway-methods").contents
    );
    const gatewayEvents = extractGatewayEvents(
        artifactByRole(artifacts, "gateway-events").contents
    );
    const broadcastSequence = assertGatewayBroadcastSequence(
        artifactByRole(artifacts, "gateway-broadcaster").contents
    );
    const sessionScopedEvents = assertGatewaySessionScopedEventsCapability(artifacts);
    const chatThrottleMs = assertChatStreamingPolicy(
        artifactByRole(artifacts, "chat-streaming").contents,
        declarations
    );
    const taskNotificationSend = assertTaskNotificationChatSendSemantics(artifacts);
    const chatAdapter = assertPhase4ChatAdapterSemantics(artifacts);
    assertGatewayHandshake(
        artifactByRole(artifacts, "gateway-websocket").contents,
        declarations
    );
    const taskPromptChars = assertPlanCompanionAndTasks(artifacts);
    const tasksAdapter = assertPhase4TaskAdapterSemantics(artifacts);
    const sessionsAdapter = assertPhase4SessionsSemantics(artifacts);
    const operations = assertOpenClawOperationsSemantics(artifacts);
    const cronAdapter = assertPhase4CronSemantics(artifacts);
    const settings = assertSettingsSemantics(artifacts);

    return parseSourceAuditResult({
        agents: {
            domain: "agents",
            gatewayEvents: selectRequiredEvents(gatewayEvents, ["agent"]),
            methods: methods.agents,
            schemaVersion: 1,
        },
        chat: {
            ...chatAdapter,
            domain: "chat",
            gatewayEvents: selectRequiredEvents(gatewayEvents, [
                "agent",
                "chat",
                "session.message",
                "session.tool",
            ]),
            methods: methods.chat,
            schemaVersion: 1,
            streamingPolicy: {
                coalescedAgentStreams: ["assistant", "thinking"],
                deltaThrottleMs: chatThrottleMs,
                flushBeforeBoundaries: ["item.start", "tool.start"],
                flushBufferedDeltaBeforeTerminal: true,
                terminalStates: ["final", "aborted", "error"],
            },
            syntheticScenarios: [
                {
                    events: [
                        {
                            delta: "Checking cancellation.",
                            kind: "agent-delta",
                            seq: 1,
                            stream: "assistant",
                            text: "Checking cancellation.",
                        },
                        {
                            deltaText: "Checking cancellation.",
                            kind: "chat-delta",
                            seq: 2,
                        },
                        {
                            kind: "chat-terminal",
                            seq: 3,
                            state: "aborted",
                            stopReason: "cancelled",
                        },
                    ],
                    id: "cancelled-run",
                },
                {
                    events: [
                        {
                            delta: "Inspecting synthetic input.",
                            kind: "agent-delta",
                            seq: 1,
                            stream: "thinking",
                            text: "Inspecting synthetic input.",
                        },
                        {
                            delta: "Running the fixture tool.",
                            kind: "agent-delta",
                            seq: 2,
                            stream: "assistant",
                            text: "Running the fixture tool.",
                        },
                        {
                            kind: "tool-start",
                            seq: 3,
                            toolCallId: "fixture-tool-1",
                            toolName: "fixture.lookup",
                        },
                        {
                            kind: "tool-result",
                            outcome: "ok",
                            seq: 4,
                            toolCallId: "fixture-tool-1",
                            toolName: "fixture.lookup",
                        },
                        {
                            deltaText: "Fixture complete.",
                            kind: "chat-delta",
                            seq: 5,
                        },
                        {
                            kind: "chat-terminal",
                            seq: 6,
                            state: "final",
                            stopReason: "completed",
                        },
                    ],
                    id: "completed-tool-run",
                },
            ],
            taskNotificationSend,
        },
        cron: {
            adapter: cronAdapter,
            domain: "cron",
            gatewayEvents: selectRequiredEvents(gatewayEvents, ["cron"]),
            methods: methods.cron,
            schemaVersion: 1,
        },
        gateway: {
            broadcastSequence,
            challengeEvent: "connect.challenge",
            frameTypes: ["event", "req", "res"],
            gatewayEvents: selectRequiredEvents(gatewayEvents, [
                "connect.challenge",
                "health",
                "heartbeat",
                "presence",
                "shutdown",
                "tick",
            ]),
            helloType: "hello-ok",
            limits: {
                authenticatedFrameBytes: parseIntegerConstant(
                    limitsSource,
                    "MAX_PAYLOAD_BYTES"
                ),
                bufferedAmountBytes: parseIntegerConstant(
                    limitsSource,
                    "MAX_BUFFERED_BYTES"
                ),
                preauthenticationFrameBytes: parseIntegerConstant(
                    limitsSource,
                    "MAX_PREAUTH_PAYLOAD_BYTES"
                ),
            },
            method: "connect",
            minimumClientProtocolVersion,
            minimumNodeProtocolVersion,
            minimumProbeProtocolVersion,
            protocolVersion,
            schemaVersion: 1,
            sessionScopedEvents,
        },
        operations,
        sessions: {
            adapter: sessionsAdapter,
            companion: {
                authority: {
                    askResultDelivery: "requester-only",
                    dedicatedGatewayEvent: false,
                    stateStorage: "process-memory",
                },
                lifecycle: {
                    firstFailedAskRemovesEmptyThread: true,
                    resetAbortsActiveAsk: true,
                    sessionResetClearsThread: true,
                    serviceDisposeAbortsAll: true,
                },
                limits: {
                    answerChars: 1200,
                    connectionAsksPerMinute: 4,
                    exchangeBytes: 48 * 1024,
                    exchanges: 24,
                    globalAsksPerMinute: 12,
                    globalConcurrentAsks: 6,
                    idleTtlMs: 120 * 60_000,
                    perSeedMessageChars: 4000,
                    perSessionConcurrentAsks: 1,
                    questionChars: 400,
                    seedBytes: 24 * 1024,
                    seedTranscriptMessages: 40,
                    sweepIntervalMs: 10 * 60_000,
                    timeoutMs: 60_000,
                },
                methodPermissions: [
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
                ],
                runtimePolicy: {
                    askStartsUtilityModelInference: true,
                    messageToolDisabled: true,
                    sessionsVisibility: "self",
                    toolSearchDisabled: true,
                    tools: ["read", "sessions_history", "sessions_search"],
                    workspaceOnly: true,
                },
                uiProjection: {
                    busyCode: "SESSION_COMPANION_BUSY",
                    hydrationIsRevisionGuarded: true,
                    localPendingPerSession: true,
                    retainedExchanges: 24,
                },
            },
            domain: "sessions",
            gatewayEvents: gatewayEvents.filter(
                (event) => event.startsWith("session.") || event.startsWith("sessions.")
            ),
            methods: methods.sessions,
            plan: {
                authority: {
                    dedicatedGatewayEvent: false,
                    dedicatedRpcMethod: false,
                    gatewayEvent: "agent",
                    phase: "update",
                    producerTool: "update_plan",
                    stream: "plan",
                },
                contract: {
                    legacyStringStepsBecomePending: true,
                    maximumInProgressSteps: 1,
                    minimumSteps: 1,
                    statuses: ["pending", "in_progress", "completed"],
                },
                lifecycle: {
                    clearedOnOwningRunTerminal: true,
                    durableAfterTerminal: false,
                    historyRecovery: "in-flight-run-only",
                    runOwned: true,
                },
                uiProjection: {
                    activeOnly: true,
                    composerChecklist: true,
                    messageStreamCard: true,
                    sessionRailStepLimit: 3,
                },
            },
            schemaVersion: 1,
        },
        settings,
        source: {
            builtAt: buildInfo.builtAt,
            commit: buildInfo.commit,
            packageName: packageMetadata.name,
            protocolVersion,
            version: packageMetadata.version,
        },
        sourceArtifacts: publicArtifacts(artifacts),
        tasks: {
            adapter: tasksAdapter,
            authority: {
                cancelTarget: "task-id",
                ledgerScope: "global-with-optional-filters",
                sessionFilterRequired: false,
            },
            cancellation: {
                canonicalCompletionCanWinRace: true,
                cascadesSubagentDescendants: true,
                notFoundIsRpcSuccess: true,
                operatorControlBypassesCallerSessionOwnership: true,
                refusalIsRpcSuccess: true,
                subagentCancellationIsProvisional: true,
                terminalTaskIsNotCancelled: true,
            },
            domain: "tasks",
            event: {
                actions: ["deleted", "restored", "upserted"],
                delivery: "best-effort-drop-if-slow",
                name: "task",
            },
            gatewayEvents: selectRequiredEvents(gatewayEvents, ["task"]),
            list: {
                cursor: "decimal-offset",
                defaultLimit: 100,
                filters: ["agentId", "sessionKey", "status"],
                maximumLimit: 500,
                ordering: "last-activity-descending",
            },
            methodPermissions: [
                {
                    controlPlaneWrite: false,
                    name: "tasks.cancel",
                    scope: "operator.write",
                },
                {
                    controlPlaneWrite: false,
                    name: "tasks.get",
                    scope: "operator.read",
                },
                {
                    controlPlaneWrite: false,
                    name: "tasks.list",
                    scope: "operator.read",
                },
            ],
            methods: methods.tasks,
            promptVisibility: {
                getIncludesBoundedPrompt: true,
                listAndEventsOmitPrompt: true,
                promptChars: taskPromptChars,
            },
            runtimeMappings: [
                { internal: "cancelled", wire: "cancelled" },
                { internal: "failed", wire: "failed" },
                { internal: "lost", wire: "failed" },
                { internal: "queued", wire: "queued" },
                { internal: "running", wire: "running" },
                { internal: "succeeded", wire: "completed" },
                { internal: "timed_out", wire: "timed_out" },
            ],
            schemaVersion: 1,
            statuses: [
                "queued",
                "running",
                "completed",
                "failed",
                "cancelled",
                "timed_out",
            ],
            uiProjection: {
                activeSnapshotLimit: 200,
                cancelledAndTimedOutUseFailedGroup: true,
                detailUsesTasksGet: true,
                eventBufferDuringSnapshot: true,
                finishedSnapshotLimit: 100,
                nonSubagentOpenSessionLink: true,
                reconnectRefetch: true,
                restoredEventRefetch: true,
                stopRequiresOperatorWrite: true,
                subagentOpenSessionLink: false,
            },
        },
    });
}
