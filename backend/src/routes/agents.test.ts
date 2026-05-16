import assert from "node:assert/strict";
import {
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
import { after, before, describe, it } from "node:test";

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
    let metadataPath: string;

    before(async () => {
        homeDir = await mkdtemp(path.join(os.tmpdir(), "mira-agents-route-"));
        const openclawRoot = path.join(homeDir, ".openclaw");
        await mkdir(openclawRoot, { recursive: true });
        await writeFile(
            path.join(openclawRoot, "openclaw.json"),
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
        assert.equal(testAgent?.model, "openai-codex/gpt-5.5");
        assert.equal(testAgent?.currentTask, null);
        assert.equal(researcher?.model, "hf:moonshotai/Kimi-K2.5");
        assert.equal(typeof status.body.timestamp, "number");
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

    it("ignores message and memory search noise when newer session files have no visible activity", async () => {
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
            assert.equal(response.body.currentActivity, "exec npm run build");
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
        await rm(aliasAgentDir, { recursive: true, force: true });
        await mkdir(aliasSessionsDir, { recursive: true });
        await mkdir(codexSessionsDir, { recursive: true });

        const gatewayTrajectoryPath = path.join(
            aliasSessionsDir,
            "active.trajectory.jsonl"
        );
        const codexRolloutPath = path.join(codexSessionsDir, "rollout.jsonl");
        await writeFile(
            gatewayTrajectoryPath,
            JSON.stringify({
                type: "tool.call",
                runId: "gateway-run",
                data: {
                    name: "session_status",
                    arguments: {},
                },
            }),
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
                currentActivity: string | null;
            }>(server, "/api/agents/alias-agent/status");

            assert.equal(response.status, 200);
            assert.equal(response.body.status, "active");
            assert.equal(response.body.currentActivity, "exec npm run agents:test");
        } finally {
            gateway.request = previousGatewayRequest;
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
});
