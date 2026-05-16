import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import express from "express";

import gateway, { type Session } from "../gateway.js";
import sessionsRoutes from "./sessions.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalGateway = {
    abortSessionRun: gateway.abortSessionRun,
    deleteSession: gateway.deleteSession,
    getSessions: gateway.getSessions,
    sendSessionMessage: gateway.sendSessionMessage,
};
const originalConsoleLog = console.log;

const sessions: Session[] = [
    {
        id: "main-id",
        key: "agent:main:main",
        type: "MAIN",
        agentType: "main",
        hookName: "",
        kind: "direct",
        model: "codex",
        tokenCount: 50,
        maxTokens: 200_000,
        createdAt: "2026-05-11T00:00:00.000Z",
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
        model: "kimi",
        tokenCount: 150,
        maxTokens: 200_000,
        createdAt: "2026-05-11T00:00:00.000Z",
        updatedAt: Date.now() - 7_200_000,
        displayName: "Worker",
        label: "worker",
        displayLabel: "Worker",
        channel: "webchat",
    },
];

async function startServer(): Promise<TestServer> {
    const app = express();
    app.use(express.json());
    sessionsRoutes(app);
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

describe("sessions routes", () => {
    let server: TestServer;
    const sentMessages: Array<{ key: string; message: string }> = [];
    const aborted: string[] = [];
    const deleted: string[] = [];

    before(async () => {
        console.log = () => {};
        gateway.getSessions = () => [...sessions];
        gateway.sendSessionMessage = async (key: string, message: string) => {
            sentMessages.push({ key, message });
        };
        gateway.abortSessionRun = async (key: string) => {
            aborted.push(key);
        };
        gateway.deleteSession = async (key: string) => {
            deleted.push(key);
            return { archived: true };
        };
        server = await startServer();
    });

    after(async () => {
        await server.close();
        console.log = originalConsoleLog;
        gateway.abortSessionRun = originalGateway.abortSessionRun;
        gateway.deleteSession = originalGateway.deleteSession;
        gateway.getSessions = originalGateway.getSessions;
        gateway.sendSessionMessage = originalGateway.sendSessionMessage;
    });

    it("lists, filters, and sorts sessions", async () => {
        const all = await requestJson<{ sessions: Session[] }>(
            server,
            "/api/sessions/list"
        );
        assert.equal(all.status, 200);
        assert.deepEqual(
            all.body.sessions.map((session) => session.key),
            ["agent:coder:subagent:worker", "agent:main:main"]
        );

        const filtered = await requestJson<{ sessions: Session[] }>(
            server,
            "/api/sessions/list?type=MAIN&model=cod"
        );
        assert.equal(filtered.status, 200);
        assert.deepEqual(
            filtered.body.sessions.map((session) => session.key),
            ["agent:main:main"]
        );
    });

    it("returns stats by type, model, tokens, and recent activity", async () => {
        const response = await requestJson<{
            total: number;
            byType: Record<string, number>;
            byModel: Record<string, number>;
            totalTokens: number;
            activeInLastHour: number;
        }>(server, "/api/sessions/stats");

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.byType, { MAIN: 1, SUBAGENT: 1 });
        assert.deepEqual(response.body.byModel, { codex: 1, kimi: 1 });
        assert.equal(response.body.totalTokens, 200);
        assert.equal(response.body.activeInLastHour, 1);
    });

    it("runs session actions and deletes sessions through the gateway", async () => {
        const compact = await requestJson<{ success: true; action: string }>(
            server,
            "/api/sessions/agent%3Amain%3Amain/action",
            { method: "POST", body: { action: "compact" } }
        );
        const reset = await requestJson<{ success: true; action: string }>(
            server,
            "/api/sessions/agent%3Amain%3Amain/action",
            { method: "POST", body: { action: "reset" } }
        );
        const stop = await requestJson<{ success: true; action: string }>(
            server,
            "/api/sessions/agent%3Amain%3Amain/action",
            { method: "POST", body: { action: "stop" } }
        );
        const unsupported = await requestJson<{ error: string }>(
            server,
            "/api/sessions/agent%3Amain%3Amain/action",
            { method: "POST", body: { action: "launch" } }
        );
        const deleteResponse = await requestJson<{
            success: true;
            result: { archived: true };
        }>(server, "/api/sessions/agent%3Amain%3Amain", { method: "DELETE" });

        assert.equal(compact.status, 200);
        assert.equal(reset.status, 200);
        assert.equal(stop.status, 200);
        assert.equal(unsupported.status, 400);
        assert.equal(deleteResponse.status, 200);
        assert.deepEqual(sentMessages, [
            { key: "agent:main:main", message: "/compact" },
            { key: "agent:main:main", message: "/reset" },
        ]);
        assert.deepEqual(aborted, ["agent:main:main"]);
        assert.deepEqual(deleted, ["agent:main:main"]);
    });
});
