import assert from "node:assert/strict";
import test from "node:test";

import { db } from "../db.js";
import {
    __testing,
    getScheduledJob,
    listScheduledJobs,
    runScheduledJob,
    startScheduledJobScheduler,
    stopScheduledJobScheduler,
    updateScheduledJob,
} from "./scheduledJobs.js";

test.beforeEach(() => {
    db.exec("DELETE FROM scheduled_job_runs; DELETE FROM scheduled_jobs;");
    __testing.setActionExecutorForTests(undefined);
    __testing.setActionRunnersForTests(undefined);
});

test.afterEach(() => {
    __testing.setActionExecutorForTests(undefined);
    __testing.setActionRunnersForTests(undefined);
});

test("creates built-in jobs with interval and precise daily schedules", () => {
    const jobs = listScheduledJobs();
    const dockerUpdater = jobs.find((job) => job.id === "docker.updater");
    const moltbook = jobs.find((job) => job.id === "cache.moltbook");
    const oldMoltbookHome = jobs.find((job) => job.id === "cache.moltbook-home");
    const system = jobs.find((job) => job.id === "cache.system");
    const weather = jobs.find((job) => job.id === "cache.weather");
    const backupKopia = jobs.find((job) => job.id === "cache.backup-kopia");
    const backupWalg = jobs.find((job) => job.id === "cache.backup-walg");
    const openClawNotifications = jobs.find((job) => job.id === "notification.openclaw");
    const quotaNotifications = jobs.find((job) => job.id === "notification.quotas");

    assert.ok(jobs.length >= __testing.defaultJobs.length);
    assert.equal(dockerUpdater?.actionType, "docker.updater");
    assert.equal(dockerUpdater?.scheduleType, "daily");
    assert.equal(dockerUpdater?.timeOfDay, "04:00");
    assert.equal(moltbook?.actionType, "cache.refreshMany");
    assert.deepEqual(moltbook?.settings.keys, [
        "moltbook.home",
        "moltbook.feed.hot",
        "moltbook.feed.new",
        "moltbook.profile",
        "moltbook.my-content",
    ]);
    assert.equal(oldMoltbookHome, undefined);
    assert.equal(system?.scheduleType, "daily");
    assert.equal(system?.timeOfDay, "02:50");
    assert.equal(weather?.scheduleType, "interval");
    assert.equal(weather?.timeOfDay, null);
    assert.equal(backupKopia?.actionTarget, "backup.kopia.status");
    assert.equal(backupKopia?.timeOfDay, "03:05");
    assert.equal(backupWalg?.actionTarget, "backup.walg.status");
    assert.equal(backupWalg?.timeOfDay, "03:10");
    assert.equal(openClawNotifications?.intervalSeconds, 60 * 60);
    assert.equal(quotaNotifications?.intervalSeconds, 15 * 60);
});

test("computes next daily run for today or tomorrow", () => {
    assert.equal(
        __testing.nextDailyRunIso("02:40", new Date("2026-06-05T00:00:00.000Z")),
        "2026-06-05T00:40:00.000Z"
    );
    assert.equal(
        __testing.nextDailyRunIso("02:40", new Date("2026-06-05T03:00:00.000Z")),
        "2026-06-06T00:40:00.000Z"
    );
    assert.throws(() => __testing.nextDailyRunIso("25:00"), /HH:mm/u);
});

test("updates enable state, interval schedules, and daily schedules", () => {
    const disabled = updateScheduledJob("cache.weather", {
        enabled: false,
        intervalSeconds: 3600,
    });
    assert.equal(disabled?.enabled, false);

    const daily = updateScheduledJob("cache.weather", {
        enabled: true,
        scheduleType: "daily",
        timeOfDay: "09:30",
        intervalSeconds: 3600,
    });
    assert.equal(daily?.scheduleType, "daily");
    assert.equal(daily?.timeOfDay, "09:30");

    assert.throws(
        () => updateScheduledJob("cache.weather", { intervalSeconds: 10 }),
        /integer >= 60/u
    );
    assert.throws(
        () =>
            updateScheduledJob("cache.weather", {
                scheduleType: "daily",
                timeOfDay: "99:00",
            }),
        /HH:mm/u
    );
    assert.throws(
        () => updateScheduledJob("cache.weather", { scheduleType: "cron" }),
        /not implemented/u
    );
    assert.equal(updateScheduledJob("missing", { enabled: true }), null);
});

test("runs jobs and records success or failure", async () => {
    __testing.setActionExecutorForTests(async (job) => ({
        actionType: job.actionType,
        actionTarget: job.actionTarget,
    }));
    const success = await runScheduledJob("cache.weather");
    assert.equal(success.status, "success");
    assert.equal(success.output.actionTarget, "weather.spydeberg");
    assert.equal(getScheduledJob("cache.weather")?.lastRun?.status, "success");

    __testing.setActionExecutorForTests(async () => {
        throw new Error("boom");
    });
    const failure = await runScheduledJob("cache.quotas", "schedule");
    assert.equal(failure.status, "failed");
    assert.equal(failure.triggerType, "schedule");
    assert.equal(failure.message, "boom");

    await assert.rejects(runScheduledJob("missing"), /not found/u);
});

test("runs combined Moltbook and backend-owned jobs through scheduler actions", async () => {
    const refreshedKeys: string[] = [];
    __testing.setActionRunnersForTests({
        cacheRefresh: async (key) => {
            refreshedKeys.push(key);
            return { key };
        },
        dockerUpdater: async () => [{ ok: true, step: "docker-updater" }],
        logRotation: async ({ dryRun }) => ({
            result: { dryRun, ok: true },
            stderr: "",
        }),
        openClawNotification: async () => {
            refreshedKeys.push("notification.openclaw");
        },
        quotaNotification: async () => {
            refreshedKeys.push("notification.quotas");
        },
    });

    const moltbook = await runScheduledJob("cache.moltbook");
    const docker = await runScheduledJob("docker.updater");
    const logRotation = await runScheduledJob("ops.log-rotation");
    const backupWalg = await runScheduledJob("cache.backup-walg");
    const openClaw = await runScheduledJob("notification.openclaw");
    const quotas = await runScheduledJob("notification.quotas");

    assert.deepEqual(refreshedKeys.slice(0, 5), [
        "moltbook.home",
        "moltbook.feed.hot",
        "moltbook.feed.new",
        "moltbook.profile",
        "moltbook.my-content",
    ]);
    assert.deepEqual(
        moltbook.output.entries,
        refreshedKeys.slice(0, 5).map((key) => ({ key }))
    );
    assert.deepEqual(docker.output.steps, [{ ok: true, step: "docker-updater" }]);
    assert.deepEqual(logRotation.output.logRotation, {
        result: { dryRun: false, ok: true },
        stderr: "",
    });
    assert.deepEqual(backupWalg.output.entry, { key: "backup.walg.status" });
    assert.deepEqual(openClaw.output, { checked: true });
    assert.deepEqual(quotas.output, { checked: true });
    assert.deepEqual(refreshedKeys.slice(5), [
        "backup.walg.status",
        "notification.openclaw",
        "notification.quotas",
    ]);
});

test("runs due scheduled jobs and skips jobs already running", async () => {
    const ran: string[] = [];
    __testing.setActionExecutorForTests(
        (job) =>
            new Promise((resolve) => {
                ran.push(job.id);
                setTimeout(() => resolve({ job: job.id }), 20);
            })
    );
    updateScheduledJob("cache.weather", { enabled: true, intervalSeconds: 60 });
    updateScheduledJob("cache.git", {
        enabled: true,
        scheduleType: "daily",
        timeOfDay: "02:40",
    });
    db.prepare(
        "UPDATE scheduled_jobs SET next_run_at = ? WHERE id IN ('cache.weather', 'cache.git')"
    ).run("2000-01-01T00:00:00.000Z");

    const running = runScheduledJob("cache.weather", "schedule");
    await __testing.runDueJobs();
    await running;

    assert.deepEqual(
        ran.filter((id) => id === "cache.weather"),
        ["cache.weather"]
    );
    assert.ok(ran.includes("cache.git"));
});

test("covers scheduled job mapping and unsupported-action edge cases", async () => {
    assert.deepEqual(__testing.parseObjectJson("not-json"), {});
    assert.throws(() => __testing.requireRecordedRun(null), /was not recorded/u);

    db.prepare(
        `INSERT INTO scheduled_jobs (
            id, name, description, enabled, schedule_type, interval_seconds,
            action_type, action_target, settings_json, next_run_at, created_at, updated_at
        ) VALUES (
            'custom.bad-json', 'Bad JSON', 'Bad settings', 1, 'interval', 60,
            'cache.refreshMany', 'bad-json', 'null', ?, ?, ?
        )`
    ).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    assert.deepEqual(getScheduledJob("custom.bad-json")?.settings, {});
    const failedMany = await runScheduledJob("custom.bad-json");
    assert.equal(failedMany.status, "failed");
    assert.equal(failedMany.message, "cache.refreshMany requires settings.keys");

    db.prepare(
        `INSERT INTO scheduled_jobs (
            id, name, description, enabled, schedule_type, interval_seconds,
            action_type, action_target, settings_json, next_run_at, created_at, updated_at
        ) VALUES (
            'custom.unsupported', 'Unsupported', 'Unsupported action', 1, 'interval', 60,
            'unknown.action', 'unknown', '{}', ?, ?, ?
        )`
    ).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    const unsupported = await runScheduledJob("custom.unsupported");
    assert.equal(unsupported.status, "failed");
    assert.match(unsupported.message ?? "", /Unsupported scheduled job action/u);
    assert.equal(__testing.requireRecordedRun(unsupported).id, unsupported.id);

    assert.throws(
        () => updateScheduledJob("cache.weather", { scheduleType: "bogus" as never }),
        /scheduleType must be/u
    );
    assert.throws(
        () =>
            __testing.defaultJobs
                .map((job) => ({ ...job }))
                .map((job) =>
                    job.id === "cache.weather"
                        ? { ...job, cacheKey: undefined, actionTarget: undefined }
                        : job
                )
                .forEach((job) => {
                    if (job.id === "cache.weather") {
                        __testing.getDefaultActionTargetForTests(job);
                    }
                }),
        /missing an action target/u
    );
});

test("rejects duplicate manual runs and starts the scheduler tick", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let intervalMs = 0;
    let cleared = false;
    __testing.setActionExecutorForTests(
        () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 25))
    );
    const first = runScheduledJob("cache.weather");
    await assert.rejects(() => runScheduledJob("cache.weather"), /already running/u);
    await first;

    globalThis.setInterval = ((callback: () => void, ms?: number) => {
        intervalMs = ms ?? 0;
        callback();
        return { unref: () => {} } as unknown as NodeJS.Timeout;
    }) as typeof setInterval;
    globalThis.clearInterval = ((_timer?: NodeJS.Timeout | number | string) => {
        cleared = true;
    }) as typeof clearInterval;
    try {
        startScheduledJobScheduler();
        startScheduledJobScheduler();
        stopScheduledJobScheduler();
        assert.equal(intervalMs > 0, true);
        assert.equal(cleared, true);
    } finally {
        stopScheduledJobScheduler();
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});
