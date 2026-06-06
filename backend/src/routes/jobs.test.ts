import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import { db } from "../db.js";
import { __testing } from "../services/scheduledJobs.js";
import jobsRoutes from "./jobs.js";
import { __testing as jobsRouteTesting } from "./jobs.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
    const app = express();
    app.use(express.json());
    jobsRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve, reject) => {
        const onListening = () => {
            server.off("error", onError);
            resolve();
        };
        const onError = (error: Error) => {
            server.off("listening", onListening);
            reject(error);
        };
        server.once("listening", onListening);
        server.once("error", onError);
        server.listen(0);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            ),
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

test.beforeEach(() => {
    db.exec("DELETE FROM scheduled_job_runs; DELETE FROM scheduled_jobs;");
    __testing.setActionExecutorForTests(async (job) => ({
        actionTarget: job.actionTarget,
    }));
});

test.afterEach(() => {
    __testing.setActionExecutorForTests(undefined);
});

test("lists, fetches, updates, and runs backend scheduled jobs", async () => {
    const server = await startServer();
    try {
        const list = await requestJson<{ jobs: unknown[] }>(server, "/api/jobs");
        assert.equal(list.status, 200);
        assert.ok(list.body.jobs.length > 0);

        const detail = await requestJson<{ job: { id: string } }>(
            server,
            "/api/jobs/cache.weather"
        );
        assert.equal(detail.status, 200);
        assert.equal(detail.body.job.id, "cache.weather");

        const update = await requestJson<{
            job: { enabled: boolean; scheduleType: string; timeOfDay: string };
        }>(server, "/api/jobs/cache.weather", {
            method: "PATCH",
            body: {
                patch: {
                    enabled: false,
                    scheduleType: "daily",
                    timeOfDay: "08:15",
                    intervalSeconds: 3600,
                },
            },
        });
        assert.equal(update.status, 200);
        assert.equal(update.body.job.enabled, false);
        assert.equal(update.body.job.scheduleType, "daily");
        assert.equal(update.body.job.timeOfDay, "08:15");

        const run = await requestJson<{ ok: boolean; run: { status: string } }>(
            server,
            "/api/jobs/cache.weather/run",
            { method: "POST" }
        );
        assert.equal(run.status, 200);
        assert.equal(run.body.ok, true);
        assert.equal(run.body.run.status, "success");
    } finally {
        await server.close();
    }
});

test("returns validation and missing job errors", async () => {
    const server = await startServer();
    try {
        const missingJob = await requestJson(server, "/api/jobs/missing");
        const invalidPatch = await requestJson(server, "/api/jobs/cache.weather", {
            method: "PATCH",
            body: { patch: null },
        });
        const missingRun = await requestJson(server, "/api/jobs/missing/run", {
            method: "POST",
        });
        const missingPatch = await requestJson(server, "/api/jobs/missing", {
            method: "PATCH",
            body: { patch: { enabled: true } },
        });
        const cronPatch = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather",
            {
                method: "PATCH",
                body: { patch: { scheduleType: "cron", timeOfDay: null } },
            }
        );
        const invalidPatchFields = await Promise.all(
            [
                { enabled: "true" },
                { intervalSeconds: "3600" },
                { scheduleType: "unknown" },
                { timeOfDay: 123 },
            ].map((patch) =>
                requestJson<{ error: string }>(server, "/api/jobs/cache.weather", {
                    method: "PATCH",
                    body: { patch },
                })
            )
        );

        assert.equal(missingJob.status, 404);
        assert.equal(invalidPatch.status, 400);
        assert.equal(missingRun.status, 404);
        assert.equal(missingPatch.status, 404);
        assert.equal(cronPatch.status, 500);
        assert.equal(cronPatch.body.error, "cron schedule is not implemented yet");
        assert.deepEqual(
            invalidPatchFields.map((response) => [response.status, response.body.error]),
            [
                [400, "invalid patch field: enabled"],
                [400, "invalid patch field: intervalSeconds"],
                [400, "invalid patch field: scheduleType"],
                [400, "invalid patch field: timeOfDay"],
            ]
        );
    } finally {
        await server.close();
    }
});

test("maps manual run failures", async () => {
    const server = await startServer();
    try {
        __testing.setActionExecutorForTests(async () => {
            throw new Error("refresh failed");
        });
        const failedRun = await requestJson<{
            ok: boolean;
            run: { message: string; status: string };
        }>(server, "/api/jobs/cache.weather/run", { method: "POST" });
        assert.equal(failedRun.status, 200);
        assert.equal(failedRun.body.ok, false);
        assert.equal(failedRun.body.run.status, "failed");
        assert.equal(failedRun.body.run.message, "refresh failed");
    } finally {
        await server.close();
    }
});

test("covers jobs route status fallback helper", () => {
    assert.equal(jobsRouteTesting.httpStatusCode({ statusCode: 409 }), 409);
    assert.equal(jobsRouteTesting.httpStatusCode(new Error("plain")), 500);
});

test("maps manual duplicate run status codes", async () => {
    const server = await startServer();
    try {
        __testing.setActionExecutorForTests(
            () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 30))
        );
        const first = fetch(`${server.baseUrl}/api/jobs/cache.weather/run`, {
            method: "POST",
        });
        await new Promise((resolve) => setImmediate(resolve));
        const duplicate = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather/run",
            { method: "POST" }
        );
        assert.equal(duplicate.status, 409);
        assert.equal(duplicate.body.error, "Scheduled job is already running");
        await first;
    } finally {
        await server.close();
    }
});
