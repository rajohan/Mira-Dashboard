import assert from "node:assert/strict";
import test from "node:test";

import { db } from "../db.js";
import {
    __testing,
    calculateNextRunAt,
    getScheduledJob,
    listScheduledJobs,
    registerScheduledJobAction,
    runScheduledJob,
    startScheduledJobScheduler,
    stopScheduledJobScheduler,
    updateScheduledJob,
    upsertScheduledJob,
} from "./scheduledJobs.js";

test.beforeEach(() => {
    db.exec("DELETE FROM scheduled_job_runs; DELETE FROM scheduled_jobs;");
    __testing.clearActionHandlers();
    __testing.resetSchedulerState();
});

test.afterEach(() => {
    db.exec("DELETE FROM scheduled_job_runs; DELETE FROM scheduled_jobs;");
    __testing.clearActionHandlers();
    __testing.resetSchedulerState();
});

test("creates, lists, updates, and schedules jobs", () => {
    assert.deepEqual(listScheduledJobs(), []);

    const job = upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        description: "Refreshes weather cache rows",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
        actionPayload: { key: "weather.spydeberg" },
    });

    assert.equal(job.id, "cache.weather");
    assert.equal(job.description, "Refreshes weather cache rows");
    assert.equal(job.enabled, true);
    assert.equal(job.actionPayload.key, "weather.spydeberg");
    assert.ok(job.nextRunAt);
    assert.equal(listScheduledJobs().length, 1);

    const updated = updateScheduledJob("cache.weather", {
        enabled: false,
        scheduleType: "daily",
        timeOfDay: "04:30",
    });

    assert.equal(updated?.enabled, false);
    assert.equal(updated?.nextRunAt, null);
    assert.equal(updated?.scheduleType, "daily");
    assert.equal(updated?.timeOfDay, "04:30");
    assert.equal(updateScheduledJob("missing", { enabled: true }), null);
});

test("calculates interval and daily next-run times", () => {
    const from = new Date("2026-06-11T10:00:00.000Z");
    assert.equal(
        calculateNextRunAt(
            {
                enabled: true,
                intervalSeconds: 120,
                scheduleType: "interval",
                timeOfDay: null,
            },
            from
        ),
        "2026-06-11T10:02:00.000Z"
    );
    assert.equal(
        calculateNextRunAt(
            {
                enabled: true,
                intervalSeconds: 3600,
                scheduleType: "daily",
                timeOfDay: "12:30",
            },
            from
        ),
        "2026-06-11T12:30:00.000Z"
    );
    assert.equal(
        calculateNextRunAt(
            {
                enabled: true,
                intervalSeconds: 3600,
                scheduleType: "daily",
                timeOfDay: "11:30",
            },
            from
        ),
        "2026-06-11T11:30:00.000Z"
    );
    assert.equal(
        calculateNextRunAt(
            {
                enabled: true,
                intervalSeconds: 3600,
                scheduleType: "daily",
                timeOfDay: "10:00",
            },
            from
        ),
        "2026-06-12T10:00:00.000Z"
    );
    assert.equal(
        calculateNextRunAt(
            {
                enabled: false,
                intervalSeconds: 3600,
                scheduleType: "interval",
                timeOfDay: null,
            },
            from
        ),
        null
    );
});

test("calculates cron next-run times", () => {
    const from = new Date("2026-06-11T10:00:30.000Z");
    assert.equal(
        calculateNextRunAt(
            {
                cronExpression: "*/15 10 * * *",
                enabled: true,
                intervalSeconds: 3600,
                scheduleType: "cron",
                timeOfDay: null,
            },
            from
        ),
        "2026-06-11T10:15:00.000Z"
    );
    assert.equal(
        calculateNextRunAt(
            {
                cronExpression: "0 8 * * 1-5",
                enabled: true,
                intervalSeconds: 3600,
                scheduleType: "cron",
                timeOfDay: null,
            },
            new Date("2026-06-12T08:00:00.000Z")
        ),
        "2026-06-15T08:00:00.000Z"
    );
    assert.equal(
        calculateNextRunAt(
            {
                cronExpression: "0 0 * * 7",
                enabled: true,
                intervalSeconds: 3600,
                scheduleType: "cron",
                timeOfDay: null,
            },
            new Date("2026-06-13T23:59:00.000Z")
        ),
        "2026-06-14T00:00:00.000Z"
    );
    assert.equal(
        calculateNextRunAt(
            {
                cronExpression: "5/15 10 * * *",
                enabled: true,
                intervalSeconds: 3600,
                scheduleType: "cron",
                timeOfDay: null,
            },
            new Date("2026-06-11T10:00:00.000Z")
        ),
        "2026-06-11T10:05:00.000Z"
    );
    assert.equal(
        calculateNextRunAt(
            {
                cronExpression: "0 9 1 * 1",
                enabled: true,
                intervalSeconds: 3600,
                scheduleType: "cron",
                timeOfDay: null,
            },
            new Date("2026-06-02T09:00:00.000Z")
        ),
        "2026-06-08T09:00:00.000Z"
    );
    assert.throws(
        () =>
            calculateNextRunAt(
                {
                    cronExpression: "invalid",
                    enabled: true,
                    intervalSeconds: 3600,
                    scheduleType: "cron",
                    timeOfDay: null,
                },
                from
            ),
        /Cron jobs require/u
    );
    assert.throws(
        () =>
            calculateNextRunAt(
                {
                    cronExpression: "0 0 31 2 *",
                    enabled: true,
                    intervalSeconds: 3600,
                    scheduleType: "cron",
                    timeOfDay: null,
                },
                from
            ),
        /no upcoming run/u
    );
});

test("runs registered actions and records latest run state", async () => {
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

    const run = await runScheduledJob("cache.weather");

    assert.equal(run.status, "success");
    assert.deepEqual(run.output, { key: "weather.spydeberg" });
    assert.equal(getScheduledJob("cache.weather")?.lastRun?.id, run.id);
});

test("lists latest runs for jobs across query chunks", () => {
    const insertJob = db.prepare(
        `INSERT INTO scheduled_jobs (
            id, name, description, enabled, schedule_type, interval_seconds, time_of_day,
            cron_expression, action_key, action_payload_json, next_run_at, created_at, updated_at
        ) VALUES (?, ?, '', 1, 'interval', 120, NULL, NULL, 'cache.refresh', '{}', NULL, ?, ?)`
    );
    const insertRun = db.prepare(
        `INSERT INTO scheduled_job_runs (
            job_id, status, trigger_type, started_at, finished_at, message, output_json
        ) VALUES (?, 'success', 'schedule', ?, ?, ?, '{}')`
    );
    for (let index = 0; index < 901; index += 1) {
        const id = `cache.job.${String(index).padStart(3, "0")}`;
        insertJob.run(id, id, "2026-06-11T00:00:00.000Z", "2026-06-11T00:00:00.000Z");
        if (index === 0 || index === 900) {
            insertRun.run(
                id,
                "2026-06-11T00:00:00.000Z",
                "2026-06-11T00:00:01.000Z",
                `${id}.old`
            );
            insertRun.run(
                id,
                "2026-06-11T00:01:00.000Z",
                "2026-06-11T00:01:01.000Z",
                `${id}.latest`
            );
        }
    }

    const jobs = listScheduledJobs();

    assert.equal(jobs.length, 901);
    assert.equal(jobs.at(0)?.lastRun?.message, "cache.job.000.latest");
    assert.equal(jobs.at(-1)?.lastRun?.message, "cache.job.900.latest");
});

test("normalizes non-object JSON payloads from persisted rows", async () => {
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

    db.prepare("UPDATE scheduled_jobs SET action_payload_json = ? WHERE id = ?").run(
        "[]",
        "cache.weather"
    );
    assert.deepEqual(getScheduledJob("cache.weather")?.actionPayload, {});
    db.prepare("UPDATE scheduled_jobs SET action_payload_json = ? WHERE id = ?").run(
        "{",
        "cache.weather"
    );
    assert.deepEqual(getScheduledJob("cache.weather")?.actionPayload, {});

    const run = await runScheduledJob("cache.weather");
    db.prepare("UPDATE scheduled_job_runs SET output_json = ? WHERE id = ?").run(
        "[]",
        run.id
    );
    assert.deepEqual(getScheduledJob("cache.weather")?.lastRun?.output, {});
    // __testing.mapRunForTest() returns null when no internal run row is present.
    assert.equal(__testing.mapRunForTest(), null, "missing run rows map to null");
});

test("keeps existing schedule defaults and due time when upserting existing jobs", () => {
    const initial = upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2026-01-01T00:00:00.000Z",
        "cache.weather"
    );

    const updated = upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache renamed",
        scheduleType: "interval",
        actionKey: "cache.refresh",
    });
    const disabled = upsertScheduledJob({
        id: "cache.disabled",
        name: "Disabled cache",
        enabled: false,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });

    assert.equal(updated.enabled, true);
    assert.equal(updated.intervalSeconds, 120);
    assert.equal(updated.createdAt, initial.createdAt);
    assert.equal(updated.nextRunAt, "2026-01-01T00:00:00.000Z");
    assert.equal(disabled.enabled, false);
});

test("inherits existing daily time when upserting daily jobs", () => {
    upsertScheduledJob({
        id: "cache.daily",
        name: "Daily cache",
        enabled: true,
        scheduleType: "daily",
        timeOfDay: "04:30",
        actionKey: "cache.refresh",
    });

    const updated = upsertScheduledJob({
        id: "cache.daily",
        name: "Daily cache renamed",
        scheduleType: "daily",
        actionKey: "cache.refresh",
    });

    assert.equal(updated.timeOfDay, "04:30");
});

test("creates and updates cron jobs", () => {
    const job = upsertScheduledJob({
        id: "cache.cron",
        name: "Cron cache",
        enabled: true,
        scheduleType: "cron",
        cronExpression: "*/5 * * * *",
        actionKey: "cache.refresh",
    });

    assert.equal(job.scheduleType, "cron");
    assert.equal(job.cronExpression, "*/5 * * * *");
    assert.ok(job.nextRunAt);

    const updated = updateScheduledJob("cache.cron", {
        cronExpression: "0 4 * * 1",
    });

    assert.equal(updated?.cronExpression, "0 4 * * 1");
});

test("records failures and rejects missing or unregistered jobs", async () => {
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });

    await assert.rejects(runScheduledJob("missing"), /Scheduled job not found/u);
    await assert.rejects(
        runScheduledJob("cache.weather"),
        /No scheduled job action registered/u
    );

    registerScheduledJobAction("cache.refresh", () => {
        throw new Error("refresh failed");
    });
    const run = await runScheduledJob("cache.weather");
    assert.equal(run.status, "failed");
    assert.equal(run.message, "refresh failed");
});

test("rejects concurrent runs for the same job", async () => {
    let releaseHandler: () => void = () => {};
    registerScheduledJobAction(
        "cache.refresh",
        () =>
            new Promise<void>((resolve) => {
                releaseHandler = resolve;
            })
    );
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });

    const firstRun = runScheduledJob("cache.weather");
    await assert.rejects(runScheduledJob("cache.weather"), /already running/u);
    releaseHandler();
    await firstRun;
});

test("runs due enabled jobs once per scheduler tick", async () => {
    const calls: string[] = [];
    registerScheduledJobAction("cache.refresh", (job) => {
        calls.push(job.id);
    });
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2026-01-01T00:00:00.000Z",
        "cache.weather"
    );

    await __testing.runDueJobsForTest();

    assert.deepEqual(calls, ["cache.weather"]);
    assert.equal(getScheduledJob("cache.weather")?.lastRun?.triggerType, "schedule");
});

test("keeps due jobs isolated when one persisted job is invalid", async () => {
    const calls: string[] = [];
    registerScheduledJobAction("cache.refresh", (job) => {
        calls.push(job.id);
    });
    upsertScheduledJob({
        id: "cache.invalid",
        name: "Invalid cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.missing",
    });
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ?").run(
        "2026-01-01T00:00:00.000Z"
    );

    await __testing.runDueJobsForTest();

    assert.deepEqual(calls, ["cache.weather"]);
    assert.equal(getScheduledJob("cache.invalid")?.lastRun?.status, "failed");
    assert.notEqual(
        getScheduledJob("cache.invalid")?.nextRunAt,
        "2026-01-01T00:00:00.000Z"
    );
});

test("continues due job loop after a row disappears", async (t) => {
    const calls: string[] = [];
    registerScheduledJobAction("cache.refresh", (job) => {
        calls.push(job.id);
    });
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2026-01-01T00:00:00.000Z",
        "cache.weather"
    );
    const prepare = db.prepare.bind(db);
    const prepareMock = t.mock.method(db, "prepare", (sql: string) => {
        if (sql.includes("SELECT id FROM scheduled_jobs")) {
            return {
                all: () => [{ id: "cache.missing" }, { id: "cache.weather" }],
            } as unknown as ReturnType<typeof db.prepare>;
        }
        return prepare(sql);
    });

    try {
        await __testing.runDueJobsForTest();
    } finally {
        prepareMock.mock.restore();
    }

    assert.deepEqual(calls, ["cache.weather"]);
});

test("rechecks due job state before scheduled execution", async () => {
    const calls: string[] = [];
    registerScheduledJobAction("cache.refresh", (job) => {
        calls.push(job.id);
        if (job.id === "cache.first") {
            updateScheduledJob("cache.second", { enabled: false });
        }
    });
    for (const id of ["cache.first", "cache.second"]) {
        upsertScheduledJob({
            id,
            name: id,
            enabled: true,
            scheduleType: "interval",
            intervalSeconds: 120,
            actionKey: "cache.refresh",
        });
    }
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ?").run(
        "2026-01-01T00:00:00.000Z"
    );

    await __testing.runDueJobsForTest();

    assert.deepEqual(calls, ["cache.first"]);
    assert.equal(getScheduledJob("cache.second")?.lastRun, null);
});

test("continues due job loop after one scheduled run throws", async (t) => {
    const calls: string[] = [];
    registerScheduledJobAction("cache.refresh", (job) => {
        calls.push(job.id);
    });
    for (const id of ["cache.first", "cache.second"]) {
        upsertScheduledJob({
            id,
            name: id,
            enabled: true,
            scheduleType: "interval",
            intervalSeconds: 120,
            actionKey: "cache.refresh",
        });
    }
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ?").run(
        "2026-01-01T00:00:00.000Z"
    );
    const prepare = db.prepare.bind(db);
    let insertFailures = 0;
    const prepareMock = t.mock.method(db, "prepare", (sql: string) => {
        if (sql.includes("INSERT INTO scheduled_job_runs") && insertFailures === 0) {
            insertFailures += 1;
            return {
                run: () => {
                    throw new Error("run insert failed");
                },
            } as unknown as ReturnType<typeof db.prepare>;
        }
        return prepare(sql);
    });

    try {
        await __testing.runDueJobsForTest();
    } finally {
        prepareMock.mock.restore();
    }

    assert.deepEqual(calls, ["cache.second"]);
});

test("logs scheduler tick query failures without leaving ticks stuck", async (t) => {
    const prepare = db.prepare.bind(db);
    const warnMock = t.mock.method(console, "warn", () => {});
    const prepareMock = t.mock.method(db, "prepare", (sql: string) => {
        if (sql.includes("SELECT id FROM scheduled_jobs")) {
            throw new Error("database locked");
        }
        return prepare(sql);
    });

    try {
        __testing.runSchedulerTickForTest();
        await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
        prepareMock.mock.restore();
        warnMock.mock.restore();
    }

    assert.equal(warnMock.mock.callCount(), 1);
    __testing.runSchedulerTickForTest();
});

test("advances failed scheduled runs without moving manual schedules", async () => {
    registerScheduledJobAction("cache.refresh", () => {
        throw new Error("refresh failed");
    });
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2026-01-01T00:00:00.000Z",
        "cache.weather"
    );

    const manualRun = await runScheduledJob("cache.weather", "manual");
    assert.equal(manualRun.status, "failed");
    assert.equal(getScheduledJob("cache.weather")?.nextRunAt, "2026-01-01T00:00:00.000Z");

    const scheduledRun = await runScheduledJob("cache.weather", "schedule");
    assert.equal(scheduledRun.status, "failed");
    assert.notEqual(
        getScheduledJob("cache.weather")?.nextRunAt,
        "2026-01-01T00:00:00.000Z"
    );
});

test("preserves no-op patch due times and uses fresh schedule after running", async () => {
    let releaseHandler: () => void = () => {};
    registerScheduledJobAction(
        "cache.refresh",
        () =>
            new Promise<void>((resolve) => {
                releaseHandler = resolve;
            })
    );
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2026-01-01T00:00:00.000Z",
        "cache.weather"
    );

    const noOp = updateScheduledJob("cache.weather", {});
    assert.equal(noOp?.nextRunAt, "2026-01-01T00:00:00.000Z");

    const scheduledRun = runScheduledJob("cache.weather", "schedule");
    const updated = updateScheduledJob("cache.weather", { intervalSeconds: 3600 });
    assert.ok(updated?.nextRunAt);
    releaseHandler();
    await scheduledRun;

    const nextRunAt = getScheduledJob("cache.weather")?.nextRunAt;
    assert.ok(nextRunAt);
    assert.ok(new Date(nextRunAt).getTime() - Date.now() > 3_000_000);
});

test("does not advance schedule when a running job is deleted", async () => {
    let releaseHandler: () => void = () => {};
    registerScheduledJobAction(
        "cache.refresh",
        () =>
            new Promise<void>((resolve) => {
                releaseHandler = resolve;
            })
    );
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });

    const scheduledRun = runScheduledJob("cache.weather", "schedule");
    db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run("cache.weather");
    releaseHandler();

    const run = await scheduledRun;
    assert.equal(run.status, "success");
    assert.equal(getScheduledJob("cache.weather"), null);
});

test("skips due jobs that are already running", async () => {
    let releaseHandler: () => void = () => {};
    const calls: string[] = [];
    registerScheduledJobAction(
        "cache.refresh",
        (job) =>
            new Promise<void>((resolve) => {
                calls.push(job.id);
                releaseHandler = resolve;
            })
    );
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2026-01-01T00:00:00.000Z",
        "cache.weather"
    );

    const firstRun = runScheduledJob("cache.weather", "schedule");
    await __testing.runDueJobsForTest();
    assert.deepEqual(calls, ["cache.weather"]);

    releaseHandler();
    await firstRun;
});

test("ignores overlapping scheduler ticks", async () => {
    let releaseHandler: () => void = () => {};
    const calls: string[] = [];
    registerScheduledJobAction(
        "cache.refresh",
        (job) =>
            new Promise<void>((resolve) => {
                calls.push(job.id);
                releaseHandler = resolve;
            })
    );
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2026-01-01T00:00:00.000Z",
        "cache.weather"
    );

    // Verify overlapping-tick deduplication: runSchedulerTickForTest() ignores
    // the second tick while the first one is still appending to calls.
    __testing.runSchedulerTickForTest();
    __testing.runSchedulerTickForTest();
    assert.deepEqual(calls, ["cache.weather"]);

    releaseHandler();
    await new Promise<void>((resolve) => setImmediate(resolve));
});

test("validates schedule definitions and exposes idempotent scheduler controls", () => {
    assert.throws(() => registerScheduledJobAction("Bad Key", () => {}), /action key/u);
    assert.throws(
        () =>
            upsertScheduledJob({
                id: "bad id",
                name: "Bad",
                scheduleType: "interval",
                intervalSeconds: 120,
                actionKey: "cache.refresh",
            }),
        /Job id is invalid/u
    );
    assert.throws(
        () =>
            upsertScheduledJob({
                id: "cache.weather",
                name: "Weather cache",
                scheduleType: "interval",
                intervalSeconds: 10,
                actionKey: "cache.refresh",
            }),
        /Interval must be at least/u
    );
    assert.throws(
        () =>
            upsertScheduledJob({
                id: "cache.weather",
                name: "Weather cache",
                scheduleType: "daily",
                actionKey: "cache.refresh",
            }),
        /Daily jobs require/u
    );
    assert.throws(
        () =>
            upsertScheduledJob({
                id: "cache.weather",
                name: "Weather cache",
                scheduleType: "cron",
                actionKey: "cache.refresh",
            }),
        /Cron jobs require/u
    );
    assert.throws(
        () =>
            upsertScheduledJob({
                id: "cache.weather",
                name: "Weather cache",
                scheduleType: "cron",
                cronExpression: "60 * * * *",
                actionKey: "cache.refresh",
            }),
        /Cron jobs require/u
    );
    for (const cronExpression of [
        "",
        "* * * *",
        "* * * * * *",
        "1,,2 * * * *",
        "*/0 * * * *",
        "*/5/2 * * * *",
        "1-2-3 * * * *",
        "60/2 * * * *",
    ]) {
        assert.throws(
            () =>
                upsertScheduledJob({
                    id: "cache.weather",
                    name: "Weather cache",
                    scheduleType: "cron",
                    cronExpression,
                    actionKey: "cache.refresh",
                }),
            /Cron jobs require/u
        );
    }
    assert.throws(
        () =>
            upsertScheduledJob({
                id: "cache.weather",
                name: "Weather cache",
                scheduleType: "daily",
                timeOfDay: "25:00",
                actionKey: "cache.refresh",
            }),
        /Daily jobs require/u
    );
    assert.throws(
        () =>
            upsertScheduledJob({
                id: "cache.weather",
                name: "Weather cache",
                scheduleType: "interval",
                intervalSeconds: 120,
                actionKey: "Bad Key",
            }),
        /action key/u
    );

    startScheduledJobScheduler();
    startScheduledJobScheduler();
    stopScheduledJobScheduler();
    stopScheduledJobScheduler();
});
