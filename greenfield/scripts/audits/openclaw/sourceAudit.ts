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
        fileNamePattern: /^chat-abort-[A-Za-z0-9_-]+\.js$/u,
        markers: ["const plan = run?.planSnapshot", "const withoutText"],
        role: "chat-run-projection",
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
        fileNamePattern: /^server-chat-[A-Za-z0-9_-]+\.js$/u,
        markers: ["flushBufferedChatDeltaIfNeeded", "run.deltaSentAt"],
        role: "chat-streaming",
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
        fileNamePattern: /^subagent-control-[A-Za-z0-9_-]+\.js$/u,
        markers: [
            "Admin kill path for a subagent session key, bypassing caller ownership checks.",
            "cascadeKillChildren",
            "cascadeKilled",
        ],
        role: "subagent-control",
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

function assertMethodPermission(
    source: string,
    method: string,
    scope: "operator.read" | "operator.write",
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
        "dropIfSlow: true",
    ]);
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
    assertGatewayHandshake(
        artifactByRole(artifacts, "gateway-websocket").contents,
        declarations
    );
    const taskPromptChars = assertPlanCompanionAndTasks(artifacts);
    const sessionsAdapter = assertPhase4SessionsSemantics(artifacts);
    const cronAdapter = assertPhase4CronSemantics(artifacts);

    return parseSourceAuditResult({
        agents: {
            domain: "agents",
            gatewayEvents: selectRequiredEvents(gatewayEvents, ["agent"]),
            methods: methods.agents,
            schemaVersion: 1,
        },
        chat: {
            domain: "chat",
            gatewayEvents: selectRequiredEvents(gatewayEvents, [
                "agent",
                "chat",
                "session.message",
                "session.tool",
            ]),
            methods: methods.chat,
            methodAccess: [
                {
                    controlPlaneWrite: false,
                    name: "chat.send",
                    scope: "operator.write",
                },
            ],
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
        source: {
            builtAt: buildInfo.builtAt,
            commit: buildInfo.commit,
            packageName: packageMetadata.name,
            protocolVersion,
            version: packageMetadata.version,
        },
        sourceArtifacts: publicArtifacts(artifacts),
        tasks: {
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
