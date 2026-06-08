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
    __testing.seedDefaultScheduledJobs();
    __testing.setActionExecutorForTests(async (job) => ({
        actionTarget: job.actionTarget,
    }));
});

test.afterEach(() => {
    db.exec("DELETE FROM scheduled_job_runs; DELETE FROM scheduled_jobs;");
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
        const partialIntervalPatch = await requestJson<{
            job: { scheduleType: string };
        }>(server, "/api/jobs/cache.weather", {
            method: "PATCH",
            body: { patch: { scheduleType: "interval" } },
        });
        const partialDailyPatch = await requestJson<{
            job: { scheduleType: string; timeOfDay: string | null };
        }>(server, "/api/jobs/cache.git", {
            method: "PATCH",
            body: { patch: { scheduleType: "daily" } },
        });
        const cronPatch = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather",
            {
                method: "PATCH",
                body: { patch: { scheduleType: "cron", timeOfDay: null } },
            }
        );
        const badIntervalPatch = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather",
            {
                method: "PATCH",
                body: { patch: { scheduleType: "interval", intervalSeconds: 10 } },
            }
        );
        const fractionalIntervalPatch = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather",
            {
                method: "PATCH",
                body: { patch: { scheduleType: "interval", intervalSeconds: 60.5 } },
            }
        );
        const badDailyPatch = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather",
            {
                method: "PATCH",
                body: { patch: { scheduleType: "daily", timeOfDay: null } },
            }
        );
        const badDailyRangePatch = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather",
            {
                method: "PATCH",
                body: { patch: { scheduleType: "daily", timeOfDay: "99:00" } },
            }
        );
        const serviceValidationPatch = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather",
            {
                method: "PATCH",
                body: { patch: { intervalSeconds: 10 } },
            }
        );
        const unknownPatch = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather",
            {
                method: "PATCH",
                body: { patch: { enabled: true, surprise: true } },
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
        assert.equal(partialIntervalPatch.status, 200);
        assert.equal(partialIntervalPatch.body.job.scheduleType, "interval");
        assert.equal(partialDailyPatch.status, 200);
        assert.equal(partialDailyPatch.body.job.scheduleType, "daily");
        assert.equal(partialDailyPatch.body.job.timeOfDay, "02:40");
        assert.equal(cronPatch.status, 400);
        assert.equal(cronPatch.body.error, "cron schedule is not implemented yet");
        assert.equal(badIntervalPatch.status, 400);
        assert.equal(
            badIntervalPatch.body.error,
            "intervalSeconds must be an integer >= 60"
        );
        assert.equal(fractionalIntervalPatch.status, 400);
        assert.equal(
            fractionalIntervalPatch.body.error,
            "intervalSeconds must be an integer >= 60"
        );
        assert.equal(badDailyPatch.status, 400);
        assert.equal(badDailyPatch.body.error, "timeOfDay must be HH:mm for daily jobs");
        assert.equal(badDailyRangePatch.status, 400);
        assert.equal(
            badDailyRangePatch.body.error,
            "timeOfDay must be HH:mm for daily jobs"
        );
        assert.equal(serviceValidationPatch.status, 400);
        assert.match(serviceValidationPatch.body.error, /integer >= 60/u);
        assert.equal(unknownPatch.status, 400);
        assert.equal(unknownPatch.body.error, "invalid patch field: surprise");
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

test("maps scheduled job patch races and unexpected update errors", async () => {
    const server = await startServer();
    try {
        const originalPrepare = db.prepare.bind(db);
        let selectCount = 0;
        const selectMock = test.mock.method(db, "prepare", (sql: string) => {
            if (sql === "SELECT * FROM scheduled_jobs WHERE id = ? LIMIT 1") {
                selectCount += 1;
                const statement = originalPrepare(sql);
                if (selectCount === 3) {
                    return {
                        get: () => null,
                    } as unknown as ReturnType<typeof db.prepare>;
                }
                return statement;
            }
            return originalPrepare(sql);
        });
        const missingAfterUpdate = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather",
            { method: "PATCH", body: { patch: { enabled: false } } }
        );
        selectMock.mock.restore();

        let validationSelectCount = 0;
        const validationRaceMock = test.mock.method(db, "prepare", (sql: string) => {
            if (sql === "SELECT * FROM scheduled_jobs WHERE id = ? LIMIT 1") {
                validationSelectCount += 1;
                const statement = originalPrepare(sql);
                if (validationSelectCount === 2) {
                    return {
                        get: (id: string) => ({
                            ...(statement.get(id) as Record<string, unknown>),
                            interval_seconds: 10,
                        }),
                    } as unknown as ReturnType<typeof db.prepare>;
                }
                return statement;
            }
            return originalPrepare(sql);
        });
        const validationRace = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather",
            { method: "PATCH", body: { patch: { enabled: false } } }
        );
        validationRaceMock.mock.restore();

        const updateMock = test.mock.method(db, "prepare", (sql: string) => {
            const statement = originalPrepare(sql);
            if (sql.includes("UPDATE scheduled_jobs")) {
                return {
                    run: () => {
                        throw new Error("database crashed");
                    },
                } as unknown as ReturnType<typeof db.prepare>;
            }
            return statement;
        });
        const unexpectedError = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather",
            { method: "PATCH", body: { patch: { enabled: false } } }
        );
        updateMock.mock.restore();

        assert.equal(missingAfterUpdate.status, 404);
        assert.equal(missingAfterUpdate.body.error, "Scheduled job not found");
        assert.equal(validationRace.status, 400);
        assert.equal(
            validationRace.body.error,
            "intervalSeconds must be an integer >= 60"
        );
        assert.equal(unexpectedError.status, 500);
        assert.equal(unexpectedError.body.error, "database crashed");
    } finally {
        test.mock.restoreAll();
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
    assert.equal(jobsRouteTesting.httpStatusCode({ statusCode: Number.NaN }), 500);
    assert.equal(jobsRouteTesting.httpStatusCode({ statusCode: 99 }), 500);
    assert.equal(jobsRouteTesting.httpStatusCode({ statusCode: 600 }), 500);
    assert.equal(jobsRouteTesting.httpStatusCode(new Error("plain")), 500);
});

test("maps manual duplicate run status codes", async () => {
    const server = await startServer();
    let finishExecution!: () => void;
    let first: Promise<Response> | null = null;
    const started = new Promise<void>((resolve) => {
        __testing.setActionExecutorForTests(async () => {
            resolve();
            await new Promise<void>((finish) => {
                finishExecution = finish;
            });
            return { ok: true };
        });
    });
    try {
        first = fetch(`${server.baseUrl}/api/jobs/cache.weather/run`, {
            method: "POST",
        });
        await started;
        const duplicate = await requestJson<{ error: string }>(
            server,
            "/api/jobs/cache.weather/run",
            { method: "POST" }
        );
        assert.equal(duplicate.status, 409);
        assert.equal(duplicate.body.error, "Scheduled job is already running");
        finishExecution();
        await first;
    } finally {
        if (typeof finishExecution === "function") {
            finishExecution();
        }
        await first?.catch(() => {});
        await server.close();
    }
});
