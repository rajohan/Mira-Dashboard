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
        fileNamePattern: /^server-methods-list-[A-Za-z0-9_-]+\.js$/u,
        markers: ["const GATEWAY_EVENTS", "connect.challenge"],
        role: "gateway-events",
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
    const start = source.indexOf(`name: "${method}"`);
    if (start === -1)
        throw new Error(`OpenClaw method descriptors are missing ${method}`);
    const end = source.indexOf("},", start);
    if (end === -1 || end - start > 240) {
        throw new Error(`OpenClaw method descriptor is unbounded for ${method}`);
    }
    const descriptor = source.slice(start, end);
    const hasExpectedScope =
        scope === "operator.read"
            ? /scope: "operator\.read"/u.test(descriptor)
            : /scope: "operator\.write"/u.test(descriptor);
    const isControlPlaneWrite = /controlPlaneWrite: true/u.test(descriptor);
    if (!hasExpectedScope || isControlPlaneWrite !== controlPlaneWrite) {
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
    const chatThrottleMs = assertChatStreamingPolicy(
        artifactByRole(artifacts, "chat-streaming").contents,
        declarations
    );
    assertGatewayHandshake(
        artifactByRole(artifacts, "gateway-websocket").contents,
        declarations
    );
    const taskPromptChars = assertPlanCompanionAndTasks(artifacts);

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
        },
        cron: {
            domain: "cron",
            gatewayEvents: selectRequiredEvents(gatewayEvents, ["cron"]),
            methods: methods.cron,
            schemaVersion: 1,
        },
        gateway: {
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
        },
        sessions: {
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
