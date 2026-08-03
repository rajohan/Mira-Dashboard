import { describe, expect, it } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { database } from "../../src/database/connection.ts";
import { createServiceBehaviorHarness } from "../support/serviceBehaviorHarness";
import { captureStructuredLogs } from "../support/structuredLogCapture.ts";
describe("backend agent services", () => {
    const { cleanupCallbacks, createTemporaryRoot, rememberEnvironment } =
        createServiceBehaviorHarness();
    it("updates agent metadata and rolls active task history forward", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        const openclawRoot = createTemporaryRoot("mira-agent-service-test-");
        process.env.OPENCLAW_HOME = openclawRoot;
        delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
        const { updateAgentCurrentTask, getLatestCompletedTasks } =
            await import("../../src/services/agents/statusService.ts");
        const agentId = `agent-${Bun.randomUUIDv7()}`;
        try {
            expect(updateAgentCurrentTask("../bad", "Task")).rejects.toMatchObject({
                statusCode: 400,
            });
            expect(updateAgentCurrentTask(agentId, " ")).rejects.toMatchObject({
                statusCode: 400,
            });
            const firstMetadata = await updateAgentCurrentTask(agentId, "First task");
            const secondMetadata = await updateAgentCurrentTask(agentId, "Second task");
            const repeatedMetadata = await updateAgentCurrentTask(agentId, "Second task");
            expect(firstMetadata.currentTask).toBe("First task");
            expect(secondMetadata.currentTask).toBe("Second task");
            expect(repeatedMetadata.currentTask).toBe("Second task");
            const metadataFile = Bun.file(
                path.join(openclawRoot, "agents", agentId, "sessions", "metadata.json")
            );
            expect(await metadataFile.json()).toMatchObject({
                currentTask: "Second task",
            });
            const completedTasks = getLatestCompletedTasks(20).filter(
                (task) => task.agentId === agentId
            );
            expect(completedTasks).toContainEqual(
                expect.objectContaining({
                    agentId,
                    task: "First task",
                    status: "completed",
                })
            );
            const historyRows = database
                .prepare(`SELECT task, status
                     FROM agent_task_history
                     WHERE agent_id = ?
                     ORDER BY id`)
                .all(agentId) as Array<{
                task: string;
                status: string;
            }>;
            expect(historyRows).toEqual([
                {
                    task: "First task",
                    status: "completed",
                },
                {
                    task: "Second task",
                    status: "active",
                },
            ]);
        } finally {
            database
                .prepare("DELETE FROM agent_task_history WHERE agent_id = ?")
                .run(agentId);
        }
    });
    it("parses agent config and builds statuses from temp metadata plus fake gateway sessions", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        const openclawRoot = createTemporaryRoot("mira-agent-status-test-");
        const agentsRoot = path.join(openclawRoot, "agents");
        const miraSessions = path.join(agentsRoot, "mira-2026", "sessions");
        const coderSessions = path.join(agentsRoot, "coder", "sessions");
        const researcherSessions = path.join(
            agentsRoot,
            "researcher",
            "agent",
            "codex-home",
            "sessions",
            "2026",
            "06"
        );
        const auditorSessions = path.join(agentsRoot, "auditor", "sessions");
        const writerSessions = path.join(agentsRoot, "writer", "sessions");
        const browserSessions = path.join(agentsRoot, "browser", "sessions");
        const largeTailSessions = path.join(agentsRoot, "large-tail", "sessions");
        const staleSessions = path.join(agentsRoot, "stale", "sessions");
        const responseItemAgents = [
            {
                activity: "edit files",
                id: "patcher",
                input: "await tools.apply_patch({})",
                task: "Patch files",
            },
            {
                activity: "session_status",
                id: "session-checker",
                input: "await tools.openclaw_session_status({})",
                task: "Check session",
            },
            {
                activity: "terminal output",
                id: "terminal-reader",
                input: "await tools.write_stdin({session_id:1})",
                task: "Read terminal",
            },
            {
                activity: "memory_search",
                id: "memory-agent",
                input: 'await tools.memory_search({"query":"dashboard coverage"})',
                task: "Search memory",
            },
        ];
        mkdirSync(miraSessions, {
            recursive: true,
        });
        mkdirSync(coderSessions, {
            recursive: true,
        });
        mkdirSync(researcherSessions, {
            recursive: true,
        });
        mkdirSync(auditorSessions, {
            recursive: true,
        });
        mkdirSync(writerSessions, {
            recursive: true,
        });
        mkdirSync(browserSessions, {
            recursive: true,
        });
        mkdirSync(largeTailSessions, {
            recursive: true,
        });
        mkdirSync(staleSessions, {
            recursive: true,
        });
        for (const agent of responseItemAgents) {
            mkdirSync(path.join(agentsRoot, agent.id, "sessions"), {
                recursive: true,
            });
        }
        process.env.OPENCLAW_HOME = openclawRoot;
        delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
        writeFileSync(
            path.join(openclawRoot, "openclaw.json"),
            JSON.stringify({
                agents: {
                    defaults: {
                        model: {
                            primary: "codex",
                        },
                        models: {
                            "openai/gpt-5.5": {
                                alias: "codex",
                            },
                        },
                    },
                    list: [
                        {
                            default: true,
                            id: "mira-2026",
                        },
                        {
                            id: "coder",
                            model: {
                                primary: "openai/gpt-4.1",
                            },
                        },
                        {
                            id: "researcher",
                        },
                        {
                            id: "auditor",
                        },
                        {
                            id: "writer",
                        },
                        {
                            id: "browser",
                        },
                        {
                            id: "large-tail",
                        },
                        {
                            id: "stale",
                        },
                        ...responseItemAgents.map((agent) => ({
                            id: agent.id,
                        })),
                    ],
                },
            })
        );
        writeFileSync(
            path.join(miraSessions, "metadata.json"),
            JSON.stringify({
                currentTask: "Temp agent task",
            })
        );
        writeFileSync(
            path.join(miraSessions, "sessions.json"),
            JSON.stringify([
                {
                    channel: "main",
                    key: "agent:mira-2026:main",
                    sessionId: "session-main",
                    updatedAt: Date.now(),
                },
                {
                    key: 123,
                    updatedAt: "bad",
                },
            ])
        );
        writeFileSync(
            path.join(researcherSessions, "researcher.trajectory.jsonl"),
            [
                {
                    data: {
                        prompt: [
                            "Research coverage gaps",
                            "[media attached: ignored]",
                            "Conversation info: ignored",
                        ].join("\n"),
                    },
                    runId: "research-run",
                    type: "prompt.submitted",
                },
                {
                    data: {
                        arguments: {
                            path: "/tmp/coverage.ts",
                        },
                        name: "read",
                        turnId: "research-turn",
                    },
                    runId: "research-run",
                    type: "tool.call",
                },
            ]
                .map((entry) => JSON.stringify(entry))
                .join("\n")
        );
        writeFileSync(
            path.join(writerSessions, "session.jsonl"),
            [
                "{malformed",
                JSON.stringify({
                    message: {
                        content: "Write task from session file",
                        role: "user",
                    },
                    runId: "writer-run",
                }),
                JSON.stringify({
                    message: {
                        content: [
                            {
                                partialJson: '{"file_path":"/tmp/output.md"}',
                                type: "toolCall",
                                name: "write",
                            },
                        ],
                        role: "assistant",
                    },
                    runId: "writer-run",
                }),
            ].join("\n")
        );
        writeFileSync(
            path.join(browserSessions, "session.jsonl"),
            [
                {
                    data: {
                        args: {
                            parameters: {
                                action: "navigate",
                                url: "https://dashboard.test",
                            },
                        },
                        name: "browser",
                        prompt: "Browse dashboard",
                    },
                    runId: "browser-run",
                    type: "prompt.submitted",
                },
                {
                    data: {
                        args: {
                            parameters: {
                                action: "navigate",
                                url: "https://dashboard.test",
                            },
                        },
                        name: "browser",
                    },
                    runId: "browser-run",
                    type: "tool.result",
                },
            ]
                .map((entry) => JSON.stringify(entry))
                .join("\n")
        );
        writeFileSync(
            path.join(largeTailSessions, "session.jsonl"),
            [
                JSON.stringify({
                    message: {
                        __openclaw: {
                            mirrorIdentity: "large-tail-turn:user",
                        },
                        content: "Recover task beyond bounded tail",
                        role: "user",
                    },
                    runId: "large-tail-run",
                }),
                JSON.stringify({
                    message: {
                        __openclaw: {
                            mirrorIdentity: "other-turn:user",
                        },
                        content: "Do not pair this task with the selected activity",
                        role: "user",
                    },
                    runId: "large-tail-run",
                }),
                JSON.stringify({
                    message: {
                        content: "x".repeat(2 * 1024 * 1024 + 128 * 1024),
                        role: "assistant",
                    },
                    runId: "large-tail-run",
                }),
                JSON.stringify({
                    message: {
                        __openclaw: {
                            mirrorIdentity: "large-tail-turn:assistant",
                        },
                        content: [
                            {
                                name: "read",
                                partialJson: '{"path":"/tmp/large-tail.ts"}',
                                type: "toolCall",
                            },
                        ],
                        role: "assistant",
                    },
                    runId: "large-tail-run",
                }),
            ].join("\n")
        );
        const staleFile = path.join(staleSessions, "session.jsonl");
        writeFileSync(
            staleFile,
            JSON.stringify({
                message: {
                    content: "Old task should not be active",
                    role: "user",
                },
                runId: "stale-run",
            })
        );
        const staleDate = new Date(Date.now() - 10 * 60_000);
        await Bun.write(staleFile, await Bun.file(staleFile).text());
        utimesSync(staleFile, staleDate, staleDate);
        for (const agent of responseItemAgents) {
            writeFileSync(
                path.join(agentsRoot, agent.id, "sessions", "session.jsonl"),
                [
                    {
                        message: {
                            content: agent.task,
                            role: "user",
                        },
                        runId: `${agent.id}-run`,
                    },
                    {
                        payload: {
                            input: agent.input,
                            name: "exec",
                            type: "custom_tool_call",
                        },
                        runId: `${agent.id}-run`,
                        type: "response_item",
                    },
                ]
                    .map((entry) => JSON.stringify(entry))
                    .join("\n")
            );
        }
        writeFileSync(
            path.join(auditorSessions, "session.jsonl"),
            [
                {
                    message: {
                        __openclaw: {
                            mirrorIdentity: "audit-turn:user",
                        },
                        content: [
                            {
                                text: "Audit backend coverage",
                                type: "text",
                            },
                            {
                                text: '```json\n{"ignore":true}\n```',
                                type: "text",
                            },
                        ],
                        role: "user",
                    },
                    runId: "audit-run",
                },
                {
                    payload: {
                        input: 'await tools.exec_command({"cmd":"git status --short"})',
                        name: "exec",
                        type: "custom_tool_call",
                    },
                    runId: "audit-run",
                    type: "response_item",
                },
            ]
                .map((entry) => JSON.stringify(entry))
                .join("\n")
        );
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const originalGetSessions = gateway.getSessions;
        const originalRequest = gateway.request;
        cleanupCallbacks.push(() => {
            gateway.getSessions = originalGetSessions;
            gateway.request = originalRequest;
        });
        gateway.getSessions = () => [
            {
                agentType: "coder",
                channel: "main",
                createdAt: undefined,
                displayLabel: "Coder",
                displayName: "Coder",
                hookName: "",
                id: "cached",
                key: "agent:coder:main",
                label: "",
                maxTokens: 200_000,
                model: "unknown",
                tokenCount: 0,
                type: "MAIN",
                updatedAt: Date.now(),
            },
        ];
        gateway.request = (method) => {
            return Promise.try(() => {
                if (method === "sessions.list") {
                    return {
                        sessions: [
                            {
                                isRunning: true,
                                key: "agent:mira-2026:main",
                                model: "openai/gpt-5.5",
                                status: "running",
                                updatedAt: Date.now(),
                            },
                            {
                                endedAt: 0,
                                isRunning: true,
                                key: "agent:coder:main",
                                model: "openai/gpt-4.1",
                                status: "running",
                                updatedAt: Date.now() - 120_000,
                            },
                            {
                                key: "agent:researcher:main",
                                model: "openai/gpt-5.5",
                                updatedAt: 1e100,
                            },
                            {
                                key: "",
                                model: "ignored",
                            },
                        ],
                    };
                }
                throw new Error(`unexpected gateway method: ${method}`);
            });
        };
        const { buildAgentStatuses, buildSingleAgentStatus, parseAgentsConfig } =
            await import("../../src/services/agents/statusService.ts");
        expect(parseAgentsConfig()).toMatchObject({
            defaults: {
                model: {
                    primary: "codex",
                },
            },
            list: [
                {
                    id: "mira-2026",
                },
                {
                    id: "coder",
                },
                {
                    id: "researcher",
                },
                {
                    id: "auditor",
                },
                {
                    id: "writer",
                },
                {
                    id: "browser",
                },
                {
                    id: "large-tail",
                },
                {
                    id: "stale",
                },
                ...responseItemAgents.map((agent) => ({
                    id: agent.id,
                })),
            ],
        });
        const statuses = await buildAgentStatuses(parseAgentsConfig()!);
        expect(statuses).toContainEqual(
            expect.objectContaining({
                currentTask: "Temp agent task",
                id: "mira-2026",
                model: "gpt-5.5",
                sessionKey: "agent:mira-2026:main",
                status: "thinking",
            })
        );
        expect(statuses).toContainEqual(
            expect.objectContaining({
                id: "coder",
                model: "gpt-4.1",
                sessionKey: "agent:coder:main",
                status: "idle",
            })
        );
        expect(statuses).toContainEqual(
            expect.objectContaining({
                currentActivity: "read /tmp/coverage.ts",
                currentTask: "Research coverage gaps",
                id: "researcher",
                model: "gpt-5.5",
                status: "active",
            })
        );
        expect(statuses).toContainEqual(
            expect.objectContaining({
                currentActivity: "exec git status --short",
                currentTask: "Audit backend coverage",
                id: "auditor",
                status: "active",
            })
        );
        expect(statuses).toContainEqual(
            expect.objectContaining({
                currentActivity: "write /tmp/output.md",
                currentTask: "Write task from session file",
                id: "writer",
                status: "active",
            })
        );
        expect(statuses).toContainEqual(
            expect.objectContaining({
                currentActivity: "browser navigate https://dashboard.test",
                currentTask: "Browse dashboard",
                id: "browser",
                status: "active",
            })
        );
        expect(statuses).toContainEqual(
            expect.objectContaining({
                currentActivity: "read /tmp/large-tail.ts",
                currentTask: "Recover task beyond bounded tail",
                id: "large-tail",
                status: "active",
            })
        );
        expect(statuses).toContainEqual(
            expect.objectContaining({
                currentActivity: undefined,
                currentTask: undefined,
                id: "stale",
                status: "idle",
            })
        );
        for (const agent of responseItemAgents) {
            expect(statuses).toContainEqual(
                expect.objectContaining({
                    currentActivity: agent.activity,
                    currentTask: agent.task,
                    id: agent.id,
                    status: "active",
                })
            );
        }
        expect(buildSingleAgentStatus("missing", parseAgentsConfig()!)).resolves.toBe(
            undefined
        );
        expect(
            buildSingleAgentStatus("coder", parseAgentsConfig()!)
        ).resolves.toMatchObject({
            id: "coder",
            model: "gpt-4.1",
        });
        const structuredLogs = captureStructuredLogs();
        writeFileSync(path.join(openclawRoot, "openclaw.json"), "{");
        try {
            expect(parseAgentsConfig()).toBeUndefined();
            expect(structuredLogs.entries).toContainEqual(
                expect.objectContaining({
                    event: "agents.openclaw_config_parse_failed",
                    level: "error",
                })
            );
        } finally {
            structuredLogs.stop();
        }
    });
});
