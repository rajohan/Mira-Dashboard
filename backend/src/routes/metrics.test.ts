import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import express from "express";

import gateway, { type Session } from "../gateway.js";
import metricsRoutes from "./metrics.js";

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
});
