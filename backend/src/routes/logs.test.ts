import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

import logsRoutes, { __testing, subscribeToLogs, unsubscribeFromLogs } from "./logs.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const logsDir = "/tmp/openclaw";
const outsideDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-logs-outside-"));
const testFiles = ["openclaw-2099-03-03.log", "openclaw-2099-03-04.log"];

class FakeWebSocket {
    readonly sent: string[] = [];

    send(data: string): void {
        this.sent.push(data);
    }
}

async function startServer(): Promise<TestServer> {
    const app = express();
    logsRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

describe("logs routes", () => {
    let server: TestServer;

    before(async () => {
        await mkdir(logsDir, { recursive: true });
        await mkdir(outsideDir, { recursive: true });
        await writeFile(
            path.join(logsDir, testFiles[0]),
            "old line 1\nold line 2\n",
            "utf8"
        );
        await writeFile(
            path.join(logsDir, testFiles[1]),
            "first\n\nsecond\nthird\n",
            "utf8"
        );
        await writeFile(path.join(logsDir, "not-openclaw.txt"), "ignored", "utf8");
        await writeFile(path.join(outsideDir, "secret.log"), "secret", "utf8");
        server = await startServer();
    });

    after(async () => {
        __testing.resetLogWatcherForTest();
        await server.close();
        for (const file of [...testFiles, "not-openclaw.txt"]) {
            await rm(path.join(logsDir, file), { force: true });
        }
        await rm(outsideDir, { recursive: true, force: true });
    });

    it("lists OpenClaw log files and ignores unrelated files", async () => {
        const response = await fetch(`${server.baseUrl}/api/logs/info`);
        const body = (await response.json()) as {
            logs: Array<{ name: string; size: number; modified: string }>;
        };

        assert.equal(response.status, 200);
        assert.equal(
            body.logs.some((log) => log.name === testFiles[0]),
            true
        );
        assert.equal(
            body.logs.some((log) => log.name === testFiles[1]),
            true
        );
        assert.equal(
            body.logs.some((log) => log.name === "not-openclaw.txt"),
            false
        );
    });

    it("returns full or tailed log content", async () => {
        const full = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(testFiles[1])}`
        );
        const fullBody = (await full.json()) as { content: string; file: string };

        assert.equal(full.status, 200);
        assert.equal(fullBody.file, testFiles[1]);
        assert.equal(fullBody.content, "first\n\nsecond\nthird\n");

        const tailed = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(
                testFiles[1]
            )}&lines=2`
        );
        const tailedBody = (await tailed.json()) as { content: string; file: string };

        assert.equal(tailed.status, 200);
        assert.equal(tailedBody.content, "second\nthird");

        const invalidTail = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(
                testFiles[1]
            )}&lines=not-a-number`
        );
        const invalidTailBody = (await invalidTail.json()) as { content: string };
        assert.equal(invalidTail.status, 200);
        assert.equal(invalidTailBody.content, "first\n\nsecond\nthird\n");
    });

    it("rejects traversal and reports missing logs", async () => {
        const traversal = path.relative(logsDir, path.join(outsideDir, "secret.log"));
        const denied = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(traversal)}`
        );
        assert.equal(denied.status, 403);
        assert.deepEqual(await denied.json(), { error: "Access denied" });

        const missing = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent("openclaw-2099-03-05.log")}`
        );
        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), { error: "Log file not found" });
    });

    it("sends log history to WebSocket subscribers and tracks unsubscribe", async () => {
        const today = new Date().toISOString().split("T")[0];
        const todayFile = `openclaw-${today}.log`;
        await writeFile(
            path.join(logsDir, todayFile),
            "ignored blank\n\nlatest one\nlatest two\n",
            "utf8"
        );

        const ws = new FakeWebSocket();
        subscribeToLogs(ws as never);

        assert.equal(__testing.subscriberCount(), 1);
        assert.deepEqual(JSON.parse(ws.sent[0] || "{}"), {
            type: "log_file",
            file: todayFile,
        });
        assert.deepEqual(
            ws.sent.slice(1, -1).map((message) => JSON.parse(message)),
            [
                { type: "log", line: "ignored blank" },
                { type: "log", line: "latest one" },
                { type: "log", line: "latest two" },
            ]
        );
        assert.deepEqual(JSON.parse(ws.sent.at(-1) || "{}"), {
            type: "log_history_complete",
            count: 3,
        });

        unsubscribeFromLogs(ws as never);
        assert.equal(__testing.subscriberCount(), 0);
        __testing.resetLogWatcherForTest();
        await rm(path.join(logsDir, todayFile), { force: true });
    });

    it("sends empty log history when today's log is missing", async () => {
        const today = new Date().toISOString().split("T")[0];
        const todayFile = `openclaw-${today}.log`;
        await rm(path.join(logsDir, todayFile), { force: true });

        const ws = new FakeWebSocket();
        subscribeToLogs(ws as never);

        assert.deepEqual(JSON.parse(ws.sent[0] || "{}"), {
            type: "log_file",
            file: todayFile,
        });
        assert.deepEqual(JSON.parse(ws.sent[1] || "{}"), {
            type: "log_history_complete",
            count: 0,
        });

        __testing.resetLogWatcherForTest();
    });
});
