import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import express from "express";

import gateway from "../gateway.js";
import cronRoutes from "./cron.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalRequest = gateway.request;

async function startServer(): Promise<TestServer> {
    const app = express();
    app.use(express.json());
    cronRoutes(app);
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

describe("cron routes", () => {
    let server: TestServer;
    const calls: Array<{ method: string; params: unknown }> = [];
    let listPayload: unknown = {
        jobs: [
            {
                jobId: "job-1",
                name: "Heartbeat",
                enabled: true,
                schedule: { kind: "every", everyMs: 30_000 },
                payload: { kind: "systemEvent", text: "check" },
            },
        ],
    };

    before(async () => {
        gateway.request = async (method: string, params?: unknown) => {
            calls.push({ method, params });

            if (method === "cron.list") {
                return listPayload;
            }

            if (method === "cron.update") {
                return { updated: true };
            }

            if (method === "cron.run") {
                return { runId: "run-1" };
            }

            throw new Error(`Unexpected gateway method: ${method}`);
        };
        server = await startServer();
    });

    after(async () => {
        await server.close();
        gateway.request = originalRequest;
    });

    it("lists jobs from both cron response shapes", async () => {
        calls.length = 0;
        const jobsResponse = await requestJson<{ jobs: Array<{ jobId: string }> }>(
            server,
            "/api/cron/jobs"
        );

        assert.equal(jobsResponse.status, 200);
        assert.deepEqual(
            jobsResponse.body.jobs.map((job) => job.jobId),
            ["job-1"]
        );
        assert.deepEqual(calls, [
            { method: "cron.list", params: { includeDisabled: true } },
        ]);

        listPayload = { items: [{ jobId: "job-2" }] };
        const itemsResponse = await requestJson<{ jobs: Array<{ jobId: string }> }>(
            server,
            "/api/cron/jobs"
        );
        assert.equal(itemsResponse.status, 200);
        assert.deepEqual(
            itemsResponse.body.jobs.map((job) => job.jobId),
            ["job-2"]
        );

        listPayload = { unexpected: true };
        const emptyResponse = await requestJson<{ jobs: unknown[] }>(
            server,
            "/api/cron/jobs"
        );
        assert.equal(emptyResponse.status, 200);
        assert.deepEqual(emptyResponse.body.jobs, []);
    });

    it("validates and toggles job enabled state", async () => {
        const invalid = await requestJson<{ error: string }>(
            server,
            "/api/cron/jobs/job-1/toggle",
            { method: "POST", body: { enabled: "yes" } }
        );
        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.error, "enabled must be a boolean");

        calls.length = 0;
        const response = await requestJson<{ ok: true }>(
            server,
            "/api/cron/jobs/job-1/toggle",
            { method: "POST", body: { enabled: false } }
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.deepEqual(calls, [
            {
                method: "cron.update",
                params: { jobId: "job-1", patch: { enabled: false } },
            },
        ]);
    });

    it("validates update patches and runs jobs", async () => {
        const invalid = await requestJson<{ error: string }>(
            server,
            "/api/cron/jobs/job-1/update",
            { method: "POST", body: { patch: [] } }
        );
        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.error, "patch must be an object");

        calls.length = 0;
        const update = await requestJson<{ ok: true }>(
            server,
            "/api/cron/jobs/job-1/update",
            { method: "POST", body: { patch: { name: "New name" } } }
        );
        assert.equal(update.status, 200);
        assert.deepEqual(calls, [
            {
                method: "cron.update",
                params: { jobId: "job-1", patch: { name: "New name" } },
            },
        ]);

        calls.length = 0;
        const run = await requestJson<{ ok: true; payload: { runId: string } }>(
            server,
            "/api/cron/jobs/job-1/run",
            { method: "POST" }
        );
        assert.equal(run.status, 200);
        assert.deepEqual(run.body, { ok: true, payload: { runId: "run-1" } });
        assert.deepEqual(calls, [{ method: "cron.run", params: { jobId: "job-1" } }]);
    });

    it("returns gateway errors as route errors", async () => {
        gateway.request = async () => {
            throw new Error("gateway unavailable");
        };

        const response = await requestJson<{ error: string }>(server, "/api/cron/jobs");

        assert.equal(response.status, 500);
        assert.equal(response.body.error, "gateway unavailable");
    });
});
