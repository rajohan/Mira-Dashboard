import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import express from "express";

import gateway, { type Session } from "../gateway.js";
import metricsRoutes, { __testing } from "./metrics.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalGetSessions = gateway.getSessions;

const sessions: Session[] = [
    {
        id: "main-id",
        key: "agent:main:main",
        type: "MAIN",
        agentType: "main",
        hookName: "",
        kind: "direct",
        model: "openai-codex/gpt-5.5",
        tokenCount: 300,
        maxTokens: 200_000,
        createdAt: null,
        updatedAt: Date.now(),
        displayName: "Main",
        label: "main",
        displayLabel: "Main",
        channel: "webchat",
    },
    {
        id: "worker-id",
        key: "agent:coder:subagent:worker",
        type: "SUBAGENT",
        agentType: "coder",
        hookName: "",
        kind: "direct",
        model: "synthetic/hf:moonshotai/Kimi-K2.5",
        tokenCount: 700,
        maxTokens: 200_000,
        createdAt: null,
        updatedAt: Date.now(),
        displayName: "Worker",
        label: "worker",
        displayLabel: "Worker",
        channel: "webchat",
    },
    {
        id: "anonymous-id",
        key: "agent:anonymous:main",
        type: "HOOK",
        agentType: "anonymous",
        hookName: "",
        kind: "direct",
        model: "openai-codex/gpt-5.5",
        tokenCount: 50,
        maxTokens: 200_000,
        createdAt: null,
        updatedAt: Date.now(),
        displayName: "",
        label: "",
        displayLabel: "",
        channel: "webchat",
    },
];

async function startServer(): Promise<TestServer> {
    const app = express();
    metricsRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

describe("metrics routes", () => {
    let server: TestServer;

    before(async () => {
        gateway.getSessions = () => [...sessions];
        server = await startServer();
    });

    after(async () => {
        await server.close();
        gateway.getSessions = originalGetSessions;
    });

    it("returns system metrics and aggregates token usage", async () => {
        const response = await fetch(`${server.baseUrl}/api/metrics`);
        const body = (await response.json()) as {
            cpu: { count: number; model: string; loadAvg: number[]; loadPercent: number };
            memory: { total: number; used: number; free: number; percent: number };
            disk: { total: number; used: number; percent: number };
            system: { uptime: number; platform: string; hostname: string };
            network: { downloadMbps: number; uploadMbps: number };
            timestamp: number;
            tokens: {
                total: number;
                byModel: Record<string, number>;
                sessionsByModel: Record<string, number>;
                byAgent: Array<{
                    label: string;
                    model: string;
                    tokens: number;
                    type: string;
                }>;
            };
        };

        assert.equal(response.status, 200);
        assert.equal(body.cpu.count > 0, true);
        assert.equal(typeof body.cpu.model, "string");
        assert.equal(Array.isArray(body.cpu.loadAvg), true);
        assert.equal(body.memory.total >= body.memory.used, true);
        assert.equal(body.memory.total >= body.memory.free, true);
        assert.equal(Number.isFinite(body.disk.percent), true);
        assert.equal(body.system.platform, process.platform);
        assert.equal(typeof body.system.hostname, "string");
        assert.equal(typeof body.network.downloadMbps, "number");
        assert.equal(typeof body.timestamp, "number");

        assert.equal(body.tokens.total, 1050);
        assert.deepEqual(body.tokens.byModel, {
            "openai-codex/gpt-5.5": 350,
            "synthetic/hf:moonshotai/Kimi-K2.5": 700,
        });
        assert.deepEqual(body.tokens.sessionsByModel, {
            "gpt-5.5": 2,
            "Kimi-K2.5": 1,
        });
        assert.deepEqual(body.tokens.byAgent, [
            {
                label: "Worker",
                model: "synthetic/hf:moonshotai/Kimi-K2.5",
                tokens: 700,
                type: "SUBAGENT",
            },
            {
                label: "Main",
                model: "openai-codex/gpt-5.5",
                tokens: 300,
                type: "MAIN",
            },
        ]);
    });

    it("returns network deltas on later samples and reports route errors", async () => {
        const originalNow = Date.now;
        let now = 1_700_000_000_000;
        let rxBytes = 1_000_000;
        let txBytes = 2_000_000;
        try {
            Date.now = () => now;
            __testing.resetNetworkSample();
            __testing.setDepsForTest({
                readdirSync: () => ["enp0s6"] as never,
                readFileSync: (filePath: unknown) => {
                    const pathText = String(filePath);
                    return String(
                        pathText.endsWith("rx_bytes") ? rxBytes : txBytes
                    ) as never;
                },
            });

            await fetch(`${server.baseUrl}/api/metrics`);
            now += 1000;
            rxBytes += 1_000_000;
            txBytes += 500_000;

            const secondSample = await fetch(`${server.baseUrl}/api/metrics`);
            const secondBody = (await secondSample.json()) as {
                network: { downloadMbps: number; uploadMbps: number };
            };

            assert.equal(secondSample.status, 200);
            assert.equal(secondBody.network.downloadMbps, 8);
            assert.equal(secondBody.network.uploadMbps, 4);
        } finally {
            Date.now = originalNow;
            __testing.resetDepsForTest();
            __testing.resetNetworkSample();
        }

        const original = gateway.getSessions;
        try {
            gateway.getSessions = () => {
                throw new Error("token metrics unavailable");
            };

            const failed = await fetch(`${server.baseUrl}/api/metrics`);
            const failedBody = (await failed.json()) as { error: string };

            assert.equal(failed.status, 500);
            assert.equal(failedBody.error, "token metrics unavailable");
        } finally {
            gateway.getSessions = original;
        }
    });

    it("returns zero network rates when samples have no elapsed time", () => {
        const originalNow = Date.now;
        try {
            Date.now = () => 1_700_000_000_000;
            __testing.resetNetworkSample();
            assert.deepEqual(__testing.getNetworkMetrics(), {
                downloadMbps: 0,
                uploadMbps: 0,
            });
            assert.deepEqual(__testing.getNetworkMetrics(), {
                downloadMbps: 0,
                uploadMbps: 0,
            });
        } finally {
            Date.now = originalNow;
            __testing.resetNetworkSample();
        }
    });

    it("covers network and disk fallback branches", async () => {
        const originalConsoleError = console.error;
        const errors: unknown[][] = [];
        try {
            console.error = (...args: unknown[]) => {
                errors.push(args);
            };

            __testing.resetNetworkSample();
            __testing.setDepsForTest({
                readdirSync: () => ["lo", "eth0"] as never,
                readFileSync: (filePath: unknown) => {
                    const pathText = String(filePath);
                    if (pathText.endsWith("rx_bytes")) return "not-a-number" as never;
                    return "2000" as never;
                },
                execSync: () => "too short\n" as never,
            });

            const sparse = await fetch(`${server.baseUrl}/api/metrics`);
            const sparseBody = (await sparse.json()) as {
                disk: { total: number; used: number; percent: number };
                network: { downloadMbps: number; uploadMbps: number };
            };
            assert.equal(sparse.status, 200);
            assert.deepEqual(sparseBody.disk, {
                total: 0,
                used: 0,
                percent: 0,
                totalGB: 0,
                usedGB: 0,
            });
            assert.equal(sparseBody.network.downloadMbps, 0);
            assert.equal(sparseBody.network.uploadMbps, 0);

            __testing.setDepsForTest({
                readdirSync: () => {
                    throw new Error("network unavailable");
                },
                execSync: () => {
                    throw new Error("df unavailable");
                },
            });
            errors.length = 0;

            const failedDeps = await fetch(`${server.baseUrl}/api/metrics`);
            assert.equal(failedDeps.status, 200);
            assert.equal(
                errors.some((args) => String(args[0]).includes("network error")),
                true
            );
            assert.equal(
                errors.some((args) => String(args[0]).includes("df error")),
                true
            );

            __testing.resetNetworkSample();
            __testing.setDepsForTest({
                readdirSync: () => ["enp0s6", "eth0"] as never,
                readFileSync: () => "2000" as never,
            });
            assert.deepEqual(__testing.getNetworkMetrics(), {
                downloadMbps: 0,
                uploadMbps: 0,
            });
        } finally {
            console.error = originalConsoleError;
            __testing.resetDepsForTest();
            __testing.resetNetworkSample();
        }
    });

    it("covers token metric default branches", () => {
        const original = gateway.getSessions;
        try {
            gateway.getSessions = () => [
                {
                    id: "defaults-id",
                    key: "agent:defaults:main",
                    type: "",
                    agentType: "defaults",
                    hookName: "",
                    kind: "direct",
                    model: "",
                    tokenCount: 0,
                    maxTokens: 200_000,
                    createdAt: null,
                    updatedAt: Date.now(),
                    displayName: "",
                    label: "Fallback label",
                    displayLabel: "",
                    channel: "webchat",
                },
                {
                    id: "trailing-model-id",
                    key: "agent:defaults:secondary",
                    type: "",
                    agentType: "defaults",
                    hookName: "",
                    kind: "direct",
                    model: "provider/",
                    tokenCount: 0,
                    maxTokens: 200_000,
                    createdAt: null,
                    updatedAt: Date.now(),
                    displayName: "",
                    label: "Trailing model",
                    displayLabel: "",
                    channel: "webchat",
                },
                {
                    id: "blank-model-id",
                    key: "agent:blank:main",
                    type: " ".repeat(3),
                    agentType: "blank",
                    hookName: "",
                    kind: "direct",
                    model: " ".repeat(3),
                    tokenCount: 0,
                    maxTokens: 200_000,
                    createdAt: null,
                    updatedAt: Date.now(),
                    displayName: "",
                    label: "  Blank model  ",
                    displayLabel: " ".repeat(3),
                    channel: "webchat",
                },
            ];

            assert.deepEqual(__testing.getTokenMetrics(), {
                total: 0,
                byModel: { "provider/": 0, unknown: 0 },
                sessionsByModel: { "provider/": 1, unknown: 2 },
                byAgent: [
                    {
                        label: "Fallback label",
                        model: "unknown",
                        tokens: 0,
                        type: "Unknown",
                    },
                    {
                        label: "Trailing model",
                        model: "provider/",
                        tokens: 0,
                        type: "Unknown",
                    },
                    {
                        label: "Blank model",
                        model: "unknown",
                        tokens: 0,
                        type: "Unknown",
                    },
                ],
            });
        } finally {
            gateway.getSessions = original;
        }
    });
});
