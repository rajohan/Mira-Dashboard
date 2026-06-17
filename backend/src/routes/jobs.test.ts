import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import { db } from "../db.js";
import {
    __testing as scheduledJobsTesting,
    registerScheduledJobAction,
    upsertScheduledJob,
} from "../services/scheduledJobs.js";
import jobsRoutes, { __testing as jobsRouteTesting } from "./jobs.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
    const app = express();
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

async function requestRaw(
    server: TestServer,
    pathName: string,
    options: { method: string; body: string }
): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: options.method,
        headers: { "Content-Type": "application/json" },
        body: options.body,
    });

    return {
        status: response.status,
        body: (await response.json()) as unknown,
    };
}

test.beforeEach(() => {
    db.exec("DELETE FROM scheduled_job_runs; DELETE FROM scheduled_jobs;");
    scheduledJobsTesting.clearActionHandlers();
    scheduledJobsTesting.resetSchedulerState();
    registerScheduledJobAction("cache.refresh", async (job) => ({
        key: job.actionPayload.key,
    }));
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
        actionPayload: { key: "weather.spydeberg" },
    });
});

test.afterEach(() => {
    db.exec("DELETE FROM scheduled_job_runs; DELETE FROM scheduled_jobs;");
    scheduledJobsTesting.clearActionHandlers();
    scheduledJobsTesting.resetSchedulerState();
});

test("lists, fetches, updates, and runs scheduled jobs", async () => {
    const server = await startServer();
    try {
        const list = await requestJson<{ jobs: unknown[] }>(server, "/api/jobs");
        assert.equal(list.status, 200);
        assert.equal(list.body.jobs.length, 1);

        const detail = await requestJson<{ job: { id: string } }>(
            server,
            "/api/jobs/cache.weather"
        );
        assert.equal(detail.status, 200);
        assert.equal(detail.body.job.id, "cache.weather");

        const update = await requestJson<{
            ok: boolean;
            job: {
                cronExpression: string;
                enabled: boolean;
                scheduleType: string;
                timeOfDay: string;
            };
        }>(server, "/api/jobs/cache.weather", {
            method: "PATCH",
            body: {
                patch: {
                    cronExpression: "0 4 * * *",
                    enabled: false,
                    scheduleType: "cron",
                    timeOfDay: "08:15",
                    intervalSeconds: 3600,
                },
            },
        });
        assert.equal(update.status, 200);
        assert.equal(update.body.ok, true);
        assert.equal(update.body.job.enabled, false);
        assert.equal(update.body.job.scheduleType, "cron");
        assert.equal(update.body.job.cronExpression, "0 4 * * *");

        const run = await requestJson<{ ok: boolean; run: { status: string } }>(
            server,
            "/api/jobs/cache.weather/run",
            { method: "POST" }
        );
        assert.equal(run.status, 200);
        assert.equal(run.body.ok, true);
        assert.equal(run.body.run.status, "success");

        const runs = await requestJson<{ runs: { status: string }[] }>(
            server,
            "/api/jobs/cache.weather/runs"
        );
        assert.equal(runs.status, 200);
        assert.equal(runs.body.runs.length, 1);
        assert.equal(runs.body.runs[0]?.status, "success");
    } finally {
        await server.close();
    }
});

test("returns validation and missing job errors", async () => {
    const server = await startServer();
    try {
        const missingJob = await requestJson(server, "/api/jobs/missing");
        const missingPatch = await requestJson(server, "/api/jobs/missing", {
            method: "PATCH",
            body: { patch: { enabled: true } },
        });
        const invalidPatch = await requestJson(server, "/api/jobs/cache.weather", {
            method: "PATCH",
            body: { patch: null },
        });
        const invalidField = await requestJson(server, "/api/jobs/cache.weather", {
            method: "PATCH",
            body: { patch: { actionKey: "cache.refresh" } },
        });
        const invalidSchedule = await requestJson(server, "/api/jobs/cache.weather", {
            method: "PATCH",
            body: { patch: { intervalSeconds: 10 } },
        });
        const invalidIntervalType = await requestJson(server, "/api/jobs/cache.weather", {
            method: "PATCH",
            body: { patch: { intervalSeconds: "fast" } },
        });
        const invalidCronExpressionType = await requestJson(
            server,
            "/api/jobs/cache.weather",
            {
                method: "PATCH",
                body: { patch: { cronExpression: 4 } },
            }
        );
        const partialUpdate = await requestJson<{ ok: boolean }>(
            server,
            "/api/jobs/cache.weather",
            {
                method: "PATCH",
                body: { patch: { enabled: true } },
            }
        );
        const missingRun = await requestJson(server, "/api/jobs/missing/run", {
            method: "POST",
        });
        const missingRuns = await requestJson(server, "/api/jobs/missing/runs");

        assert.equal(missingJob.status, 404);
        assert.equal(missingPatch.status, 404);
        assert.equal(invalidPatch.status, 400);
        assert.equal(invalidField.status, 400);
        assert.equal(invalidSchedule.status, 400);
        assert.equal(invalidIntervalType.status, 400);
        assert.equal(invalidCronExpressionType.status, 400);
        assert.equal(partialUpdate.status, 200);
        assert.equal(partialUpdate.body.ok, true);
        assert.equal(missingRun.status, 404);
        assert.equal(missingRuns.status, 404);
    } finally {
        await server.close();
    }
});

test("maps malformed patch JSON when mounted behind global parser skip", async () => {
    const app = express();
    const globalJsonParser = express.json({ limit: "2097152b" });
    app.use((request, response, next) => {
        if (request.method === "PATCH" && /^\/api\/jobs\/[^/]+\/?$/u.test(request.path)) {
            next();
            return;
        }
        globalJsonParser(request, response, next);
    });
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
    const testServer = {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            ),
    };

    try {
        const result = await requestRaw(testServer, "/api/jobs/cache.weather", {
            method: "PATCH",
            body: "{",
        });

        assert.equal(result.status, 400);
        assert.deepEqual(result.body, { error: "Invalid scheduled job patch" });

        const trailingSlashResult = await requestRaw(
            testServer,
            "/api/jobs/cache.weather/",
            {
                method: "PATCH",
                body: "{",
            }
        );

        assert.equal(trailingSlashResult.status, 400);
        assert.deepEqual(trailingSlashResult.body, {
            error: "Invalid scheduled job patch",
        });

        const jobsJsonLimitBytes = Number(
            jobsRouteTesting.JOBS_JSON_LIMIT.replace(/b$/u, "")
        );
        const oversized = await requestRaw(testServer, "/api/jobs/cache.weather", {
            method: "PATCH",
            body: "x".repeat(jobsJsonLimitBytes + 1),
        });

        assert.equal(oversized.status, 413);
        assert.deepEqual(oversized.body, { error: "Scheduled job patch is too large" });

        const trailingSlashOversized = await requestRaw(
            testServer,
            "/api/jobs/cache.weather/",
            {
                method: "PATCH",
                body: "x".repeat(jobsJsonLimitBytes + 1),
            }
        );

        assert.equal(trailingSlashOversized.status, 413);
        assert.deepEqual(trailingSlashOversized.body, {
            error: "Scheduled job patch is too large",
        });
    } finally {
        await testServer.close();
    }
});

test("forwards unexpected patch failures to the async route fallback", async (t) => {
    const server = await startServer();
    const prepare = db.prepare.bind(db);
    const prepareMock = t.mock.method(db, "prepare", (sql: string) => {
        if (sql.includes("UPDATE scheduled_jobs")) {
            throw new Error("update unavailable");
        }
        return prepare(sql);
    });
    try {
        const result = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather",
            {
                method: "PATCH",
                body: { patch: { enabled: false } },
            }
        );

        assert.equal(result.status, 500);
        assert.equal(result.body.error, "update unavailable");
    } finally {
        prepareMock.mock.restore();
        await server.close();
    }
});

test("covers route helper edge cases", () => {
    const statusCodes: number[] = [];
    const bodies: unknown[] = [];
    const response = {
        status(code: number) {
            statusCodes.push(code);
            return response;
        },
        json(body: unknown) {
            bodies.push(body);
            return response;
        },
    };
    const nextCalls: unknown[] = [];
    const next = (error: unknown) => {
        nextCalls.push(error);
    };

    jobsRouteTesting.invalidJobsJsonHandler(
        Object.assign(new Error("too large"), { status: 413 }),
        {} as never,
        response as never,
        next
    );
    jobsRouteTesting.invalidJobsJsonHandler(
        Object.assign(new SyntaxError("bad json"), { status: 400 }),
        {} as never,
        response as never,
        next
    );
    const unexpectedError = new Error("unexpected");
    jobsRouteTesting.invalidJobsJsonHandler(
        unexpectedError,
        {} as never,
        response as never,
        next
    );

    assert.deepEqual(statusCodes, [413, 400]);
    assert.deepEqual(bodies, [
        { error: "Scheduled job patch is too large" },
        { error: "Invalid scheduled job patch" },
    ]);
    assert.deepEqual(nextCalls, [unexpectedError]);
    assert.equal(jobsRouteTesting.httpStatusCode(new Error("x")), 500);
    const conflictError = Object.assign(new Error("x"), { statusCode: 409 });
    assert.equal(jobsRouteTesting.httpStatusCode(conflictError), 409);
    assert.equal(jobsRouteTesting.invalidPatchField({ enabled: "yes" }), "enabled");
    assert.equal(
        jobsRouteTesting.invalidPatchField({ scheduleType: "weekly" }),
        "scheduleType"
    );
    assert.equal(jobsRouteTesting.invalidPatchField({ timeOfDay: 815 }), "timeOfDay");
    assert.equal(
        jobsRouteTesting.invalidPatchField({ cronExpression: 4 }),
        "cronExpression"
    );
});
