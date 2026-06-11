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
        "2026-06-11T10:30:00.000Z"
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
        "2026-06-12T09:30:00.000Z"
    );
    assert.equal(
        calculateNextRunAt(
            {
                enabled: true,
                intervalSeconds: 3600,
                scheduleType: "daily",
                timeOfDay: null,
            },
            from
        ),
        "2026-06-11T11:00:00.000Z"
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
    assert.equal(__testing.mapRunForTest(), null);
});

test("keeps existing schedule defaults when upserting existing jobs", () => {
    const initial = upsertScheduledJob({
        id: "cache.weather",
        name: "Weather cache",
        enabled: true,
        scheduleType: "interval",
        intervalSeconds: 120,
        actionKey: "cache.refresh",
    });

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
    assert.equal(disabled.enabled, false);
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
