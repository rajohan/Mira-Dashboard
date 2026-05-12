import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import express from "express";

import execRoutes from "./exec.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
    const app = express();
    app.use(express.json());
    execRoutes(app, express);
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

async function waitForJob(
    server: TestServer,
    jobId: string
): Promise<{
    jobId: string;
    status: "running" | "done";
    code: number | null;
    stdout: string;
    stderr: string;
}> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await requestJson<{
            jobId: string;
            status: "running" | "done";
            code: number | null;
            stdout: string;
            stderr: string;
        }>(server, `/api/exec/${jobId}`);

        assert.equal(response.status, 200);
        if (response.body.status === "done") {
            return response.body;
        }

        await delay(25);
    }

    throw new Error(`Timed out waiting for exec job ${jobId}`);
}

describe("exec routes", () => {
    let server: TestServer;

    before(async () => {
        server = await startServer();
    });

    after(async () => {
        await server.close();
    });

    it("runs one-shot commands with explicit args", async () => {
        const response = await requestJson<{
            code: number;
            stdout: string;
            stderr: string;
        }>(server, "/api/exec", {
            method: "POST",
            body: {
                command: process.execPath,
                args: ["-e", "console.log('hello exec'); console.error('warn exec')"],
            },
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.code, 0);
        assert.equal(response.body.stdout, "hello exec\n");
        assert.equal(response.body.stderr, "warn exec\n");
    });

    it("keeps arbitrary shell syntax out of terminal commands", async () => {
        const rejected = await requestJson<{ error: string }>(server, "/api/exec", {
            method: "POST",
            body: { command: "echo safe && echo unsafe" },
        });

        assert.equal(rejected.status, 400);
        assert.match(rejected.body.error, /shell operators/u);
    });

    it("allows approved ops commands to run through explicit shell mode", async () => {
        const response = await requestJson<{
            code: number;
            stdout: string;
            stderr: string;
        }>(server, "/api/exec", {
            method: "POST",
            body: {
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            },
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.code, 127);
        assert.match(response.body.stderr, /not found/u);
    });

    it("rejects unapproved shell mode commands", async () => {
        const rejected = await requestJson<{ error: string }>(server, "/api/exec", {
            method: "POST",
            body: { command: "echo nope", shell: true },
        });

        assert.equal(rejected.status, 400);
        assert.match(rejected.body.error, /approved ops commands/u);
    });

    it("starts background jobs and exposes their final state", async () => {
        const started = await requestJson<{ jobId: string }>(server, "/api/exec/start", {
            method: "POST",
            body: {
                command: process.execPath,
                args: ["-e", "setTimeout(() => console.log('done async'), 10)"],
            },
        });

        assert.equal(started.status, 200);
        assert.match(started.body.jobId, /^[\da-f-]{36}$/u);

        const job = await waitForJob(server, started.body.jobId);
        assert.equal(job.jobId, started.body.jobId);
        assert.equal(job.status, "done");
        assert.equal(job.code, 0);
        assert.equal(job.stdout, "done async\n");
        assert.equal(job.stderr, "");
    });

    it("reports missing jobs and refuses to stop completed jobs", async () => {
        const missing = await requestJson<{ error: string }>(
            server,
            "/api/exec/00000000-0000-0000-0000-000000000000"
        );
        assert.equal(missing.status, 404);
        assert.equal(missing.body.error, "Exec job not found");

        const started = await requestJson<{ jobId: string }>(server, "/api/exec/start", {
            method: "POST",
            body: {
                command: process.execPath,
                args: ["-e", "console.log('already done')"],
            },
        });
        const job = await waitForJob(server, started.body.jobId);
        assert.equal(job.status, "done");

        const stop = await requestJson<{ error: string }>(
            server,
            `/api/exec/${started.body.jobId}/stop`,
            { method: "POST" }
        );
        assert.equal(stop.status, 400);
        assert.equal(stop.body.error, "Job is not running");
    });
});
