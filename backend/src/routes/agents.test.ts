import assert from "node:assert/strict";
import fs from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

import express from "express";

import { db } from "../db.js";
import gateway from "../gateway.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalHome = process.env.HOME;
const originalGateway = {
    getSessions: gateway.getSessions,
    request: gateway.request,
};
const agentId = `test-agent-${Date.now()}`;

async function startServer(homeDir: string): Promise<TestServer> {
    process.env.HOME = homeDir;
    const { default: agentsRoutes } = await import("./agents.js");

    const app = express();
    agentsRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

async function requestJson<T>(
    server: TestServer,
    pathName: string,
    options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: options.method || "GET",
        headers:
            options.body === undefined
                ? undefined
                : { "Content-Type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

describe("agents routes", () => {
    let server: TestServer;
    let homeDir: string;
    let configPath: string;
    let metadataPath: string;

    before(async () => {
        homeDir = await mkdtemp(path.join(os.tmpdir(), "mira-agents-route-"));
        const openclawRoot = path.join(homeDir, ".openclaw");
        await mkdir(openclawRoot, { recursive: true });
        configPath = path.join(openclawRoot, "openclaw.json");
        await writeFile(
            configPath,
            JSON.stringify(
                {
                    agents: {
                        defaults: {
                            model: { primary: "codex" },
                            models: {
                                "openai-codex/gpt-5.5": { alias: "codex" },
                            },
                        },
                        list: [
                            { id: agentId, default: true },
                            {
                                id: "researcher",
                                model: { primary: "synthetic/hf:moonshotai/Kimi-K2.5" },
                            },
                            { id: "alias-agent" },
                        ],
                    },
                },
                null,
                2
            )
        );
        metadataPath = path.join(
            openclawRoot,
            "agents",
            agentId,
            "sessions",
            "metadata.json"
        );

        gateway.getSessions = () => [];
        gateway.request = async (method: string) => {
            if (method === "sessions.list") {
                return {
                    sessions: [
                        {
                            key: `agent:${agentId}:main`,
                            model: "openai-codex/gpt-5.5",
                            updatedAt: Date.now(),
                        },
                    ],
                };
            }

            throw new Error(`Unexpected gateway method: ${method}`);
        };
        server = await startServer(homeDir);
    });

    after(async () => {
        await server.close();
        db.prepare("DELETE FROM agent_task_history WHERE agent_id = ?").run(agentId);
        gateway.getSessions = originalGateway.getSessions;
        gateway.request = originalGateway.request;
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        await rm(homeDir, { recursive: true, force: true });
    });

    it("returns parsed agent config and status with resolved models", async () => {
        const config = await requestJson<{
            defaults: { model: { primary: string } };
            list: Array<{ id: string }>;
        }>(server, "/api/agents/config");

        assert.equal(config.status, 200);
        assert.equal(config.body.defaults.model.primary, "codex");
        assert.deepEqual(
            config.body.list.map((agent) => agent.id),
            [agentId, "researcher", "alias-agent"]
        );

        const status = await requestJson<{
            agents: Array<{
                id: string;
                status: string;
                model: string;
                currentTask: string | null;
            }>;
            timestamp: number;
        }>(server, "/api/agents/status");

        assert.equal(status.status, 200);
        const testAgent = status.body.agents.find((agent) => agent.id === agentId);
        const researcher = status.body.agents.find((agent) => agent.id === "researcher");
        assert.equal(testAgent?.status, "idle");
        assert.equal(testAgent?.model, "gpt-5.5");
        assert.equal(testAgent?.currentTask, null);
        assert.equal(researcher?.model, "hf:moonshotai/Kimi-K2.5");
        assert.equal(typeof status.body.timestamp, "number");
    });

    it("normalizes agent helper edge cases", async () => {
        const { __testing } = await import("./agents.js");
        const config = {
            defaults: {
                models: {
                    "openai/gpt-5.5": { alias: "codex" },
                },
            },
            list: [],
        };

        assert.equal(__testing.toDisplayModelName(""), "unknown");
        assert.equal(__testing.toDisplayModelName("openai/gpt-5.5"), "gpt-5.5");
        assert.equal(__testing.getRouteParam("main"), "main");
        assert.equal(__testing.getRouteParam(["main", "ignored"]), "main");
        assert.equal(__testing.getRouteParam([]), "");
        const missingRouteParam: string | string[] | undefined = undefined;
        assert.equal(__testing.getRouteParam(missingRouteParam), "");
        assert.equal(
            __testing.toDisplayModelName("synthetic/hf:vendor/model"),
            "hf:vendor/model"
        );
        assert.equal(__testing.resolveConfiguredModelName(undefined, config), "unknown");
        assert.equal(__testing.resolveConfiguredModelName("  ", config), "unknown");
        assert.equal(__testing.resolveConfiguredModelName("codex", config), "gpt-5.5");
        assert.equal(
            __testing.resolveConfiguredModelName("synthetic/model", config),
            "model"
        );
        assert.equal(__testing.toTimestamp(1_700_000_000_000), 1_700_000_000_000);
        assert.equal(
            __testing.toTimestamp("2023-11-14T22:13:20.000Z"),
            1_700_000_000_000
        );
        assert.equal(__testing.toTimestamp("not-a-date"), null);
        assert.equal(__testing.toTimestamp({}), null);
        assert.equal(
            __testing.cleanTaskText(
                'Sender: noisy\nConversation info x\n```json\n{"a":1}\n```\nShip it [media attached: image]'
            ),
            "Ship it"
        );
        assert.equal(
            __testing.normalizeToolName("functions.exec_command"),
            "exec_command"
        );
        assert.equal(__testing.normalizeToolName("mcp__github__message"), "message");
        assert.equal(__testing.isVisibleActivityTool("message"), false);
        assert.equal(__testing.isVisibleActivityTool("mcp__github__message"), false);
        assert.equal(__testing.getSafeAgentSessionsDir("../main"), null);
        assert.deepEqual(__testing.getSafeAgentActivityRoots("../main"), []);
        assert.equal(__testing.determineStatus(null), "idle");
        assert.equal(__testing.determineStatus(Date.now()), "active");
        assert.equal(__testing.determineStatus(Date.now() - 30_000), "thinking");
        assert.equal(__testing.determineStatus(Date.now() - 120_000), "idle");
        assert.equal(
            __testing.getChannelFromSessionKey("channel:discord:123"),
            "discord"
        );
        assert.equal(__testing.getChannelFromSessionKey("agent:main:main"), null);

        const originalRealpathSync = fs.realpathSync;
        fs.realpathSync = ((target: fs.PathLike) => {
            if (String(target).endsWith(".openclaw/agents")) {
                throw new Error("agents dir unavailable");
            }
            return originalRealpathSync(target);
        }) as typeof fs.realpathSync;
        try {
            assert.equal(__testing.getSafeAgentSessionsDir(agentId), null);
            assert.deepEqual(__testing.getSafeAgentActivityRoots(agentId), []);
        } finally {
            fs.realpathSync = originalRealpathSync;
        }

        const originalStatSync = fs.statSync;
        fs.statSync = ((target: fs.PathLike) => {
            if (String(target).endsWith(".openclaw/agents")) {
                const error = new Error("agents dir denied") as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
            }
            return originalStatSync(target);
        }) as typeof fs.statSync;
        try {
            assert.equal(
                __testing.ensureRealAgentsDir()?.endsWith(".openclaw/agents"),
                true
            );
        } finally {
            fs.statSync = originalStatSync;
        }

        const agentsRoot = path.join(homeDir, ".openclaw", "agents");
        fs.statSync = ((target: fs.PathLike) => {
            if (String(target) === agentsRoot) {
                return {
                    isDirectory: () => false,
                } as fs.Stats;
            }
            return originalStatSync(target);
        }) as typeof fs.statSync;
        try {
            assert.equal(__testing.ensureRealAgentsDir(), null);
        } finally {
            fs.statSync = originalStatSync;
        }
    });

    it("summarizes tool activity from varied argument shapes", async () => {
        const { __testing } = await import("./agents.js");

        assert.equal(
            __testing.summarizeToolActivity("read", { arguments: { path: "README.md" } }),
            "read README.md"
        );
        assert.equal(__testing.summarizeToolActivity("exec", "not-json"), "exec");
        assert.equal(
            __testing.summarizeToolActivity("write", {
                parameters: { filePath: "src/file.ts" },
            }),
            "write src/file.ts"
        );
        assert.equal(
            __testing.summarizeToolActivity("exec_command", {
                arguments: { cmd: "npm run test -- --coverage" },
            }),
            "exec npm run test -- --coverage"
        );
        assert.equal(
            __testing.summarizeToolActivity("browser", {
                arguments: { action: "open", url: "https://example.test" },
            }),
            "browser open https://example.test"
        );
        assert.equal(
            __testing.summarizeToolActivity("custom.tool", {
                partialJson: '{"path":"src/fallback.ts"}',
            }),
            "tool src/fallback.ts"
        );
        assert.equal(
            __testing.summarizeToolActivity("custom", {
                partialJson: '"path": "src/loose.ts"',
            }),
            "custom src/loose.ts"
        );
        assert.equal(
            __testing.summarizeToolActivity("task", { action: "run" }),
            "task run"
        );
        assert.equal(
            __testing.summarizeToolActivity("read", JSON.stringify({ path: "a.ts" })),
            "read a.ts"
        );
        assert.equal(
            __testing.summarizeToolActivity("browser", {
                arguments: { action: "open", url: "https://example.test/long" },
            }),
            "browser open https://example.test/long"
        );
        assert.equal(
            __testing.summarizeToolActivity("custom", {
                input: { path: "nested/input.ts" },
            }),
            "custom nested/input.ts"
        );
        assert.equal(
            __testing.summarizeToolActivity("custom", { raw: "not-json" }),
            "custom"
        );
        assert.equal(
            __testing.summarizeToolActivity("message", {
                arguments: { text: "  hello   from dashboard  " },
            }),
            "message hello from dashboard"
        );
        assert.equal(
            __testing.summarizeToolActivity("memory_search", {
                arguments: { query: "  coverage   gaps  " },
            }),
            "memory_search coverage gaps"
        );
        assert.equal(
            __testing.summarizeToolActivity("read", {
                partialJson: '{"paths":["src/from-array.ts"]}',
            }),
            "read src/from-array.ts"
        );
        assert.equal(
            __testing.summarizeToolActivity("read", {
                partialJson: '{"path":',
            }),
            "read"
        );
        assert.equal(
            __testing.summarizeToolActivity("browser", {
                arguments: { action: "reload" },
            }),
            "browser reload"
        );
    });

    it("extracts Codex response-item and trajectory activity variants", async () => {
        const { __testing } = await import("./agents.js");

        assert.equal(__testing.getCodexResponseItemActivity(null), null);
        assert.equal(
            __testing.getCodexResponseItemActivity({
                type: "response_item",
                payload: {
                    type: "custom_tool_call",
                    name: "exec",
                    input: 'await tools.exec_command({ "cmd": "npm run build" });',
                },
            }),
            "exec npm run build"
        );
        assert.equal(
            __testing.getCodexResponseItemActivity({
                type: "response_item",
                payload: {
                    type: "custom_tool_call",
                    name: "apply_patch",
                    input: "await tools.apply_patch(...)",
                },
            }),
            "edit files"
        );
        assert.equal(
            __testing.getCodexResponseItemActivity({
                type: "response_item",
                payload: {
                    type: "custom_tool_call",
                    name: "browser",
                    input: "await tools.openclaw_browser(...)",
                },
            }),
            "browser activity"
        );
        assert.equal(
            __testing.getCodexResponseItemActivity({
                type: "response_item",
                payload: {
                    type: "custom_tool_call",
                    name: "session_status",
                    input: "await tools.openclaw_session_status(...)",
                },
            }),
            "session_status"
        );
        assert.equal(
            __testing.getCodexResponseItemActivity({
                type: "response_item",
                payload: {
                    type: "custom_tool_call",
                    name: "exec",
                    input: "await tools.write_stdin({ session_id: 1 });",
                },
            }),
            "terminal output"
        );
        assert.equal(
            __testing.getCodexResponseItemActivity({
                type: "response_item",
                payload: {
                    type: "custom_tool_call",
                    name: "read",
                    input: "await tools.read({ path: 'src/index.ts' });",
                },
            }),
            "read"
        );
        assert.equal(
            __testing.getCodexResponseItemActivity({
                type: "response_item",
                payload: {
                    type: "custom_tool_call",
                    name: "message",
                    input: "await tools.mcp__codex_apps__message(...)",
                },
            }),
            null
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "prompt.submitted",
                data: { prompt: "Investigate status" },
            }),
            { task: "Investigate status" }
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.call",
                data: { name: "exec", args: { command: "npm test" } },
            }),
            { activity: "exec npm test" }
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.result",
                data: { name: "read", input: { path: "src/index.ts" } },
            }),
            { activity: "read src/index.ts" }
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.result",
                data: { name: "message", input: { text: "hidden" } },
            }),
            {}
        );
        assert.deepEqual(__testing.getTrajectoryActivity(null), {});
        assert.deepEqual(__testing.getTrajectoryActivity({ type: "noop", data: {} }), {});
    });

    it("covers direct agent activity file edge cases", async () => {
        const { __testing } = await import("./agents.js");
        assert.equal(await __testing.getLatestActivityFromFile("bad!"), null);
        assert.equal(__testing.getSessionFileModTime("bad!"), null);
        await mkdir(path.join(homeDir, ".openclaw", "agents"), { recursive: true });
        assert.deepEqual(__testing.getSafeAgentActivityRoots("bad\0agent"), []);
        const externalSessionsRoot = path.join(homeDir, "external-sessions-root");
        const escapedActivityAgentDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "escaped-activity-agent"
        );
        await mkdir(externalSessionsRoot, { recursive: true });
        await symlink(externalSessionsRoot, escapedActivityAgentDir);
        try {
            assert.deepEqual(
                __testing.getSafeAgentActivityRoots("escaped-activity-agent"),
                []
            );
        } finally {
            await rm(escapedActivityAgentDir, { force: true });
        }

        const escapedSessionsAgentDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "escaped-sessions-agent"
        );
        await mkdir(escapedSessionsAgentDir, { recursive: true });
        await symlink(
            externalSessionsRoot,
            path.join(escapedSessionsAgentDir, "sessions")
        );
        try {
            assert.equal(
                __testing.getSafeAgentSessionsDir("escaped-sessions-agent"),
                null
            );
        } finally {
            await rm(escapedSessionsAgentDir, { recursive: true, force: true });
        }

        const staleSessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "stale-agent",
            "sessions"
        );
        await mkdir(staleSessionsDir, { recursive: true });
        const stalePath = path.join(staleSessionsDir, "old.jsonl");
        await writeFile(
            stalePath,
            JSON.stringify({ message: { role: "user", content: "old" } })
        );
        const staleDate = new Date(Date.now() - 10 * 60_000);
        await utimes(stalePath, staleDate, staleDate);
        const staleActivity = await __testing.getLatestActivityFromFile("stale-agent");
        assert.equal(staleActivity?.task, null);
        assert.equal(staleActivity?.activity, null);
        assert.equal(typeof __testing.getSessionFileModTime("stale-agent"), "number");

        const arraySessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "array-agent",
            "sessions"
        );
        await mkdir(arraySessionsDir, { recursive: true });
        await writeFile(
            path.join(arraySessionsDir, "array.jsonl"),
            [
                JSON.stringify({
                    __openclaw: { mirrorIdentity: "turn-array:source" },
                    message: {
                        role: "user",
                        content: [
                            { type: "text", text: "Array" },
                            { type: "image", text: "ignored" },
                            { type: "text", text: "task" },
                        ],
                    },
                }),
                JSON.stringify({
                    __openclaw: { mirrorIdentity: "turn-array:source" },
                    message: {
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                name: "functions.exec_command",
                                arguments: { command: "npm run lint" },
                            },
                        ],
                    },
                }),
            ].join("\n"),
            "utf8"
        );
        const activity = await __testing.getLatestActivityFromFile("array-agent");
        assert.equal(activity?.task, "Array task");
        assert.equal(activity?.activity, "exec npm run lint");

        const mixedSessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "mixed-agent",
            "sessions"
        );
        await mkdir(mixedSessionsDir, { recursive: true });
        const oldMixedPath = path.join(mixedSessionsDir, "old.jsonl");
        await writeFile(
            oldMixedPath,
            JSON.stringify({ message: { role: "user", content: "stale task" } }),
            "utf8"
        );
        await utimes(oldMixedPath, staleDate, staleDate);
        await writeFile(
            path.join(mixedSessionsDir, "recent.jsonl"),
            [
                JSON.stringify({
                    runId: "old-run",
                    message: { role: "user", content: "ignored old run" },
                }),
                JSON.stringify({
                    message: { role: "user", content: "ignored missing run" },
                }),
                JSON.stringify({
                    runId: "other-run",
                    message: {
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                name: "functions.exec_command",
                                arguments: { command: "ignored" },
                            },
                        ],
                    },
                }),
                JSON.stringify({
                    runId: "new-run",
                    message: {
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                name: "functions.exec_command",
                                arguments: { command: "npm test" },
                            },
                        ],
                    },
                }),
                JSON.stringify({
                    runId: "new-run",
                    message: {
                        role: "user",
                        content: { value: "object task" },
                    },
                }),
                "{bad",
            ].join("\n"),
            "utf8"
        );
        const mixedActivity = await __testing.getLatestActivityFromFile("mixed-agent");
        assert.equal(mixedActivity?.task, "[object Object]");
        assert.equal(mixedActivity?.activity, "exec npm test");
    });

    it("covers agent session selection and status helper branches", async () => {
        const { __testing } = await import("./agents.js");
        const status = {
            id: "alias-agent",
            status: "idle" as const,
            model: "unknown",
            currentTask: null,
            currentActivity: null as string | null,
            lastActivity: null as string | null,
            sessionKey: null as string | null,
            channel: null as string | null,
        };

        assert.equal(
            __testing.getChannelFromSessionKey("channel:discord:team"),
            "discord"
        );
        assert.equal(__testing.getChannelFromSessionKey("agent:main:main"), null);
        assert.equal(__testing.determineStatus(null), "idle");
        assert.equal(__testing.determineStatus(Date.now() - 1_000), "active");
        assert.equal(__testing.determineStatus(Date.now() - 30_000), "thinking");
        assert.equal(__testing.determineStatus(Date.now() - 90_000), "idle");
        assert.equal(__testing.findBestSessionForAgent("missing", []), undefined);

        const sessions = [
            {
                key: "agent:alias-agent:scratch",
                model: "scratch",
                updatedAt: Date.parse("2026-05-16T16:00:00.000Z"),
            },
            {
                key: "agent:alias-agent:main",
                model: "main",
                updatedAt: Date.parse("2026-05-16T15:00:00.000Z"),
                activeRunId: "run-1",
            },
        ];
        assert.equal(
            __testing.findBestSessionForAgent("alias-agent", sessions)?.model,
            "main"
        );
        assert.equal(
            __testing.findSessionByKey(sessions, "AGENT:ALIAS-AGENT:MAIN")?.model,
            "main"
        );
        const missingSession = undefined as never;
        assert.equal(__testing.isGatewaySessionRunning(missingSession), false);
        assert.equal(
            __testing.isGatewaySessionRunning({
                key: "agent:alias-agent:main",
                model: "main",
                endedAt: "2026-05-16T15:00:00.000Z",
                status: "running",
            }),
            false
        );
        assert.equal(__testing.isGatewaySessionRunning(sessions[1]), true);

        __testing.applyGatewaySessionStatus(status, sessions[1]);
        assert.equal(status.sessionKey, "agent:alias-agent:main");
        assert.equal(status.channel, null);
        assert.equal(status.status, "thinking");
        assert.equal(status.lastActivity, "2026-05-16T15:00:00.000Z");

        status.currentActivity = "exec npm test";
        __testing.applyGatewaySessionStatus(status, {
            key: "channel:discord:team",
            model: "main",
            status: "running",
            updatedAt: Date.parse("2026-05-16T16:00:00.000Z"),
        });
        assert.equal(status.channel, "discord");
        assert.equal(status.status, "active");
        assert.equal(status.lastActivity, "2026-05-16T16:00:00.000Z");
    });

    it("builds configured agent statuses with existing session keys", async () => {
        const { __testing } = await import("./agents.js");
        const previousGatewayRequest = gateway.request;
        const sessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "session-key-agent",
            "sessions"
        );
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(
            path.join(sessionsDir, "sessions.json"),
            JSON.stringify([
                {
                    key: "agent:session-key-agent:main",
                    updatedAt: Date.parse("2026-05-16T15:00:00.000Z"),
                },
            ]),
            "utf8"
        );

        try {
            gateway.request = async () => ({
                sessions: [
                    {
                        key: "agent:session-key-agent:main",
                        model: "live-model",
                        status: "running",
                        updatedAt: Date.parse("2026-05-16T16:00:00.000Z"),
                    },
                ],
            });
            const config = {
                defaults: { model: { primary: "codex" }, models: {} },
                list: [
                    { id: "session-key-agent", model: { primary: "configured-model" } },
                ],
            };

            const [status] = await __testing.buildAgentStatuses(config);
            assert.equal(status.sessionKey, "agent:session-key-agent:main");
            assert.equal(status.model, "live-model");
            assert.equal(status.status, "thinking");
            assert.equal(status.lastActivity, "2026-05-16T16:00:00.000Z");

            const single = await __testing.buildSingleAgentStatus(
                "session-key-agent",
                config
            );
            assert.equal(single?.model, "live-model");
            assert.equal(await __testing.buildSingleAgentStatus("missing", config), null);

            gateway.request = async () => ({
                sessions: [
                    {
                        key: "agent:session-key-agent:main",
                        model: "unknown",
                        status: "running",
                        updatedAt: Date.parse("2026-05-16T17:00:00.000Z"),
                    },
                ],
            });
            const [unknownStatus] = await __testing.buildAgentStatuses(config);
            assert.equal(unknownStatus.model, "configured-model");
            const unknownSingle = await __testing.buildSingleAgentStatus(
                "session-key-agent",
                config
            );
            assert.equal(unknownSingle?.model, "configured-model");

            gateway.request = async () => ({
                sessions: [
                    {
                        key: "agent:session-key-agent:main",
                        model: "openai-codex/gpt-5.5",
                        status: "running",
                        updatedAt: Date.parse("2026-05-16T18:00:00.000Z"),
                    },
                ],
            });
            const [displayStatus] = await __testing.buildAgentStatuses(config);
            assert.equal(displayStatus.model, "gpt-5.5");
            const displaySingle = await __testing.buildSingleAgentStatus(
                "session-key-agent",
                config
            );
            assert.equal(displaySingle?.model, "gpt-5.5");
        } finally {
            gateway.request = previousGatewayRequest;
        }
    });

    it("validates, stores, and rotates current task metadata into history", async () => {
        const { isValidAgentId: validateAgentId } = await import("./agents.js");
        assert.equal(validateAgentId("."), false);
        assert.equal(validateAgentId(".."), false);

        const invalid = await requestJson<{ error: string }>(
            server,
            `/api/agents/${agentId}/metadata`,
            { method: "PUT", body: { currentTask: "   " } }
        );
        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.error, "Provide currentTask");

        const nonString = await requestJson<{ error: string }>(
            server,
            `/api/agents/${agentId}/metadata`,
            { method: "PUT", body: { currentTask: { task: "Write backend tests" } } }
        );
        assert.equal(nonString.status, 400);
        assert.equal(nonString.body.error, "Provide currentTask");

        const nullBody = await requestJson<{ error: string }>(
            server,
            `/api/agents/${agentId}/metadata`,
            { method: "PUT" }
        );
        assert.equal(nullBody.status, 400);
        assert.equal(nullBody.body.error, "Provide currentTask");

        await rm(path.join(homeDir, ".openclaw", "agents"), {
            recursive: true,
            force: true,
        });
        const firstTask = await requestJson<{ currentTask: string; updatedAt: string }>(
            server,
            `/api/agents/${agentId}/metadata`,
            { method: "PUT", body: { currentTask: " Write backend tests " } }
        );
        assert.equal(firstTask.status, 200);
        assert.equal(firstTask.body.currentTask, "Write backend tests");
        assert.match(firstTask.body.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);

        const saved = JSON.parse(await readFile(metadataPath, "utf8")) as {
            currentTask: string;
        };
        assert.equal(saved.currentTask, "Write backend tests");

        const secondTask = await requestJson<{ currentTask: string }>(
            server,
            `/api/agents/${agentId}/metadata`,
            { method: "PUT", body: { currentTask: "Verify local batch" } }
        );
        assert.equal(secondTask.status, 200);
        assert.equal(secondTask.body.currentTask, "Verify local batch");

        const repeatedTask = await requestJson<{ currentTask: string }>(
            server,
            `/api/agents/${agentId}/metadata`,
            { method: "PUT", body: { currentTask: "Verify local batch" } }
        );
        assert.equal(repeatedTask.status, 200);
        assert.equal(repeatedTask.body.currentTask, "Verify local batch");

        const active = db
            .prepare(
                "SELECT task FROM agent_task_history WHERE agent_id = ? AND status = 'active'"
            )
            .all(agentId) as Array<{ task: string }>;
        const completed = db
            .prepare(
                "SELECT task FROM agent_task_history WHERE agent_id = ? AND status = 'completed'"
            )
            .all(agentId) as Array<{ task: string }>;

        assert.deepEqual(
            active.map((row) => row.task),
            ["Verify local batch"]
        );
        assert.deepEqual(
            completed.map((row) => row.task),
            ["Write backend tests"]
        );

        const originalPrepare = db.prepare.bind(db);
        const prepareMock = mock.method(db, "prepare", (statement: string) => {
            if (statement.includes("agent_task_history")) {
                throw new Error("history database unavailable");
            }
            return originalPrepare(statement);
        });
        const errorMock = mock.method(console, "error", () => {});
        try {
            const bestEffortHistoryFailure = await requestJson<{
                currentTask: string;
            }>(server, `/api/agents/${agentId}/metadata`, {
                method: "PUT",
                body: { currentTask: "Persist despite history failure" },
            });
            assert.equal(bestEffortHistoryFailure.status, 200);
            assert.equal(
                bestEffortHistoryFailure.body.currentTask,
                "Persist despite history failure"
            );
            assert.equal(errorMock.mock.callCount(), 1);
        } finally {
            prepareMock.mock.restore();
            errorMock.mock.restore();
        }

        const originalMetadataStats = await lstat(metadataPath).catch(() => null);
        const originalMetadataContent =
            originalMetadataStats?.isFile() === true
                ? await readFile(metadataPath, "utf8")
                : null;
        try {
            await writeFile(metadataPath, "null", "utf8");
            const nullMetadata = await requestJson<{ currentTask: string }>(
                server,
                `/api/agents/${agentId}/metadata`,
                { method: "PUT", body: { currentTask: "Recover null metadata" } }
            );
            assert.equal(nullMetadata.status, 200);
            assert.equal(nullMetadata.body.currentTask, "Recover null metadata");

            await writeFile(metadataPath, "{ malformed", "utf8");
            const malformedMetadata = await requestJson<{ error: string }>(
                server,
                `/api/agents/${agentId}/metadata`,
                { method: "PUT", body: { currentTask: "Repair malformed metadata" } }
            );
            assert.equal(malformedMetadata.status, 500);
            assert.match(malformedMetadata.body.error, /JSON|parse|malformed/u);

            await rm(metadataPath, { force: true, recursive: true });
            await mkdir(metadataPath);
            const unreadableMetadata = await requestJson<{ error: string }>(
                server,
                `/api/agents/${agentId}/metadata`,
                { method: "PUT", body: { currentTask: "Unreadable metadata" } }
            );
            assert.equal(unreadableMetadata.status, 500);
            assert.match(unreadableMetadata.body.error, /directory|EISDIR/u);
        } finally {
            await rm(metadataPath, { force: true, recursive: true });
            if (originalMetadataStats?.isDirectory() === true) {
                await mkdir(metadataPath);
            } else if (originalMetadataStats?.isFile() === true) {
                await writeFile(metadataPath, originalMetadataContent ?? "", "utf8");
            }
        }

        const history = await requestJson<{
            tasks: Array<{ agentId: string; task: string; status: string }>;
        }>(server, "/api/agents/tasks/history?limit=5");
        assert.equal(history.status, 200);
        assert.equal(
            history.body.tasks.some(
                (task) =>
                    task.agentId === agentId &&
                    task.task === "Write backend tests" &&
                    task.status === "completed"
            ),
            true
        );
    });

    it("accepts a symlinked agents root after canonical validation", async () => {
        const symlinkHome = await mkdtemp(path.join(os.tmpdir(), "mira-agents-link-"));
        const outsideAgents = await mkdtemp(
            path.join(os.tmpdir(), "mira-agents-link-target-")
        );
        const openclawRoot = path.join(symlinkHome, ".openclaw");
        let symlinkServer: http.Server | undefined;
        const previousHome = process.env.HOME;
        try {
            await mkdir(openclawRoot, { recursive: true });
            await symlink(outsideAgents, path.join(openclawRoot, "agents"));
            await mkdir(path.join(outsideAgents, "main", "sessions"), {
                recursive: true,
            });
            process.env.HOME = symlinkHome;
            const { default: agentsRoutes, __testing } = await import(
                `./agents.js?symlink-root=${Date.now()}`
            );

            assert.equal(
                __testing.getSafeAgentSessionsDir("main"),
                path.join(outsideAgents, "main", "sessions")
            );
            assert.deepEqual(__testing.getSafeAgentActivityRoots("main"), [
                { dir: path.join(outsideAgents, "main", "sessions"), recursive: false },
            ]);

            const app = express();
            agentsRoutes(app);
            symlinkServer = http.createServer(app);
            await new Promise<void>((resolve) => symlinkServer?.listen(0, resolve));
            const address = symlinkServer.address();
            assert.ok(address && typeof address === "object");

            const response = await fetch(
                `http://127.0.0.1:${address.port}/api/agents/main/metadata`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ currentTask: "blocked" }),
                }
            );
            assert.equal(response.status, 200);
            const responseBody = (await response.json()) as {
                currentTask?: unknown;
                updatedAt?: unknown;
            };
            assert.equal(responseBody.currentTask, "blocked");
            assert.equal(typeof responseBody.updatedAt, "string");
            assert.equal(
                await readFile(
                    path.join(outsideAgents, "main", "sessions", "metadata.json"),
                    "utf8"
                ).then((content) => JSON.parse(content).currentTask),
                "blocked"
            );
        } finally {
            if (symlinkServer) {
                await new Promise<void>((resolve, reject) =>
                    symlinkServer?.close((error) => (error ? reject(error) : resolve()))
                );
            }
            if (previousHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = previousHome;
            }
            await rm(symlinkHome, { recursive: true, force: true });
            await rm(outsideAgents, { recursive: true, force: true });
        }
    });

    it("rejects invalid agent ids before touching metadata paths", async () => {
        const invalidStatus = await requestJson<{ error: string }>(
            server,
            "/api/agents/bad!/status"
        );
        assert.equal(invalidStatus.status, 400);
        assert.equal(invalidStatus.body.error, "Invalid agent ID");

        const invalidMetadata = await requestJson<{ error: string }>(
            server,
            "/api/agents/bad!/metadata",
            { method: "PUT", body: { currentTask: "Nope" } }
        );
        assert.equal(invalidMetadata.status, 400);
        assert.equal(invalidMetadata.body.error, "Invalid agent ID");

        const outsideDir = await mkdtemp(path.join(os.tmpdir(), "mira-agent-outside-"));
        const symlinkAgentId = "escaped-agent";
        const symlinkPath = path.join(homeDir, ".openclaw", "agents", symlinkAgentId);
        await symlink(outsideDir, symlinkPath);
        try {
            const escapedMetadata = await requestJson<{ error: string }>(
                server,
                `/api/agents/${symlinkAgentId}/metadata`,
                { method: "PUT", body: { currentTask: "Nope" } }
            );
            assert.equal(escapedMetadata.status, 400);
            assert.equal(escapedMetadata.body.error, "Invalid agent ID");
        } finally {
            await rm(symlinkPath, { force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }

        const originalMkdirSync = fs.mkdirSync;
        try {
            fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (
                    targetPath.startsWith("/proc/self/fd/") &&
                    targetPath.endsWith(`${path.sep}sessions`)
                ) {
                    const error = new Error(
                        "sessions mkdir failed"
                    ) as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalMkdirSync(target, options);
            }) as typeof fs.mkdirSync;

            const mkdirFailure = await requestJson<{ error: string }>(
                server,
                "/api/agents/mkdir-fails/metadata",
                { method: "PUT", body: { currentTask: "Nope" } }
            );
            assert.equal(mkdirFailure.status, 500);
            assert.equal(mkdirFailure.body.error, "sessions mkdir failed");
        } finally {
            fs.mkdirSync = originalMkdirSync;
        }

        const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "darwin",
            });
            const unsupported = await requestJson<{ error: string }>(
                server,
                "/api/agents/unsupported-platform/metadata",
                { method: "PUT", body: { currentTask: "Nope" } }
            );
            assert.equal(unsupported.status, 501);
            assert.equal(unsupported.body.error, "unsupported-platform");
        } finally {
            if (originalPlatform) {
                Object.defineProperty(process, "platform", originalPlatform);
            }
        }
    });

    it("covers agent status route fallbacks for missing agents and default models", async () => {
        const originalConfig = await readFile(configPath, "utf8");
        const previousGatewayRequest = gateway.request;

        try {
            const missingAgent = await requestJson<{ error: string }>(
                server,
                "/api/agents/not-configured/status"
            );
            assert.equal(missingAgent.status, 404);
            assert.equal(missingAgent.body.error, "Agent 'not-configured' not found");

            await writeFile(
                configPath,
                JSON.stringify({
                    agents: {
                        list: [{ id: "bare-agent" }],
                    },
                }),
                "utf8"
            );
            gateway.request = async () => ({ sessions: [] });

            const allStatus = await requestJson<{
                agents: Array<{ id: string; model: string }>;
            }>(server, "/api/agents/status");
            assert.equal(allStatus.status, 200);
            assert.deepEqual(allStatus.body.agents, [
                {
                    id: "bare-agent",
                    status: "idle",
                    model: "unknown",
                    currentTask: null,
                    currentActivity: null,
                    lastActivity: null,
                    sessionKey: null,
                    channel: null,
                },
            ]);

            const singleStatus = await requestJson<{ id: string; model: string }>(
                server,
                "/api/agents/bare-agent/status"
            );
            assert.equal(singleStatus.status, 200);
            assert.equal(singleStatus.body.model, "unknown");

            const history = await requestJson<{ tasks: unknown[] }>(
                server,
                "/api/agents/tasks/history?limit=not-a-number"
            );
            assert.equal(history.status, 200);
            assert.ok(Array.isArray(history.body.tasks));
        } finally {
            gateway.request = previousGatewayRequest;
            await writeFile(configPath, originalConfig, "utf8");
        }
    });

    it("returns 404s when the agent config file is missing or malformed", async () => {
        const originalConfig = await readFile(configPath, "utf8");

        try {
            await rm(configPath, { force: true });
            const missingConfig = await requestJson<{ error: string }>(
                server,
                "/api/agents/config"
            );
            assert.equal(missingConfig.status, 404);
            assert.equal(missingConfig.body.error, "Agent configuration not found");

            const missingStatus = await requestJson<{ error: string }>(
                server,
                "/api/agents/status"
            );
            assert.equal(missingStatus.status, 404);
            assert.equal(missingStatus.body.error, "Agent configuration not found");

            const missingSingleStatus = await requestJson<{ error: string }>(
                server,
                `/api/agents/${agentId}/status`
            );
            assert.equal(missingSingleStatus.status, 404);
            assert.equal(missingSingleStatus.body.error, "Agent configuration not found");

            await writeFile(configPath, "{ agents: { list: 'not-array' }", "utf8");
            const malformed = await requestJson<{ error: string }>(
                server,
                "/api/agents/config"
            );
            assert.equal(malformed.status, 404);
            assert.equal(malformed.body.error, "Agent configuration not found");
        } finally {
            await writeFile(configPath, originalConfig, "utf8");
        }
    });

    it("falls back to cached Gateway sessions when live listing fails", async () => {
        const previousGatewaySessions = gateway.getSessions;
        const previousGatewayRequest = gateway.request;

        try {
            gateway.getSessions = () => [
                {
                    id: "cached-session",
                    key: "agent:alias-agent:main",
                    type: "MAIN",
                    agentType: "alias-agent",
                    hookName: "",
                    tokenCount: 0,
                    maxTokens: 200000,
                    createdAt: null,
                    displayName: "",
                    label: "",
                    displayLabel: "",
                    channel: "unknown",
                    status: "running",
                    model: "   ",
                    updatedAt: Date.parse("2026-05-16T16:00:00.000Z"),
                },
                {
                    id: "blank-key",
                    key: "",
                    type: "MAIN",
                    agentType: "alias-agent",
                    hookName: "",
                    model: "ignored",
                    tokenCount: 0,
                    maxTokens: 200000,
                    createdAt: null,
                    displayName: "",
                    label: "",
                    displayLabel: "",
                    channel: "unknown",
                    status: "running",
                    updatedAt: Date.parse("2026-05-16T17:00:00.000Z"),
                },
            ];
            gateway.request = async () => {
                throw new Error("Gateway unavailable");
            };

            const response = await requestJson<{
                status: string;
                sessionKey: string;
                model: string;
                lastActivity: string;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.status, "thinking");
            assert.equal(response.body.sessionKey, "agent:alias-agent:main");
            assert.equal(response.body.model, "gpt-5.5");
            assert.equal(response.body.lastActivity, "2026-05-16T16:00:00.000Z");
        } finally {
            gateway.getSessions = previousGatewaySessions;
            gateway.request = previousGatewayRequest;
        }
    });

    it("infers active task, tool activity, session key, and channel from files", async () => {
        const researcherSessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "researcher",
            "sessions"
        );
        await mkdir(researcherSessionsDir, { recursive: true });
        await writeFile(
            path.join(researcherSessionsDir, "sessions.json"),
            JSON.stringify([
                { key: "channel:discord:team", updatedAt: Date.now() - 10 },
                { key: "channel:telegram:old", updatedAt: Date.now() - 1000 },
            ]),
            "utf8"
        );
        await writeFile(
            path.join(researcherSessionsDir, "active.jsonl"),
            [
                "not json",
                JSON.stringify({
                    message: {
                        role: "user",
                        content:
                            'Sender: noisy metadata\n```json\n{"ignore":true}\n```\nResearch coverage gaps [media attached: screenshot]',
                    },
                }),
                JSON.stringify({
                    message: {
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                name: "functions.edit",
                                arguments: { path: "src/routes/agents.ts" },
                            },
                        ],
                    },
                }),
            ].join("\n"),
            "utf8"
        );

        const response = await requestJson<{
            id: string;
            status: string;
            model: string;
            currentTask: string;
            currentActivity: string;
            sessionKey: string;
            channel: string;
            lastActivity: string;
        }>(server, "/api/agents/researcher/status");

        assert.equal(response.status, 200);
        assert.equal(response.body.id, "researcher");
        assert.equal(response.body.status, "active");
        assert.equal(response.body.model, "hf:moonshotai/Kimi-K2.5");
        assert.equal(response.body.currentTask, "Research coverage gaps");
        assert.equal(response.body.currentActivity, "edit src/routes/agents.ts");
        assert.equal(response.body.sessionKey, "channel:discord:team");
        assert.equal(response.body.channel, "discord");
        assert.match(response.body.lastActivity, /^\d{4}-\d{2}-\d{2}T/u);
    });

    it("reads OpenClaw v4 trajectory activity and live Gateway session state", async () => {
        const aliasSessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "alias-agent",
            "sessions"
        );
        await rm(aliasSessionsDir, { recursive: true, force: true });
        await mkdir(aliasSessionsDir, { recursive: true });
        await writeFile(
            path.join(aliasSessionsDir, "active.trajectory.jsonl"),
            [
                JSON.stringify({
                    type: "prompt.submitted",
                    data: {
                        prompt: [
                            "Sender: noisy metadata",
                            '"""json'.replaceAll('"', "`"),
                            '{"ignore":true}',
                            '"""'.replaceAll('"', "`"),
                            "Fix agent activity [media attached: screenshot]",
                        ].join("\n"),
                    },
                }),
                JSON.stringify({
                    type: "tool.call",
                    data: {
                        name: "exec_command",
                        args: { cmd: "npm run test -- agents" },
                    },
                }),
                JSON.stringify({
                    type: "tool.call",
                    data: {
                        name: "message",
                        arguments: { message: "Lower priority status update" },
                    },
                }),
                JSON.stringify({
                    type: "tool.result",
                    data: {
                        name: "exec_command",
                        args: { cmd: "npm run result -- agents" },
                        success: true,
                    },
                }),
                JSON.stringify({
                    type: "tool.result",
                    data: {
                        name: "functions.message",
                        arguments: { message: "Namespaced delivery noise" },
                    },
                }),
            ].join("\n"),
            "utf8"
        );

        const gatewayUpdatedAt = new Date(Date.now() + 60_000).toISOString();
        const previousGatewayRequest = gateway.request;
        try {
            gateway.request = async (method: string) => {
                if (method === "sessions.list") {
                    return {
                        sessions: [
                            {
                                key: "Agent:Alias-Agent:Main",
                                model: "openai-codex/gpt-5.5",
                                status: "running",
                                updatedAt: gatewayUpdatedAt,
                            },
                        ],
                    };
                }

                throw new Error(`Unexpected gateway method: ${method}`);
            };

            const response = await requestJson<{
                status: string;
                currentTask: string;
                currentActivity: string;
                sessionKey: string;
                lastActivity: string;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.status, "active");
            assert.equal(response.body.currentTask, "Fix agent activity");
            assert.equal(response.body.currentActivity, "exec npm run result -- agents");
            assert.equal(response.body.sessionKey, "Agent:Alias-Agent:Main");
            assert.equal(response.body.lastActivity, gatewayUpdatedAt);
        } finally {
            gateway.request = previousGatewayRequest;
            await rm(path.join(homeDir, ".openclaw", "agents", "alias-agent"), {
                recursive: true,
                force: true,
            });
        }
    });

    it("shows memory search activity while still ignoring message delivery noise", async () => {
        const aliasSessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "alias-agent",
            "sessions"
        );
        await rm(aliasSessionsDir, { recursive: true, force: true });
        await mkdir(aliasSessionsDir, { recursive: true });

        const jsonlPath = path.join(aliasSessionsDir, "active.jsonl");
        const trajectoryPath = path.join(aliasSessionsDir, "active.trajectory.jsonl");
        await writeFile(
            jsonlPath,
            [
                JSON.stringify({
                    message: {
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                name: "memory_search",
                                arguments: { query: "old context" },
                            },
                        ],
                    },
                }),
                JSON.stringify({
                    message: {
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                name: "bash",
                                arguments: { command: "npm run build" },
                            },
                        ],
                    },
                }),
            ].join("\n"),
            "utf8"
        );
        await writeFile(
            trajectoryPath,
            [
                JSON.stringify({
                    type: "tool.call",
                    data: {
                        name: "message",
                        arguments: { message: "latest delivery update" },
                    },
                }),
                JSON.stringify({
                    type: "tool.result",
                    data: {
                        name: "functions.memory_search",
                        arguments: { query: "latest recall" },
                    },
                }),
            ].join("\n"),
            "utf8"
        );

        const oldTime = new Date(Date.now() - 2_000);
        const newTime = new Date(Date.now());
        await utimes(jsonlPath, oldTime, oldTime);
        await utimes(trajectoryPath, newTime, newTime);

        const previousGatewayRequest = gateway.request;
        try {
            gateway.request = async (method: string) => {
                if (method === "sessions.list") {
                    return {
                        sessions: [
                            {
                                key: "agent:alias-agent:main",
                                model: "openai-codex/gpt-5.5",
                                status: "running",
                                updatedAt: newTime.toISOString(),
                            },
                        ],
                    };
                }

                throw new Error(`Unexpected gateway method: ${method}`);
            };

            const response = await requestJson<{
                status: string;
                currentActivity: string;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.status, "active");
            assert.equal(response.body.currentActivity, "memory_search latest recall");
        } finally {
            gateway.request = previousGatewayRequest;
            await rm(path.join(homeDir, ".openclaw", "agents", "alias-agent"), {
                recursive: true,
                force: true,
            });
        }
    });

    it("does not combine a fresh task with stale activity from another session file", async () => {
        const aliasSessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "alias-agent",
            "sessions"
        );
        await rm(aliasSessionsDir, { recursive: true, force: true });
        await mkdir(aliasSessionsDir, { recursive: true });

        const oldJsonlPath = path.join(aliasSessionsDir, "old.jsonl");
        const freshTrajectoryPath = path.join(aliasSessionsDir, "fresh.trajectory.jsonl");
        await writeFile(
            oldJsonlPath,
            JSON.stringify({
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            name: "bash",
                            arguments: { command: "npm run old-task" },
                        },
                    ],
                    __openclaw: {
                        mirrorIdentity: "old-turn:tool:call",
                    },
                },
            }),
            "utf8"
        );
        await writeFile(
            freshTrajectoryPath,
            [
                JSON.stringify({
                    type: "tool.call",
                    runId: "old-run",
                    data: {
                        name: "browser",
                        arguments: {
                            action: "open",
                            url: "http://127.0.0.1:3100/chat",
                        },
                    },
                }),
                JSON.stringify({
                    type: "session.started",
                    runId: "fresh-run",
                    data: {},
                }),
                JSON.stringify({
                    type: "prompt.submitted",
                    runId: "fresh-run",
                    data: {
                        prompt: "Investigate fresh agent activity",
                        turnId: "fresh-turn",
                    },
                }),
                JSON.stringify({
                    type: "tool.call",
                    runId: "fresh-run",
                    data: {
                        name: "message",
                        arguments: { message: "latest delivery update" },
                    },
                }),
            ].join("\n"),
            "utf8"
        );

        const oldTime = new Date(Date.now() - 2_000);
        const newTime = new Date(Date.now());
        await utimes(oldJsonlPath, oldTime, oldTime);
        await utimes(freshTrajectoryPath, newTime, newTime);

        const previousGatewayRequest = gateway.request;
        try {
            gateway.request = async (method: string) => {
                if (method === "sessions.list") {
                    return {
                        sessions: [
                            {
                                key: "agent:alias-agent:main",
                                model: "openai-codex/gpt-5.5",
                                status: "running",
                                updatedAt: newTime.toISOString(),
                            },
                        ],
                    };
                }

                throw new Error(`Unexpected gateway method: ${method}`);
            };

            const response = await requestJson<{
                status: string;
                currentTask: string;
                currentActivity: string | null;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.status, "thinking");
            assert.equal(response.body.currentTask, "Investigate fresh agent activity");
            assert.equal(response.body.currentActivity, null);
        } finally {
            gateway.request = previousGatewayRequest;
            await rm(path.join(homeDir, ".openclaw", "agents", "alias-agent"), {
                recursive: true,
                force: true,
            });
        }
    });

    it("combines fresh trajectory task with visible activity from the same session log", async () => {
        const aliasSessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "alias-agent",
            "sessions"
        );
        await rm(aliasSessionsDir, { recursive: true, force: true });
        await mkdir(aliasSessionsDir, { recursive: true });

        const jsonlPath = path.join(aliasSessionsDir, "active.jsonl");
        const trajectoryPath = path.join(aliasSessionsDir, "active.trajectory.jsonl");
        await writeFile(
            jsonlPath,
            JSON.stringify({
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            name: "bash",
                            arguments: { command: "gh pr checks 55" },
                        },
                    ],
                    __openclaw: {
                        mirrorIdentity: "fresh-turn:tool:call",
                    },
                },
            }),
            "utf8"
        );
        await writeFile(
            trajectoryPath,
            [
                JSON.stringify({
                    type: "session.started",
                    runId: "fresh-run",
                    data: {},
                }),
                JSON.stringify({
                    type: "prompt.submitted",
                    runId: "fresh-run",
                    data: {
                        prompt: "Fix current activity fallback",
                        turnId: "fresh-turn",
                    },
                }),
                JSON.stringify({
                    type: "tool.call",
                    runId: "fresh-run",
                    data: {
                        name: "message",
                        arguments: { message: "latest delivery update" },
                    },
                }),
            ].join("\n"),
            "utf8"
        );

        const oldTime = new Date(Date.now() - 2_000);
        const newTime = new Date(Date.now());
        await utimes(jsonlPath, oldTime, oldTime);
        await utimes(trajectoryPath, newTime, newTime);

        const previousGatewayRequest = gateway.request;
        try {
            gateway.request = async (method: string) => {
                if (method === "sessions.list") {
                    return {
                        sessions: [
                            {
                                key: "agent:alias-agent:main",
                                model: "openai-codex/gpt-5.5",
                                status: "running",
                                updatedAt: newTime.toISOString(),
                            },
                        ],
                    };
                }

                throw new Error(`Unexpected gateway method: ${method}`);
            };

            const response = await requestJson<{
                status: string;
                currentTask: string;
                currentActivity: string | null;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.status, "active");
            assert.equal(response.body.currentTask, "Fix current activity fallback");
            assert.equal(response.body.currentActivity, "exec gh pr checks 55");
        } finally {
            gateway.request = previousGatewayRequest;
            await rm(path.join(homeDir, ".openclaw", "agents", "alias-agent"), {
                recursive: true,
                force: true,
            });
        }
    });

    it("does not compare trajectory run IDs against transcript turn IDs", async () => {
        const aliasSessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "alias-agent",
            "sessions"
        );
        await rm(aliasSessionsDir, { recursive: true, force: true });
        await mkdir(aliasSessionsDir, { recursive: true });

        const jsonlPath = path.join(aliasSessionsDir, "active.jsonl");
        const trajectoryPath = path.join(aliasSessionsDir, "active.trajectory.jsonl");
        await writeFile(
            trajectoryPath,
            JSON.stringify({
                type: "prompt.submitted",
                runId: "fresh-run",
                data: {
                    prompt: "Run without explicit turn id",
                },
            }),
            "utf8"
        );
        await writeFile(
            jsonlPath,
            JSON.stringify({
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            name: "bash",
                            arguments: { command: "npm run no-turn" },
                        },
                    ],
                    __openclaw: {
                        mirrorIdentity: "transcript-turn:tool:call",
                    },
                },
            }),
            "utf8"
        );

        const now = Date.now();
        await utimes(trajectoryPath, new Date(now), new Date(now));
        await utimes(jsonlPath, new Date(now - 1_000), new Date(now - 1_000));

        const previousGatewayRequest = gateway.request;
        try {
            gateway.request = async (method: string) => {
                if (method === "sessions.list") {
                    return {
                        sessions: [
                            {
                                key: "agent:alias-agent:main",
                                model: "openai-codex/gpt-5.5",
                                status: "running",
                                updatedAt: new Date(now).toISOString(),
                            },
                        ],
                    };
                }

                throw new Error("Unexpected gateway method: " + method);
            };

            const response = await requestJson<{
                currentTask: string;
                currentActivity: string | null;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.currentTask, "Run without explicit turn id");
            assert.equal(response.body.currentActivity, "exec npm run no-turn");
        } finally {
            gateway.request = previousGatewayRequest;
            await rm(path.join(homeDir, ".openclaw", "agents", "alias-agent"), {
                recursive: true,
                force: true,
            });
        }
    });

    it("ignores runless stale entries after locking onto the latest trajectory run", async () => {
        const aliasSessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "alias-agent",
            "sessions"
        );
        await rm(aliasSessionsDir, { recursive: true, force: true });
        await mkdir(aliasSessionsDir, { recursive: true });

        const trajectoryPath = path.join(aliasSessionsDir, "active.trajectory.jsonl");
        await writeFile(
            trajectoryPath,
            [
                JSON.stringify({
                    type: "response_item",
                    payload: {
                        type: "custom_tool_call",
                        name: "exec",
                        input: "await tools.exec_command({ cmd: `npm run stale` });",
                    },
                }),
                JSON.stringify({
                    type: "session.started",
                    runId: "fresh-run",
                    data: {},
                }),
                JSON.stringify({
                    type: "response_item",
                    payload: {
                        type: "custom_tool_call",
                        name: "exec",
                        input: "await tools.exec_command({ cmd: `npm run also-stale` });",
                    },
                }),
                JSON.stringify({
                    type: "tool.call",
                    runId: "fresh-run",
                    data: {
                        name: "message",
                        arguments: { message: "delivery only" },
                    },
                }),
            ].join("\n"),
            "utf8"
        );

        const now = Date.now();
        await utimes(trajectoryPath, new Date(now), new Date(now));

        const previousGatewayRequest = gateway.request;
        try {
            gateway.request = async (method: string) => {
                if (method === "sessions.list") {
                    return {
                        sessions: [
                            {
                                key: "agent:alias-agent:main",
                                model: "openai-codex/gpt-5.5",
                                status: "running",
                                updatedAt: new Date(now).toISOString(),
                            },
                        ],
                    };
                }

                throw new Error("Unexpected gateway method: " + method);
            };

            const response = await requestJson<{
                status: string;
                currentActivity: string | null;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.status, "thinking");
            assert.equal(response.body.currentActivity, null);
        } finally {
            gateway.request = previousGatewayRequest;
            await rm(path.join(homeDir, ".openclaw", "agents", "alias-agent"), {
                recursive: true,
                force: true,
            });
        }
    });

    it("continues within the newest session group when unrelated files are interleaved by mtime", async () => {
        const aliasSessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "alias-agent",
            "sessions"
        );
        await rm(aliasSessionsDir, { recursive: true, force: true });
        await mkdir(aliasSessionsDir, { recursive: true });

        const activeJsonlPath = path.join(aliasSessionsDir, "active.jsonl");
        const activeTrajectoryPath = path.join(
            aliasSessionsDir,
            "active.trajectory.jsonl"
        );
        const unrelatedPath = path.join(aliasSessionsDir, "other.jsonl");
        await writeFile(
            activeTrajectoryPath,
            JSON.stringify({
                type: "prompt.submitted",
                runId: "fresh-run",
                data: {
                    prompt: "Keep scanning active group",
                    turnId: "fresh-turn",
                },
            }),
            "utf8"
        );
        await writeFile(
            unrelatedPath,
            JSON.stringify({
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            name: "bash",
                            arguments: { command: "npm run unrelated" },
                        },
                    ],
                },
            }),
            "utf8"
        );
        await writeFile(
            activeJsonlPath,
            JSON.stringify({
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            name: "bash",
                            arguments: { command: "npm run active" },
                        },
                    ],
                    __openclaw: {
                        mirrorIdentity: "fresh-turn:tool:call",
                    },
                },
            }),
            "utf8"
        );

        const now = Date.now();
        await utimes(activeTrajectoryPath, new Date(now), new Date(now));
        await utimes(unrelatedPath, new Date(now - 1_000), new Date(now - 1_000));
        await utimes(activeJsonlPath, new Date(now - 2_000), new Date(now - 2_000));

        const previousGatewayRequest = gateway.request;
        try {
            gateway.request = async (method: string) => {
                if (method === "sessions.list") {
                    return {
                        sessions: [
                            {
                                key: "agent:alias-agent:main",
                                model: "openai-codex/gpt-5.5",
                                status: "running",
                                updatedAt: new Date(now).toISOString(),
                            },
                        ],
                    };
                }

                throw new Error(`Unexpected gateway method: ${method}`);
            };

            const response = await requestJson<{
                currentTask: string;
                currentActivity: string | null;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.currentTask, "Keep scanning active group");
            assert.equal(response.body.currentActivity, "exec npm run active");
        } finally {
            gateway.request = previousGatewayRequest;
            await rm(path.join(homeDir, ".openclaw", "agents", "alias-agent"), {
                recursive: true,
                force: true,
            });
        }
    });

    it("uses nested Codex rollout logs for the freshest visible activity", async () => {
        const aliasAgentDir = path.join(homeDir, ".openclaw", "agents", "alias-agent");
        const aliasSessionsDir = path.join(aliasAgentDir, "sessions");
        const codexSessionsDir = path.join(
            aliasAgentDir,
            "agent",
            "codex-home",
            "sessions",
            "2026",
            "05",
            "16"
        );
        const unreadableCodexDir = path.join(
            aliasAgentDir,
            "agent",
            "codex-home",
            "sessions",
            "unreadable"
        );
        await rm(aliasAgentDir, { recursive: true, force: true });
        await mkdir(aliasSessionsDir, { recursive: true });
        await mkdir(codexSessionsDir, { recursive: true });
        await mkdir(unreadableCodexDir, { recursive: true });
        await chmod(unreadableCodexDir, 0);

        const gatewayTrajectoryPath = path.join(
            aliasSessionsDir,
            "active.trajectory.jsonl"
        );
        const codexRolloutPath = path.join(codexSessionsDir, "rollout.jsonl");
        await writeFile(
            gatewayTrajectoryPath,
            [
                JSON.stringify({
                    type: "prompt.submitted",
                    runId: "gateway-run",
                    data: {
                        prompt: "Use Codex rollout activity with trajectory task",
                        turnId: "fresh-turn",
                    },
                }),
                JSON.stringify({
                    type: "tool.call",
                    runId: "gateway-run",
                    data: {
                        name: "session_status",
                        arguments: {},
                    },
                }),
            ].join("\n"),
            "utf8"
        );
        await writeFile(
            codexRolloutPath,
            [
                JSON.stringify({
                    type: "response_item",
                    payload: {
                        type: "custom_tool_call",
                        name: "exec",
                        input: "await tools.exec_command({ cmd: `npm run agents:test` });",
                    },
                }),
                JSON.stringify({
                    type: "response_item",
                    payload: {
                        type: "custom_tool_call",
                        name: "exec",
                        input: 'await tools.mcp__server__memory_search({ query: "context" });',
                    },
                }),
                JSON.stringify({
                    type: "response_item",
                    payload: {
                        type: "custom_tool_call",
                        name: "exec",
                        input: "const r = await tools.write_stdin({ session_id: 123 });",
                    },
                }),
                JSON.stringify({
                    type: "response_item",
                    payload: {
                        type: "custom_tool_call",
                        name: "exec",
                        input: 'await tools.message({ action: "send", message: "done" });',
                    },
                }),
            ].join("\n"),
            "utf8"
        );

        const now = Date.now();
        await utimes(gatewayTrajectoryPath, new Date(now - 2_000), new Date(now - 2_000));
        await utimes(codexRolloutPath, new Date(now), new Date(now));

        const previousGatewayRequest = gateway.request;
        try {
            gateway.request = async (method: string) => {
                if (method === "sessions.list") {
                    return {
                        sessions: [
                            {
                                key: "agent:alias-agent:main",
                                model: "openai-codex/gpt-5.5",
                                status: "running",
                                updatedAt: new Date(now).toISOString(),
                            },
                        ],
                    };
                }

                throw new Error("Unexpected gateway method: " + method);
            };

            const response = await requestJson<{
                status: string;
                currentTask: string | null;
                currentActivity: string | null;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.status, "active");
            assert.equal(
                response.body.currentTask,
                "Use Codex rollout activity with trajectory task"
            );
            assert.equal(response.body.currentActivity, "terminal output");
        } finally {
            gateway.request = previousGatewayRequest;
            await chmod(unreadableCodexDir, 0o700).catch(() => {});
            await rm(aliasAgentDir, { recursive: true, force: true });
        }
    });

    it("continues scanning grouped logs when one file is unreadable", async () => {
        const aliasAgentDir = path.join(homeDir, ".openclaw", "agents", "alias-agent");
        const aliasSessionsDir = path.join(aliasAgentDir, "sessions");
        await rm(aliasAgentDir, { recursive: true, force: true });
        await mkdir(aliasSessionsDir, { recursive: true });

        const unreadablePath = path.join(aliasSessionsDir, "active.jsonl");
        const trajectoryPath = path.join(aliasSessionsDir, "active.trajectory.jsonl");
        await writeFile(unreadablePath, "not readable", "utf8");
        await writeFile(
            trajectoryPath,
            JSON.stringify({
                type: "tool.call",
                runId: "fresh-run",
                data: {
                    name: "exec_command",
                    arguments: { cmd: "npm run readable" },
                },
            }),
            "utf8"
        );

        const now = Date.now();
        await utimes(unreadablePath, new Date(now), new Date(now));
        await utimes(trajectoryPath, new Date(now - 1_000), new Date(now - 1_000));
        await chmod(unreadablePath, 0);

        const previousGatewayRequest = gateway.request;
        try {
            gateway.request = async (method: string) => {
                if (method === "sessions.list") {
                    return {
                        sessions: [
                            {
                                key: "agent:alias-agent:main",
                                model: "openai-codex/gpt-5.5",
                                status: "running",
                                updatedAt: new Date(now).toISOString(),
                            },
                        ],
                    };
                }

                throw new Error("Unexpected gateway method: " + method);
            };

            const response = await requestJson<{
                currentActivity: string | null;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.currentActivity, "exec npm run readable");
        } finally {
            gateway.request = previousGatewayRequest;
            await chmod(unreadablePath, 0o600).catch(() => {});
            await rm(aliasAgentDir, { recursive: true, force: true });
        }
    });

    it("sorts live Gateway agent sessions by normalized timestamps", async () => {
        const previousGatewayRequest = gateway.request;
        try {
            gateway.request = async (method: string) => {
                if (method === "sessions.list") {
                    return {
                        sessions: [
                            {
                                key: "agent:alias-agent:old",
                                model: "old-model",
                                updatedAt: 1778932800000,
                            },
                            {
                                key: "agent:alias-agent:new",
                                model: "new-model",
                                updatedAt: "2026-05-16T13:00:00.000Z",
                            },
                        ],
                    };
                }

                throw new Error(`Unexpected gateway method: ${method}`);
            };

            const response = await requestJson<{
                sessionKey: string;
                model: string;
                lastActivity: string;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.sessionKey, "agent:alias-agent:new");
            assert.equal(response.body.model, "new-model");
            assert.equal(response.body.lastActivity, "2026-05-16T13:00:00.000Z");
        } finally {
            gateway.request = previousGatewayRequest;
        }
    });

    it("prefers main live Gateway sessions case-insensitively", async () => {
        const previousGatewayRequest = gateway.request;
        try {
            gateway.request = async (method: string) => {
                if (method === "sessions.list") {
                    return {
                        sessions: [
                            {
                                key: "agent:alias-agent:scratch",
                                model: "scratch-model",
                                updatedAt: "2026-05-16T14:00:00.000Z",
                            },
                            {
                                key: "Agent:Alias-Agent:Main",
                                model: "main-model",
                                updatedAt: "2026-05-16T13:00:00.000Z",
                            },
                        ],
                    };
                }

                throw new Error(`Unexpected gateway method: ${method}`);
            };

            const response = await requestJson<{
                sessionKey: string;
                model: string;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.sessionKey, "Agent:Alias-Agent:Main");
            assert.equal(response.body.model, "main-model");
        } finally {
            gateway.request = previousGatewayRequest;
        }
    });

    it("falls back to the best live Gateway session when file session key is stale", async () => {
        const aliasSessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "alias-agent",
            "sessions"
        );
        await rm(aliasSessionsDir, { recursive: true, force: true });
        await mkdir(aliasSessionsDir, { recursive: true });
        await writeFile(
            path.join(aliasSessionsDir, "sessions.json"),
            JSON.stringify([{ key: "channel:discord:stale", updatedAt: Date.now() }]),
            "utf8"
        );

        const previousGatewayRequest = gateway.request;
        try {
            gateway.request = async (method: string) => {
                if (method === "sessions.list") {
                    return {
                        sessions: [
                            {
                                key: "agent:alias-agent:main",
                                model: "live-model",
                                status: "running",
                                updatedAt: "2026-05-16T13:00:00.000Z",
                            },
                        ],
                    };
                }

                throw new Error(`Unexpected gateway method: ${method}`);
            };

            const response = await requestJson<{
                status: string;
                sessionKey: string;
                channel: string | null;
                model: string;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.status, "thinking");
            assert.equal(response.body.sessionKey, "agent:alias-agent:main");
            assert.equal(response.body.channel, null);
            assert.equal(response.body.model, "live-model");
        } finally {
            gateway.request = previousGatewayRequest;
            await rm(path.join(homeDir, ".openclaw", "agents", "alias-agent"), {
                recursive: true,
                force: true,
            });
        }
    });

    it("rejects symlink aliases to another agent's sessions", async () => {
        const agentsRoot = path.join(homeDir, ".openclaw", "agents");
        const aliasPath = path.join(agentsRoot, "alias-agent");
        await rm(aliasPath, { recursive: true, force: true });
        try {
            await symlink("researcher", aliasPath, "dir");

            const response = await requestJson<{
                id: string;
                currentTask: string | null;
                currentActivity: string | null;
                sessionKey: string | null;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.id, "alias-agent");
            assert.equal(response.body.currentTask, null);
            assert.equal(response.body.currentActivity, null);
            assert.equal(response.body.sessionKey, null);
        } finally {
            await rm(aliasPath, { recursive: true, force: true });
        }
    });

    it("returns 404s when config or agent entries are missing", async () => {
        const missingAgent = await requestJson<{ error: string }>(
            server,
            "/api/agents/missing/status"
        );
        assert.equal(missingAgent.status, 404);
        assert.equal(missingAgent.body.error, "Agent 'missing' not found");
    });

    it("covers filesystem and parser fallback branches in agent helpers", async () => {
        const { __testing } = await import("./agents.js");
        const fsModule = await import("node:fs");
        const originalRealpathSync = fsModule.default.realpathSync;

        try {
            let realpathCalls = 0;
            fsModule.default.realpathSync = ((target: string | URL | Buffer) => {
                realpathCalls += 1;
                if (realpathCalls === 1) {
                    throw new Error("realpath unavailable");
                }
                return originalRealpathSync(target);
            }) as typeof fsModule.default.realpathSync;
            assert.equal(__testing.getSafeAgentSessionsDir(agentId), null);

            fsModule.default.realpathSync = ((target: string | URL | Buffer) => {
                const value = originalRealpathSync(target).toString();
                return value.endsWith(`${path.sep}${agentId}${path.sep}sessions`)
                    ? `${value}-mismatch`
                    : value;
            }) as typeof fsModule.default.realpathSync;
            assert.equal(__testing.getSafeAgentSessionsDir(agentId), null);

            fsModule.default.realpathSync = originalRealpathSync;
            const unreadableRoot = {
                dir: path.join(homeDir, ".openclaw", "agents", "missing-root"),
                recursive: false,
            };
            assert.deepEqual(__testing.listActivityLogFiles(unreadableRoot), []);

            const scanRoot = path.join(
                homeDir,
                ".openclaw",
                "agents",
                "scan-agent",
                "sessions"
            );
            await rm(scanRoot, { recursive: true, force: true });
            await mkdir(path.join(scanRoot, "nested"), { recursive: true });
            await writeFile(path.join(scanRoot, "active.jsonl"), "{}", "utf8");
            await writeFile(path.join(scanRoot, "nested", "deep.jsonl"), "{}", "utf8");
            await writeFile(path.join(scanRoot, "ignore.txt"), "{}", "utf8");

            const flatFiles = __testing.listActivityLogFiles({
                dir: scanRoot,
                recursive: false,
            });
            assert.deepEqual(
                flatFiles.map((file: { name: string }) => file.name),
                ["active.jsonl"]
            );
            const recursiveFiles = __testing.listActivityLogFiles({
                dir: scanRoot,
                recursive: true,
            });
            assert.equal(
                recursiveFiles.some(
                    (file: { name: string }) =>
                        file.name === path.join("nested", "deep.jsonl")
                ),
                true
            );

            const brokenStatRoot = path.join(
                homeDir,
                ".openclaw",
                "agents",
                "broken-stat-agent",
                "sessions"
            );
            await mkdir(brokenStatRoot, { recursive: true });
            await symlink("missing.jsonl", path.join(brokenStatRoot, "broken.jsonl"));
            assert.deepEqual(
                __testing
                    .listActivityLogFiles({ dir: brokenStatRoot, recursive: false })
                    .map((file: { name: string }) => file.name),
                []
            );

            await writeFile(
                path.join(
                    homeDir,
                    ".openclaw",
                    "agents",
                    agentId,
                    "sessions",
                    "sessions.json"
                ),
                "{bad",
                "utf8"
            );
            assert.deepEqual(await __testing.getAgentSessionsFromFiles(agentId), []);

            assert.equal(__testing.parseAgentsConfig()?.list.length, 3);
            await writeFile(configPath, JSON.stringify({ agents: { list: [] } }), "utf8");
            assert.equal(__testing.parseAgentsConfig()?.defaults?.model, undefined);
        } finally {
            fsModule.default.realpathSync = originalRealpathSync;
            await writeFile(
                configPath,
                JSON.stringify(
                    {
                        agents: {
                            defaults: {
                                model: { primary: "codex" },
                                models: {
                                    "openai-codex/gpt-5.5": { alias: "codex" },
                                },
                            },
                            list: [
                                { id: agentId, default: true },
                                {
                                    id: "researcher",
                                    model: {
                                        primary: "synthetic/hf:moonshotai/Kimi-K2.5",
                                    },
                                },
                                { id: "alias-agent" },
                            ],
                        },
                    },
                    null,
                    2
                )
            );
        }
    });

    it("covers remaining agent activity and Gateway helper branches", async () => {
        const { __testing } = await import("./agents.js");

        const savedHome = process.env.HOME;
        const savedDashboardOpenclawHome = process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
        const savedOpenclawHome = process.env.OPENCLAW_HOME;
        const originalHomedir = os.homedir;
        let blankHomeServer: http.Server | null = null;
        try {
            process.env.HOME = "";
            os.homedir = (() => "") as typeof os.homedir;
            const { default: blankHomeAgentsRoutes, __testing: blankHomeTesting } =
                await import(`./agents.js?empty-home=${Date.now()}`);
            assert.equal(blankHomeTesting.parseAgentsConfig(), null);
            const blankHomeApp = express();
            blankHomeApp.use(express.json());
            blankHomeAgentsRoutes(blankHomeApp);
            blankHomeServer = http.createServer(blankHomeApp);
            await new Promise<void>((resolve, reject) => {
                blankHomeServer?.once("error", reject);
                blankHomeServer?.listen(0, resolve);
            });
            const blankHomeAddress = blankHomeServer.address();
            assert.ok(blankHomeAddress && typeof blankHomeAddress === "object");
            const blankHomeResponse = await fetch(
                `http://127.0.0.1:${blankHomeAddress.port}/api/agents/blank-home/metadata`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ currentTask: "blocked" }),
                }
            );
            assert.equal(blankHomeResponse.status, 500);
            for (const pathName of [
                "/api/agents/config",
                "/api/agents/status",
                "/api/agents/blank-home/status",
            ]) {
                const response = await fetch(
                    `http://127.0.0.1:${blankHomeAddress.port}${pathName}`
                );
                assert.equal(response.status, 500);
                assert.deepEqual(await response.json(), {
                    error: "Agent home directory is not configured",
                });
            }

            const envOpenclawRoot = await mkdtemp(
                path.join(os.tmpdir(), "mira-agents-env-root-")
            );
            try {
                process.env.MIRA_DASHBOARD_OPENCLAW_HOME = envOpenclawRoot;
                delete process.env.OPENCLAW_HOME;
                const envAgentId = "env-root-agent";
                const envSessionsDir = path.join(
                    envOpenclawRoot,
                    "agents",
                    envAgentId,
                    "sessions"
                );
                await mkdir(envSessionsDir, { recursive: true });
                const { __testing: envRootTesting } = await import(
                    `./agents.js?env-root=${Date.now()}`
                );
                assert.equal(
                    envRootTesting.getSafeAgentSessionsDir(envAgentId),
                    envSessionsDir
                );
            } finally {
                await rm(envOpenclawRoot, { recursive: true, force: true });
                delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
            }

            process.env.MIRA_DASHBOARD_OPENCLAW_HOME = "relative-home";
            delete process.env.OPENCLAW_HOME;
            const { __testing: invalidEnvTesting } = await import(
                `./agents.js?invalid-env-root=${Date.now()}`
            );
            assert.equal(invalidEnvTesting.getSafeAgentSessionsDir("main"), null);
            delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;

            process.env.HOME = "relative-home";
            os.homedir = (() => "relative-home") as typeof os.homedir;
            await import(`./agents.js?relative-home=${Date.now()}`);

            delete process.env.HOME;
            os.homedir = (() => originalHomedir()) as typeof os.homedir;
            await import(`./agents.js?homedir-home=${Date.now()}`);
        } finally {
            if (blankHomeServer) {
                await new Promise<void>((resolve, reject) =>
                    blankHomeServer?.close((error) => (error ? reject(error) : resolve()))
                );
            }
            os.homedir = originalHomedir;
            process.env.HOME = savedHome;
            if (savedDashboardOpenclawHome === undefined) {
                delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
            } else {
                process.env.MIRA_DASHBOARD_OPENCLAW_HOME = savedDashboardOpenclawHome;
            }
            if (savedOpenclawHome === undefined) {
                delete process.env.OPENCLAW_HOME;
            } else {
                process.env.OPENCLAW_HOME = savedOpenclawHome;
            }
        }

        assert.equal(__testing.toDisplayModelName("plain-model"), "plain-model");
        assert.equal(
            __testing.resolveConfiguredModelName("plain-model", {
                defaults: {},
                list: [],
            }),
            "plain-model"
        );
        assert.equal(__testing.toTimestamp(""), null);

        assert.equal(
            __testing.summarizeToolActivity("custom", { arguments: null }),
            "custom"
        );
        assert.equal(
            __testing.summarizeToolActivity("custom", { parameters: null }),
            "custom"
        );
        assert.equal(__testing.summarizeToolActivity("custom", 7), "custom");
        assert.equal(
            __testing
                .summarizeToolActivity("browser", { action: "open" })
                .startsWith("browser open"),
            true
        );
        assert.equal(
            __testing.summarizeToolActivity("custom", { arguments: { paths: [] } }),
            "custom"
        );
        assert.equal(
            __testing.summarizeToolActivity("custom", { parameters: { paths: [] } }),
            "custom"
        );
        assert.equal(
            __testing.summarizeToolActivity("custom", {
                partialJson: '{"paths":[]}',
            }),
            "custom"
        );
        assert.equal(
            __testing.summarizeToolActivity("custom", {
                partialJson: '{"paths":["partial-array.ts"]}',
            }),
            "custom partial-array.ts"
        );
        assert.equal(
            __testing.summarizeToolActivity("custom", {
                partialJson: '{"paths":"not-array"}',
            }),
            "custom"
        );
        assert.equal(__testing.normalizeToolName("plain"), "plain");

        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.call",
                data: { name: "exec", arguments: { cmd: "npm test" } },
            }),
            { activity: "exec npm test" }
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.result",
                data: { name: "exec", parameters: { cmd: "npm run build" } },
            }),
            { activity: "exec npm run build" }
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.result",
                data: { name: "exec", input: { cmd: "npm run lint" } },
            }),
            { activity: "exec npm run lint" }
        );
        assert.equal(
            __testing.getCodexResponseItemActivity({
                type: "response_item",
                payload: { type: "custom_tool_call", name: 7, input: "" },
            }),
            null
        );
        assert.equal(
            __testing.getCodexResponseItemActivity({
                type: "response_item",
                payload: { type: "custom_tool_call", name: "exec", input: 7 },
            }),
            "exec"
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.call",
                data: { name: "exec" },
            }),
            { activity: "exec" }
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.call",
                data: { name: "exec", cmd: "npm run flat" },
            }),
            { activity: "exec npm run flat" }
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.call",
                data: { name: "exec", parameters: { cmd: "npm run typecheck" } },
            }),
            { activity: "exec npm run typecheck" }
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.call",
                data: { name: "message", args: { message: "hidden" } },
            }),
            {}
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.call",
                data: { name: 7, args: { command: "hidden" } },
            }),
            {}
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.result",
                data: { name: "exec", arguments: { cmd: "npm run result:args" } },
            }),
            { activity: "exec npm run result:args" }
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.result",
                data: { name: "exec", args: { cmd: "npm run result" } },
            }),
            { activity: "exec npm run result" }
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.result",
                data: { name: "exec" },
            }),
            { activity: "exec" }
        );
        assert.deepEqual(
            __testing.getTrajectoryActivity({
                type: "tool.result",
                data: { name: "exec", cmd: "npm run result:flat" },
            }),
            { activity: "exec npm run result:flat" }
        );

        const sessions = [
            {
                key: "agent:alias-agent:side",
                model: "",
                updatedAt: null,
            },
            {
                key: "agent:alias-agent:latest",
                model: "latest",
                updatedAt: Date.parse("2026-05-16T17:00:00.000Z"),
            },
        ];
        assert.equal(
            __testing.findBestSessionForAgent("alias-agent", sessions)?.key,
            "agent:alias-agent:latest"
        );
        assert.equal(
            __testing.findBestSessionForAgent("alias-agent", [
                {
                    key: "agent:alias-agent:worker",
                    model: "worker",
                    updatedAt: Date.parse("2026-05-16T17:00:00.000Z"),
                },
                {
                    key: "agent:alias-agent:side",
                    model: "side",
                    updatedAt: Date.parse("2026-05-16T17:00:01.000Z"),
                },
            ])?.key,
            "agent:alias-agent:side"
        );
        assert.equal(
            __testing.findBestSessionForAgent("alias-agent", [
                {
                    key: "agent:alias-agent:side",
                    model: "side",
                    updatedAt: Number.NaN,
                },
                {
                    key: "agent:alias-agent:main",
                    model: "main",
                    updatedAt: Number.NaN,
                },
            ])?.key,
            "agent:alias-agent:main"
        );
        assert.equal(__testing.findBestSessionForAgent("missing", sessions), undefined);
        assert.equal(
            __testing.findSessionByKey(sessions, "agent:alias-agent:missing"),
            undefined
        );
        assert.equal(__testing.getChannelFromSessionKey("channel:"), null);
        assert.equal(__testing.determineStatus(Date.now() - 20_000), "thinking");
        assert.equal(
            __testing.isGatewaySessionRunning({
                key: "agent:alias-agent:main",
                model: "main",
                running: true,
            }),
            true
        );
        assert.equal(
            __testing.isGatewaySessionRunning({
                key: "agent:alias-agent:main",
                model: "main",
                isRunning: true,
            }),
            true
        );
        assert.equal(
            __testing.isGatewaySessionRunning({
                key: "agent:alias-agent:main",
                model: "main",
                currentRunId: "run-2",
            }),
            true
        );
        assert.equal(
            __testing.isGatewaySessionRunning({
                key: "agent:alias-agent:main",
                model: "main",
                endedAt: Date.now(),
                running: true,
            }),
            false
        );
        const statusWithActivity = {
            id: "alias-agent",
            status: "idle" as const,
            model: "unknown",
            currentTask: null,
            currentActivity: "exec npm test",
            lastActivity: null,
            sessionKey: null,
            channel: null,
        };
        __testing.applyGatewaySessionStatus(statusWithActivity, {
            key: "agent:alias-agent:main",
            model: "main",
            status: "running",
        });
        assert.equal(statusWithActivity.status, "active");

        const emptySessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "empty-agent",
            "sessions"
        );
        await mkdir(emptySessionsDir, { recursive: true });
        assert.equal(
            __testing.toActivityLogFile(
                { dir: emptySessionsDir, recursive: false },
                "missing.jsonl",
                path.join(emptySessionsDir, "missing.jsonl"),
                () => {
                    throw new Error("stat failed");
                }
            ),
            null
        );
        assert.equal(await __testing.getLatestActivityFromFile("empty-agent"), null);
        assert.equal(__testing.getSessionFileModTime("empty-agent"), null);

        const staleDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "stale-agent",
            "sessions"
        );
        await mkdir(staleDir, { recursive: true });
        const staleFile = path.join(staleDir, "old.jsonl");
        await writeFile(staleFile, JSON.stringify({ role: "user", content: "old" }));
        const staleDate = new Date(Date.now() - 10 * 60_000);
        await utimes(staleFile, staleDate, staleDate);
        const staleStats = await fs.promises.stat(staleFile);
        assert.deepEqual(await __testing.getLatestActivityFromFile("stale-agent"), {
            task: null,
            activity: null,
            modTime: staleStats.mtimeMs,
        });

        const primitiveDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "primitive-agent",
            "sessions"
        );
        await mkdir(primitiveDir, { recursive: true });
        const primitiveFile = path.join(primitiveDir, "primitive.jsonl");
        await writeFile(
            primitiveFile,
            [
                JSON.stringify("primitive"),
                JSON.stringify({ role: "user", content: "primitive task" }),
            ].join("\n"),
            "utf8"
        );
        const primitiveActivity =
            await __testing.getLatestActivityFromFile("primitive-agent");
        assert.equal(primitiveActivity?.task, "primitive task");

        await writeFile(configPath, JSON.stringify({}), "utf8");
        assert.equal(__testing.parseAgentsConfig(), null);
        await writeFile(
            configPath,
            JSON.stringify(
                {
                    agents: {
                        defaults: {
                            model: { primary: "codex" },
                            models: {
                                "openai-codex/gpt-5.5": { alias: "codex" },
                            },
                        },
                        list: [
                            { id: agentId, default: true },
                            {
                                id: "researcher",
                                model: {
                                    primary: "synthetic/hf:moonshotai/Kimi-K2.5",
                                },
                            },
                            { id: "alias-agent" },
                        ],
                    },
                },
                null,
                2
            )
        );

        const objectAgentDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "object-agent",
            "sessions"
        );
        await mkdir(objectAgentDir, { recursive: true });
        await writeFile(
            path.join(objectAgentDir, "sessions.json"),
            JSON.stringify({ not: "an array" }),
            "utf8"
        );
        await writeFile(
            path.join(objectAgentDir, "metadata.json"),
            JSON.stringify({ currentTask: "from metadata" }),
            "utf8"
        );
        assert.deepEqual(await __testing.getAgentSessionsFromFiles("object-agent"), []);
        assert.deepEqual(await __testing.getAgentMetadata("object-agent"), {
            currentTask: "from metadata",
        });

        const branchDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "branch-agent",
            "sessions"
        );
        await mkdir(branchDir, { recursive: true });
        const branchFile = path.join(branchDir, "run.jsonl");
        await writeFile(
            branchFile,
            [
                "null",
                JSON.stringify({ runId: "old", role: "user", content: "ignored" }),
                JSON.stringify({ runId: "new", role: "assistant", content: [] }),
                JSON.stringify({ role: "user", content: "runless ignored" }),
                JSON.stringify({
                    runId: "other",
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            name: "exec",
                            arguments: { cmd: "ignored" },
                        },
                    ],
                }),
                JSON.stringify({
                    runId: "new",
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            name: "exec",
                            arguments: { cmd: "npm run active" },
                        },
                    ],
                    __openclaw: { mirrorIdentity: "turn-1:assistant" },
                }),
                JSON.stringify({
                    runId: "new",
                    role: "user",
                    content: [{ type: "image" }],
                    __openclaw: { mirrorIdentity: "turn-1:user" },
                }),
                JSON.stringify({
                    runId: "new",
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            name: "message",
                            arguments: { text: "ignored" },
                        },
                    ],
                    __openclaw: { mirrorIdentity: ":assistant" },
                }),
            ].join("\n"),
            "utf8"
        );
        const branchStats = await fs.promises.stat(branchFile);
        assert.deepEqual(await __testing.getLatestActivityFromFile("branch-agent"), {
            task: null,
            activity: "exec npm run active",
            modTime: branchStats.mtimeMs,
        });

        const oldGroupFile = path.join(branchDir, "older.jsonl");
        await writeFile(oldGroupFile, JSON.stringify({ role: "user", content: "old" }));
        await utimes(oldGroupFile, staleDate, staleDate);
        const activeBranchActivity =
            await __testing.getLatestActivityFromFile("branch-agent");
        assert.equal(activeBranchActivity?.activity, "exec npm run active");

        const mixedGroupFresh = path.join(branchDir, "paired.jsonl");
        const mixedGroupStale = path.join(branchDir, "paired.trajectory.jsonl");
        await writeFile(
            mixedGroupFresh,
            JSON.stringify({ role: "user", content: "fresh paired" }),
            "utf8"
        );
        await writeFile(
            mixedGroupStale,
            JSON.stringify({
                type: "tool.call",
                data: { name: "exec", args: { cmd: "stale paired" } },
            }),
            "utf8"
        );
        await utimes(mixedGroupStale, staleDate, staleDate);
        const pairedBranchActivity =
            await __testing.getLatestActivityFromFile("branch-agent");
        assert.equal(pairedBranchActivity?.task, "fresh paired");

        const originalPop = Array.prototype.pop;
        try {
            Array.prototype.pop = function patchedPop<T>(this: T[]): T | undefined {
                if (
                    this.length === 1 &&
                    (this[0] as { dir?: unknown })?.dir === emptySessionsDir
                ) {
                    originalPop.call(this);
                    return undefined;
                }
                return originalPop.call(this);
            };
            assert.deepEqual(
                __testing.listActivityLogFiles({
                    dir: emptySessionsDir,
                    recursive: false,
                }),
                []
            );
        } finally {
            Array.prototype.pop = originalPop;
        }

        const originalStatSync = fs.statSync;
        try {
            fs.statSync = ((target: fs.PathLike) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath.endsWith("run.jsonl")) {
                    throw new Error("stat failed");
                }
                return originalStatSync(target);
            }) as typeof fs.statSync;
            assert.equal(
                __testing
                    .listActivityLogFiles({ dir: branchDir, recursive: false })
                    .some((file: { name: string }) => file.name === "run.jsonl"),
                true
            );
        } finally {
            fs.statSync = originalStatSync;
        }

        const originalSort = Array.prototype.sort;
        try {
            Array.prototype.sort = function patchedSort<T>(
                this: T[],
                compareFn?: (a: T, b: T) => number
            ): T[] {
                if (
                    this.some(
                        (item) =>
                            typeof item === "object" &&
                            item !== null &&
                            (item as { group?: unknown }).group === `${branchDir}:run`
                    )
                ) {
                    throw new Error("sort failed");
                }
                return originalSort.call(this, compareFn);
            };
            assert.equal(await __testing.getLatestActivityFromFile("branch-agent"), null);
        } finally {
            Array.prototype.sort = originalSort;
        }

        const originalMathMax = Math.max;
        const latestBranchStats = await fs.promises.stat(branchFile);
        const branchMtime = latestBranchStats.mtimeMs;
        try {
            Math.max = (...values: number[]) => {
                if (values.includes(branchMtime)) {
                    throw new Error("max failed");
                }
                return originalMathMax(...values);
            };
            assert.equal(__testing.getSessionFileModTime("branch-agent"), null);
        } finally {
            Math.max = originalMathMax;
        }

        await writeFile(
            path.join(objectAgentDir, "sessions.json"),
            JSON.stringify([{ key: "agent:object-agent:main" }]),
            "utf8"
        );
        const objectStatus = await __testing.getAgentStatus("object-agent");
        assert.equal(objectStatus.currentTask, "from metadata");

        const fallbackHistory = await requestJson<{
            tasks: unknown[];
            timestamp: number;
        }>(server, "/api/agents/tasks/history?limit=not-a-number");
        assert.equal(fallbackHistory.status, 200);
        assert.equal(Array.isArray(fallbackHistory.body.tasks), true);

        const aliasSessionsDir = path.join(
            homeDir,
            ".openclaw",
            "agents",
            "alias-agent",
            "sessions"
        );
        await mkdir(aliasSessionsDir, { recursive: true });
        await writeFile(
            path.join(aliasSessionsDir, "sessions.json"),
            JSON.stringify([
                {
                    key: "agent:alias-agent:main",
                    updatedAt: Date.now(),
                },
            ]),
            "utf8"
        );
        const allStatus = await requestJson<{ agents: Array<{ id: string }> }>(
            server,
            "/api/agents/status"
        );
        assert.equal(allStatus.status, 200);

        await writeFile(
            configPath,
            JSON.stringify({ agents: { defaults: {}, list: [] } }),
            "utf8"
        );
        const noDefaultStatus = await requestJson<{ agents: [] }>(
            server,
            "/api/agents/status"
        );
        assert.equal(noDefaultStatus.status, 200);
        await writeFile(
            configPath,
            JSON.stringify(
                {
                    agents: {
                        defaults: {
                            model: { primary: "codex" },
                            models: {
                                "openai-codex/gpt-5.5": { alias: "codex" },
                            },
                        },
                        list: [
                            { id: agentId, default: true },
                            {
                                id: "researcher",
                                model: {
                                    primary: "synthetic/hf:moonshotai/Kimi-K2.5",
                                },
                            },
                            { id: "alias-agent" },
                        ],
                    },
                },
                null,
                2
            )
        );

        const originalRealpathSync = fs.realpathSync;
        try {
            const { __testing } = await import("./agents.js");
            __testing.setPrepareAgentMetadataDirForTest(() => null);
            const unsafePrepared = await requestJson<{ error: string }>(
                server,
                "/api/agents/unsafe-prepared/metadata",
                { method: "PUT", body: { currentTask: "blocked" } }
            );
            assert.equal(unsafePrepared.status, 400);
            assert.equal(unsafePrepared.body.error, "Invalid agent metadata path");
            __testing.setPrepareAgentMetadataDirForTest();

            let safeMismatchCalls = 0;
            fs.realpathSync = ((target: fs.PathLike) => {
                const value = originalRealpathSync(target).toString();
                if (
                    value.endsWith(`${path.sep}safe-mismatch${path.sep}sessions`) &&
                    safeMismatchCalls++ === 0
                ) {
                    return path.join(
                        homeDir,
                        ".openclaw",
                        "agents",
                        "different",
                        "sessions"
                    );
                }
                if (value.endsWith(`${path.sep}realpath-agent${path.sep}sessions`)) {
                    return homeDir;
                }
                return value;
            }) as typeof fs.realpathSync;
            const safeMismatch = await requestJson<{ error: string }>(
                server,
                "/api/agents/safe-mismatch/metadata",
                { method: "PUT", body: { currentTask: "blocked" } }
            );
            assert.equal(safeMismatch.status, 400);
            assert.equal(safeMismatch.body.error, "Invalid agent metadata path");

            let parentMismatchCalls = 0;
            const parentMismatchAgentDir = path.join(
                homeDir,
                ".openclaw",
                "agents",
                "parent-mismatch"
            );
            fs.realpathSync = ((target: fs.PathLike) => {
                const value = originalRealpathSync(target).toString();
                if (value === parentMismatchAgentDir && ++parentMismatchCalls === 2) {
                    return path.join(homeDir, ".openclaw", "agents", "different");
                }
                if (value.endsWith(`${path.sep}realpath-agent${path.sep}sessions`)) {
                    return homeDir;
                }
                return value;
            }) as typeof fs.realpathSync;
            const parentMismatch = await requestJson<{ error: string }>(
                server,
                "/api/agents/parent-mismatch/metadata",
                { method: "PUT", body: { currentTask: "blocked" } }
            );
            assert.equal(parentMismatch.status, 400);
            assert.equal(parentMismatch.body.error, "Invalid agent metadata path");

            const response = await requestJson<{ error: string }>(
                server,
                "/api/agents/realpath-agent/metadata",
                { method: "PUT", body: { currentTask: "blocked" } }
            );
            assert.equal(response.status, 400);
            assert.equal(response.body.error, "Invalid agent metadata path");

            __testing.setPrepareAgentMetadataDirForTest(() =>
                path.join(homeDir, ".openclaw", "agents", "unavailable-root", "sessions")
            );
            let agentsRootRealpathCalls = 0;
            fs.realpathSync = ((target: fs.PathLike) => {
                if (
                    String(target) === path.join(homeDir, ".openclaw", "agents") &&
                    ++agentsRootRealpathCalls > 2
                ) {
                    const error = new Error("agents dir denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;
            const unavailableRoot = await requestJson<{ error: string }>(
                server,
                "/api/agents/unavailable-root/metadata",
                { method: "PUT", body: { currentTask: "blocked" } }
            );
            assert.equal(unavailableRoot.status, 400);
            assert.equal(unavailableRoot.body.error, "Invalid agent metadata path");
        } finally {
            const { __testing } = await import("./agents.js");
            __testing.setPrepareAgentMetadataDirForTest();
            fs.realpathSync = originalRealpathSync;
        }

        try {
            let metadataDirCalls = 0;
            fs.realpathSync = ((target: fs.PathLike) => {
                const value = originalRealpathSync(target).toString();
                if (
                    value.endsWith(`${path.sep}swap-agent${path.sep}sessions`) &&
                    ++metadataDirCalls === 3
                ) {
                    return path.join(homeDir, ".openclaw", "agents");
                }
                return value;
            }) as typeof fs.realpathSync;
            const response = await requestJson<{ error: string }>(
                server,
                "/api/agents/swap-agent/metadata",
                { method: "PUT", body: { currentTask: "blocked" } }
            );
            assert.equal(response.status, 400);
            assert.equal(response.body.error, "Invalid agent metadata path");
        } finally {
            fs.realpathSync = originalRealpathSync;
        }

        const previousGatewaySessions = gateway.getSessions;
        const previousGatewayRequest = gateway.request;
        try {
            gateway.getSessions = () => [
                {
                    id: "cached",
                    key: "agent:cached:main",
                    type: "MAIN",
                    agentType: "cached",
                    hookName: "",
                    model: "cached-model",
                    tokenCount: 0,
                    maxTokens: 200000,
                    createdAt: null,
                    displayName: "",
                    label: "",
                    displayLabel: "",
                    channel: "unknown",
                    status: "idle",
                    updatedAt: 0,
                },
                {
                    id: "non-string-model",
                    key: "agent:cached-worker:main",
                    type: "MAIN",
                    agentType: "cached",
                    hookName: "",
                    model: 42 as unknown as string,
                    tokenCount: 0,
                    maxTokens: 200000,
                    createdAt: null,
                    displayName: "",
                    label: "",
                    displayLabel: "",
                    channel: "unknown",
                    status: "idle",
                    updatedAt: 1,
                },
            ];
            gateway.request = async () => ({
                sessions: [
                    { key: "" },
                    { key: "agent:x:main", model: "   " },
                    {
                        key: "agent:y:main",
                        model: { primary: "codex" } as unknown as string,
                    },
                ],
            });
            assert.deepEqual(await __testing.getGatewaySessionsForAgents(), [
                {
                    key: "agent:x:main",
                    model: undefined,
                    status: undefined,
                    updatedAt: undefined,
                    startedAt: undefined,
                    endedAt: undefined,
                    runId: undefined,
                    activeRunId: undefined,
                    currentRunId: undefined,
                    isRunning: undefined,
                    running: undefined,
                },
                {
                    key: "agent:y:main",
                    model: undefined,
                    status: undefined,
                    updatedAt: undefined,
                    startedAt: undefined,
                    endedAt: undefined,
                    runId: undefined,
                    activeRunId: undefined,
                    currentRunId: undefined,
                    isRunning: undefined,
                    running: undefined,
                },
            ]);

            gateway.request = async () => ({ sessions: [] });
            const sessions = await __testing.getGatewaySessionsForAgents();
            assert.deepEqual(sessions, []);

            gateway.request = async () => ({ sessions: [{ key: "" }] });
            const emptyFilteredSessions = await __testing.getGatewaySessionsForAgents();
            assert.deepEqual(emptyFilteredSessions, []);

            gateway.request = async () => {
                throw new Error("gateway unavailable");
            };
            const cachedSessions = await __testing.getGatewaySessionsForAgents();
            assert.equal(cachedSessions[1]?.model, undefined);

            gateway.getSessions = () => {
                throw new Error("cache unavailable");
            };
            const unavailableSessions = await __testing.getGatewaySessionsForAgents();
            assert.deepEqual(unavailableSessions, []);
        } finally {
            gateway.getSessions = previousGatewaySessions;
            gateway.request = previousGatewayRequest;
        }
    });
});
