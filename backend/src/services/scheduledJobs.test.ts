import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
const tempDbDir = mkdtempSync(path.join(os.tmpdir(), "scheduled-jobs-test-"));
process.env.MIRA_DASHBOARD_DB_PATH = path.join(tempDbDir, "mira-dashboard.db");

const { db } = await import("../db.js");
const {
    __testing,
    calculateNextRunAt,
    createManualScheduledJobRun,
    finishScheduledJobRun,
    getScheduledJob,
    listScheduledJobs,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    runScheduledJob,
    startScheduledJobScheduler,
    stopScheduledJobScheduler,
    updateScheduledJob,
    upsertScheduledJob,
} = await import("./scheduledJobs.js");

test.after(() => {
    db.close();
    if (originalDbPath === undefined) {
        delete process.env.MIRA_DASHBOARD_DB_PATH;
    } else {
        process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
    }
    rmSync(tempDbDir, { recursive: true, force: true });
});

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

test("removes scheduled jobs for an action that are no longer registered", () => {
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });
    upsertScheduledJob({
        id: "cache.legacy",
        name: "Legacy cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });
    upsertScheduledJob({
        id: "backup.walg",
        name: "WAL-G backup",
        enabled: true,
        scheduleType: "daily",
        timeOfDay: "03:20",
        actionKey: "backup.run",
    });

    removeScheduledJobsNotInAction("cache.refresh", ["cache.weather"]);

    assert.ok(getScheduledJob("cache.weather"));
    assert.equal(getScheduledJob("cache.legacy"), null);
    assert.ok(getScheduledJob("backup.walg"));

    removeScheduledJobsNotInAction("cache.refresh", []);

    assert.equal(getScheduledJob("cache.weather"), null);
    assert.ok(getScheduledJob("backup.walg"));
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
    assert.equal(
        calculateNextRunAt(
            {
                cronExpression: "0 9 */1 * 1",
                enabled: true,
                intervalSeconds: 3600,
                scheduleType: "cron",
                timeOfDay: null,
            },
            new Date("2026-06-09T09:00:00.000Z")
        ),
        "2026-06-15T09:00:00.000Z"
    );
    assert.equal(
        calculateNextRunAt(
            {
                cronExpression: "0 9 1-31 * 1",
                enabled: true,
                intervalSeconds: 3600,
                scheduleType: "cron",
                timeOfDay: null,
            },
            new Date("2026-06-09T09:00:00.000Z")
        ),
        "2026-06-15T09:00:00.000Z"
    );
    assert.equal(
        calculateNextRunAt(
            {
                cronExpression: "0 9 1 * 0-7",
                enabled: true,
                intervalSeconds: 3600,
                scheduleType: "cron",
                timeOfDay: null,
            },
            new Date("2026-06-09T09:00:00.000Z")
        ),
        "2026-07-01T09:00:00.000Z"
    );
    assert.equal(
        calculateNextRunAt(
            {
                cronExpression: "0 9 */2 * 1",
                enabled: true,
                intervalSeconds: 3600,
                scheduleType: "cron",
                timeOfDay: null,
            },
            new Date("2026-06-09T09:00:00.000Z")
        ),
        "2026-06-11T09:00:00.000Z"
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

test("cascades scheduled job runs when deleting jobs", async () => {
    registerScheduledJobAction("cache.refresh", () => ({}));
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });

    await runScheduledJob("cache.weather", "manual");
    assert.equal(
        (
            db.prepare("SELECT COUNT(*) AS count FROM scheduled_job_runs").get() as {
                count: number;
            }
        ).count,
        1
    );

    db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run("cache.weather");
    assert.equal(
        (
            db.prepare("SELECT COUNT(*) AS count FROM scheduled_job_runs").get() as {
                count: number;
            }
        ).count,
        0
    );
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
    const refreshed = upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache refreshed",
        actionKey: "cache.refresh",
    } as Parameters<typeof upsertScheduledJob>[0]);
    assert.equal(refreshed.scheduleType, "interval");
    assert.equal(refreshed.nextRunAt, "2026-01-01T00:00:00.000Z");
    assert.equal(disabled.enabled, false);
});

test("applies provided schedule values when upserting jobs", () => {
    upsertScheduledJob({
        id: "cache.daily",
        name: "Daily cache",
        enabled: true,
        scheduleType: "daily",
        timeOfDay: "04:30",
        actionKey: "cache.refresh",
    });
    const patched = updateScheduledJob("cache.daily", {
        enabled: false,
        timeOfDay: "06:45",
    });
    assert.equal(patched?.enabled, false);
    assert.equal(patched?.timeOfDay, "06:45");

    const updated = upsertScheduledJob({
        id: "cache.daily",
        name: "Daily cache renamed",
        enabled: true,
        scheduleType: "daily",
        timeOfDay: "04:30",
        actionKey: "cache.refresh",
    });

    assert.equal(updated.enabled, true);
    assert.equal(updated.timeOfDay, "04:30");
    assert.ok(updated.nextRunAt);
});

test("clears nullable schedule values when upserting explicit nulls", () => {
    upsertScheduledJob({
        id: "cache.daily",
        name: "Daily cache",
        enabled: true,
        scheduleType: "daily",
        timeOfDay: "04:30",
        actionKey: "cache.refresh",
    });
    const intervalJob = upsertScheduledJob({
        id: "cache.daily",
        name: "Interval cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        timeOfDay: null,
        actionKey: "cache.refresh",
    });

    assert.equal(intervalJob.scheduleType, "interval");
    assert.equal(intervalJob.timeOfDay, null);

    upsertScheduledJob({
        id: "cache.cron",
        name: "Cron cache",
        enabled: true,
        scheduleType: "cron",
        cronExpression: "*/5 * * * *",
        actionKey: "cache.refresh",
    });
    const dailyJob = upsertScheduledJob({
        id: "cache.cron",
        name: "Daily cache",
        enabled: true,
        scheduleType: "daily",
        timeOfDay: "05:00",
        cronExpression: null,
        actionKey: "cache.refresh",
    });

    assert.equal(dailyJob.scheduleType, "daily");
    assert.equal(dailyJob.cronExpression, null);
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

test("does not mark handler success failed when success persistence fails", async (t) => {
    const warnMock = t.mock.method(console, "warn", () => {});
    registerScheduledJobAction("cache.refresh", () => ({ ok: true }));
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });
    const prepare = db.prepare.bind(db);
    const prepareMock = t.mock.method(db, "prepare", (sql: string) => {
        const statement = prepare(sql);
        if (sql.includes("UPDATE scheduled_job_runs")) {
            const runStatement = statement.run.bind(statement) as (
                ...args: unknown[]
            ) => unknown;
            return {
                run: (...args: unknown[]) => {
                    if (args[0] === "success") {
                        throw new Error("success write failed");
                    }
                    return runStatement(...args);
                },
            } as unknown as ReturnType<typeof db.prepare>;
        }
        return statement;
    });

    try {
        const run = await runScheduledJob("cache.weather");

        assert.equal(run.status, "success");
        assert.equal(run.message, "success write failed");
        assert.deepEqual(run.output, { ok: true });
        assert.equal(warnMock.mock.callCount(), 1);
    } finally {
        prepareMock.mock.restore();
        warnMock.mock.restore();
    }
});

test("reports handler failures even when failure persistence fails", async (t) => {
    const warnMock = t.mock.method(console, "warn", () => {});
    registerScheduledJobAction("cache.refresh", () => {
        throw new Error("handler failed");
    });
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });
    const prepare = db.prepare.bind(db);
    const prepareMock = t.mock.method(db, "prepare", (sql: string) => {
        const statement = prepare(sql);
        if (sql.includes("UPDATE scheduled_job_runs")) {
            return {
                run: () => {
                    throw new Error("failed write failed");
                },
            } as unknown as ReturnType<typeof db.prepare>;
        }
        return statement;
    });

    try {
        const run = await runScheduledJob("cache.weather");

        assert.equal(run.status, "failed");
        assert.equal(run.message, "failed write failed");
        assert.equal(warnMock.mock.callCount(), 1);
    } finally {
        prepareMock.mock.restore();
        warnMock.mock.restore();
    }
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

test("starts independent due jobs without waiting for long-running handlers", async () => {
    const calls: string[] = [];
    let releaseSlowJob!: () => void;
    const slowJob = new Promise<void>((resolve) => {
        releaseSlowJob = resolve;
    });
    registerScheduledJobAction("cache.refresh", async (job) => {
        calls.push(job.id);
        if (job.id === "cache.a-slow") {
            await slowJob;
        }
    });
    for (const id of ["cache.a-slow", "cache.b-fast"]) {
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

    const dueJobs = __testing.runDueJobsForTest();
    await delay(0);

    assert.deepEqual(calls, ["cache.a-slow", "cache.b-fast"]);
    releaseSlowJob();
    await dueJobs;
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

test("continues due job loop after a job lookup throws", async (t) => {
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
    let jobLookupCalls = 0;
    const prepareMock = t.mock.method(db, "prepare", (sql: string) => {
        if (sql.includes("SELECT id FROM scheduled_jobs")) {
            return {
                all: () => [{ id: "cache.broken" }, { id: "cache.weather" }],
            } as unknown as ReturnType<typeof db.prepare>;
        }
        if (sql.includes("SELECT * FROM scheduled_jobs WHERE id = ?")) {
            const statement = prepare(sql);
            return {
                get: (...args: Parameters<typeof statement.get>) => {
                    jobLookupCalls += 1;
                    if (jobLookupCalls === 1) {
                        throw new Error("lookup failed");
                    }
                    return statement.get(...args);
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
    const warnMock = t.mock.method(console, "warn", () => {});
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
                    throw Object.assign(new Error("run insert failed"), {
                        statusCode: 500,
                    });
                },
            } as unknown as ReturnType<typeof db.prepare>;
        }
        return prepare(sql);
    });

    try {
        await __testing.runDueJobsForTest();
    } finally {
        prepareMock.mock.restore();
        warnMock.mock.restore();
    }

    assert.deepEqual(calls, ["cache.second"]);
    assert.equal(warnMock.mock.callCount(), 1);
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

test("releases scheduler ticks while a scheduled handler is stalled", async (t) => {
    const calls: string[] = [];
    const releaseStalledJobs: Array<() => void> = [];
    let aborts = 0;
    const warnMock = t.mock.method(console, "warn", () => {});
    try {
        __testing.setScheduledJobRunTimeoutMsForTest(100);
        registerScheduledJobAction(
            "cache.refresh",
            (job, signal) =>
                new Promise<void>((resolve) => {
                    calls.push(job.id);
                    signal?.addEventListener("abort", () => {
                        aborts += 1;
                    });
                    if (job.id === "cache.fast") {
                        resolve();
                        return;
                    }
                    releaseStalledJobs.push(resolve);
                })
        );
        upsertScheduledJob({
            id: "cache.stalled",
            name: "Stalled cache",
            enabled: true,
            scheduleType: "interval",
            intervalSeconds: 120,
            actionKey: "cache.refresh",
        });
        db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
            "2026-01-01T00:00:00.000Z",
            "cache.stalled"
        );

        __testing.runSchedulerTickForTest();
        await delay(0);
        upsertScheduledJob({
            id: "cache.fast",
            name: "Fast cache",
            enabled: true,
            scheduleType: "interval",
            intervalSeconds: 120,
            actionKey: "cache.refresh",
        });
        db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
            "2026-01-01T00:00:00.000Z",
            "cache.fast"
        );
        __testing.runSchedulerTickForTest();
        await delay(0);

        assert.deepEqual(calls, ["cache.stalled", "cache.fast"]);
        await delay(120);
        assert.equal(warnMock.mock.callCount(), 1);
        assert.equal(aborts, 1);
        assert.equal(getScheduledJob("cache.stalled")?.lastRun?.status, "failed");
        assert.equal(getScheduledJob("cache.stalled")?.isRunning, false);
        db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
            "2026-01-01T00:00:00.000Z",
            "cache.stalled"
        );
        __testing.runSchedulerTickForTest();
        await delay(0);
        assert.deepEqual(calls, ["cache.stalled", "cache.fast", "cache.stalled"]);
        for (const releaseStalledJob of releaseStalledJobs) {
            releaseStalledJob();
        }
        await delay(0);
        assert.equal(getScheduledJob("cache.stalled")?.isRunning, false);
    } finally {
        for (const releaseStalledJob of releaseStalledJobs) {
            releaseStalledJob();
        }
        warnMock.mock.restore();
    }
});

test("uses registered action timeout for scheduled runs", async (t) => {
    const warnMock = t.mock.method(console, "warn", () => {});
    try {
        __testing.setScheduledJobRunTimeoutMsForTest(25);
        let aborted = false;
        registerScheduledJobAction(
            "backup.run",
            (_job, signal) =>
                new Promise<void>((resolve) => {
                    signal?.addEventListener("abort", () => {
                        aborted = true;
                    });
                    setTimeout(resolve, 60);
                }),
            { timeoutMs: 250 }
        );
        upsertScheduledJob({
            id: "backup.walg",
            name: "WAL-G backup",
            enabled: true,
            scheduleType: "daily",
            timeOfDay: "03:20",
            actionKey: "backup.run",
        });
        db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
            "2026-01-01T00:00:00.000Z",
            "backup.walg"
        );

        await __testing.runDueJobsForTest();

        assert.equal(aborted, false);
        assert.equal(warnMock.mock.callCount(), 0);
        assert.equal(getScheduledJob("backup.walg")?.lastRun?.status, "success");
    } finally {
        warnMock.mock.restore();
    }
});

test("uses registered action timeout for manual runs", async (t) => {
    const warnMock = t.mock.method(console, "warn", () => {});
    try {
        __testing.setScheduledJobRunTimeoutMsForTest(25);
        let aborted = false;
        registerScheduledJobAction(
            "backup.run",
            (_job, signal) =>
                new Promise<void>((resolve) => {
                    signal?.addEventListener("abort", () => {
                        aborted = true;
                    });
                    setTimeout(resolve, 60);
                }),
            { timeoutMs: 250 }
        );
        upsertScheduledJob({
            id: "backup.walg",
            name: "WAL-G backup",
            enabled: true,
            scheduleType: "daily",
            timeOfDay: "03:20",
            actionKey: "backup.run",
        });

        const run = await runScheduledJob("backup.walg", "manual");

        assert.equal(aborted, false);
        assert.equal(warnMock.mock.callCount(), 0);
        assert.equal(run.status, "success");
    } finally {
        warnMock.mock.restore();
    }
});

test("stops manual runs when caller signal aborts", async () => {
    let aborted = false;
    let releaseHandler: () => void = () => {};
    registerScheduledJobAction(
        "cache.refresh",
        (_job, signal) =>
            new Promise<void>((resolve) => {
                releaseHandler = resolve;
                signal?.addEventListener("abort", () => {
                    aborted = true;
                });
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

    const controller = new AbortController();
    const runPromise = runScheduledJob("cache.weather", "manual", controller.signal);
    await delay(0);
    controller.abort();

    const pendingResult = await Promise.race([
        runPromise,
        delay(50).then(() => "pending" as const),
    ]);

    assert.equal(pendingResult, "pending");
    assert.equal(aborted, true);
    assert.equal(getScheduledJob("cache.weather")?.isRunning, true);
    await assert.rejects(runScheduledJob("cache.weather", "manual"), /already running/u);

    releaseHandler();
    const result = await runPromise;
    assert.equal(result.status, "failed");
    assert.match(result.message ?? "", /aborted/u);
    assert.equal(getScheduledJob("cache.weather")?.isRunning, false);
});

test("tracks externally managed manual runs as active jobs", async () => {
    registerScheduledJobAction("backup.run", () => ({ ok: true }));
    upsertScheduledJob({
        id: "backup.walg",
        name: "WAL-G backup",
        enabled: true,
        scheduleType: "daily",
        timeOfDay: "03:20",
        actionKey: "backup.run",
    });

    const externalRun = createManualScheduledJobRun("backup.walg");

    assert.equal(getScheduledJob("backup.walg")?.isRunning, true);
    assert.throws(
        () => createManualScheduledJobRun("backup.walg"),
        /Scheduled job is already running/u
    );
    await assert.rejects(
        runScheduledJob("backup.walg", "manual"),
        /Scheduled job is already running/u
    );

    finishScheduledJobRun(externalRun, "success", null, { ok: true });

    assert.equal(getScheduledJob("backup.walg")?.isRunning, false);
    const nextRun = await runScheduledJob("backup.walg", "manual");
    assert.equal(nextRun.status, "success");
});

test("releases active tracking when externally managed manual run creation fails", async (t) => {
    upsertScheduledJob({
        id: "backup.walg",
        name: "WAL-G backup",
        enabled: true,
        scheduleType: "daily",
        timeOfDay: "03:20",
        actionKey: "backup.run",
    });
    const prepare = db.prepare.bind(db);
    t.mock.method(db, "prepare", (sql: string) => {
        if (sql.includes("INSERT INTO scheduled_job_runs")) {
            throw new Error("insert failed");
        }
        return prepare(sql);
    });

    assert.throws(() => createManualScheduledJobRun("backup.walg"), /insert failed/u);
    assert.equal(getScheduledJob("backup.walg")?.isRunning, false);
});

test("logs timeout persistence failures while releasing stalled jobs", async (t) => {
    let releaseHandler: () => void = () => {};
    const warnMock = t.mock.method(console, "warn", () => {});
    const prepare = db.prepare.bind(db);
    const prepareMock = t.mock.method(db, "prepare", (sql: string) => {
        if (sql.includes("UPDATE scheduled_job_runs")) {
            throw new Error("timeout write failed");
        }
        return prepare(sql);
    });
    try {
        __testing.setScheduledJobRunTimeoutMsForTest(100);
        registerScheduledJobAction(
            "cache.refresh",
            () =>
                new Promise<void>((resolve) => {
                    releaseHandler = resolve;
                })
        );
        upsertScheduledJob({
            id: "cache.stalled",
            name: "Stalled cache",
            enabled: true,
            scheduleType: "interval",
            intervalSeconds: 120,
            actionKey: "cache.refresh",
        });
        db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
            "2026-01-01T00:00:00.000Z",
            "cache.stalled"
        );

        __testing.runSchedulerTickForTest();
        await delay(120);

        assert.equal(warnMock.mock.callCount(), 2);
        assert.equal(getScheduledJob("cache.stalled")?.isRunning, false);
    } finally {
        releaseHandler();
        await delay(0);
        assert.equal(getScheduledJob("cache.stalled")?.isRunning, false);
        prepareMock.mock.restore();
        warnMock.mock.restore();
        await delay(0);
    }
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

test("does not run handlers when scheduled claim fails", async (t) => {
    let handlerCalled = false;
    registerScheduledJobAction("cache.refresh", () => {
        handlerCalled = true;
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
        if (sql.includes("UPDATE scheduled_jobs")) {
            return {
                run: () => {
                    throw new Error("claim failed");
                },
            } as unknown as ReturnType<typeof db.prepare>;
        }
        return prepare(sql);
    });

    try {
        await assert.rejects(
            runScheduledJob("cache.weather", "schedule"),
            /claim failed/u
        );
    } finally {
        prepareMock.mock.restore();
    }

    assert.equal(handlerCalled, false);
    await runScheduledJob("cache.weather", "manual");
    assert.equal(getScheduledJob("cache.weather")?.isRunning, false);
});

test("rejects scheduled runs that are not due", async () => {
    let handlerCalled = false;
    registerScheduledJobAction("cache.refresh", () => {
        handlerCalled = true;
    });
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });

    await assert.rejects(
        runScheduledJob("cache.weather", "schedule"),
        /Scheduled job is no longer due/u
    );
    assert.equal(handlerCalled, false);
});

test("rejects scheduled runs when another worker claims the due job", async (t) => {
    let handlerCalled = false;
    registerScheduledJobAction("cache.refresh", () => {
        handlerCalled = true;
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
        if (sql.includes("UPDATE scheduled_jobs")) {
            return {
                run: () => ({ changes: 0 }),
            } as unknown as ReturnType<typeof db.prepare>;
        }
        return prepare(sql);
    });

    try {
        await assert.rejects(
            runScheduledJob("cache.weather", "schedule"),
            /Scheduled job is no longer due/u
        );
    } finally {
        prepareMock.mock.restore();
    }
    assert.equal(handlerCalled, false);
});

test("preserves scheduled claim errors when rollback also fails", async (t) => {
    registerScheduledJobAction("cache.refresh", () => ({}));
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
    const exec = db.exec.bind(db);
    const prepare = db.prepare.bind(db);
    const execMock = t.mock.method(db, "exec", (sql: string) => {
        if (sql === "BEGIN IMMEDIATE") {
            return;
        }
        if (sql === "ROLLBACK") {
            throw new Error("rollback failed");
        }
        return exec(sql);
    });
    const prepareMock = t.mock.method(db, "prepare", (sql: string) => {
        if (sql.includes("UPDATE scheduled_jobs")) {
            return {
                run: () => {
                    throw new Error("claim failed");
                },
            } as unknown as ReturnType<typeof db.prepare>;
        }
        return prepare(sql);
    });

    try {
        await assert.rejects(
            runScheduledJob("cache.weather", "schedule"),
            /claim failed/u
        );
    } finally {
        prepareMock.mock.restore();
        execMock.mock.restore();
    }
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
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2026-01-01T00:00:00.000Z",
        "cache.weather"
    );

    const scheduledRun = runScheduledJob("cache.weather", "schedule");
    db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run("cache.weather");
    releaseHandler();

    const run = await scheduledRun;
    assert.equal(run.status, "success");
    assert.equal(getScheduledJob("cache.weather"), null);
});

test("marks orphaned running rows failed when the scheduler starts", () => {
    upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });
    db.prepare(
        `INSERT INTO scheduled_job_runs (
            job_id, status, trigger_type, started_at, output_json
        ) VALUES (?, 'running', 'schedule', ?, '{}')`
    ).run("cache.weather", "2026-01-01T00:00:00.000Z");

    startScheduledJobScheduler();
    stopScheduledJobScheduler();

    const lastRun = getScheduledJob("cache.weather")?.lastRun;
    assert.equal(lastRun?.status, "failed");
    assert.equal(lastRun?.message, "Scheduled job abandoned after backend restart");
    assert.ok(lastRun?.finishedAt);
});

test("continues scheduler startup when abandoned-run cleanup fails", (t) => {
    const prepare = db.prepare.bind(db);
    const warnMock = t.mock.method(console, "warn", () => {});
    const prepareMock = t.mock.method(db, "prepare", (sql: string) => {
        if (sql.includes("UPDATE scheduled_job_runs")) {
            throw new Error("cleanup locked");
        }
        return prepare(sql);
    });

    try {
        assert.doesNotThrow(() => startScheduledJobScheduler());
        assert.equal(warnMock.mock.callCount(), 1);
    } finally {
        stopScheduledJobScheduler();
        prepareMock.mock.restore();
        warnMock.mock.restore();
    }
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
    for (const timeoutMs of [
        0,
        0.5,
        -1,
        2_147_483_648,
        Number.NaN,
        Number.POSITIVE_INFINITY,
    ]) {
        assert.throws(
            () => registerScheduledJobAction("cache.refresh", () => {}, { timeoutMs }),
            /timeout must be an integer between 1 and 2147483647/u
        );
    }
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
