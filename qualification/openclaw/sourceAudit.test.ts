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
} from "./reviewedFixtures.ts";
import { parseSourceAuditCliArguments } from "./runSourceAudit.ts";
import { auditInstalledOpenClaw } from "./sourceAudit.ts";
import { chatFixtureSchema, parseFixtureDocument } from "./sourceAuditSchemas.ts";

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
            const emitChatTerminal = () => {
                flushBufferedChatDeltaIfNeeded(sessionKey, opts?.agentId);
                chatRunState.clearRun(clientRunId);
            };
            if (evt.stream === "plan" && evt.data?.phase === "update") {
                chatRunState.getOrCreate(clientRunId).planSnapshot = {};
            }
        `,
        "chat-abort-fixture.js": `
            const plan = run?.planSnapshot;
            const withoutText = params.snapshot.plan ? { plan: params.snapshot.plan } : {};
            const droppedPlan = { plan: { steps: [] } };
        `,
        "core-descriptors-fixture.js": `
            { name: "tasks.list", scope: "operator.read" },
            { name: "tasks.get", scope: "operator.read" },
            { name: "tasks.cancel", scope: "operator.write" },
            { name: "sessions.companion.ask", scope: "operator.read" },
            { name: "sessions.companion.state", scope: "operator.read" },
            { name: "sessions.companion.reset", scope: "operator.write", controlPlaneWrite: true },
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
            const TaskLedgerStatusSchema = [
                Type.Literal("queued"), Type.Literal("running"),
                Type.Literal("completed"), Type.Literal("failed"),
                Type.Literal("cancelled"), Type.Literal("timed_out")
            ];
            const SessionsCompanionAskParamsSchema = {
                maxLength: 400, maxLength: 1200, maxItems: 24, maximum: 500
            };
            // Companion answer returned only to the requesting operator.
            // Returned by tasks.get; omitted from list/event summaries.
        `,
        "server-runtime-subscriptions-fixture.js": `
            const SESSION_COMPANION_IDLE_TTL_MS = 120 * 6e4;
            const SESSION_COMPANION_SWEEP_INTERVAL_MS = 10 * 6e4;
            payload = { action: "restored" };
            params.broadcast("task", payload, { dropIfSlow: true });
        `,
        "session-companion-rpc-fixture.js": `
            "sessions.companion.ask";
            "sessions.companion.state";
            "sessions.companion.reset";
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
        "tasks-fixture.js": `
            const DEFAULT_TASKS_LIST_LIMIT = 100;
            const MAX_TASKS_LIST_LIMIT = 500;
            const LEDGER_STATUS_TO_TASK_STATUSES = { failed: ["failed", "lost"] };
            function parseCursor() {}
            "tasks.list"; "tasks.get"; "tasks.cancel";
            mapTaskSummary(task, { includePrompt: true });
            respond(true, {});
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
            const MAX_PREAUTH_PAYLOAD_BYTES = 64 * 1024;
        `,
        "server-methods-fixture.js": `
            //#region src/gateway/server-methods.ts
            const coreGatewayHandlers = {};
            methods: ["agent", "agent.wait"];
            methods: ["agent.identity.get", "agents.list"];
            methods: ["chat.abort", "chat.history", "chat.send"];
            methods: ["session.typing", "sessions.list", "sessions.send"];
            methods: ["tasks.cancel", "tasks.get", "tasks.list"];
            methods: [
                "wake",
                "cron.list",
                "cron.add"
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
            challengeEvent: "connect.challenge",
            helloType: "hello-ok",
            limits: {
                authenticatedFrameBytes: 25 * 1024 * 1024,
                preauthenticationFrameBytes: 64 * 1024,
            },
            protocolVersion: 4,
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
        expect(reviewed.audit.sourceArtifacts).toHaveLength(23);
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
            expect(audit.sourceArtifacts).toHaveLength(23);
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
