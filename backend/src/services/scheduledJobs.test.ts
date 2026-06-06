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
    assert.equal(moltbook?.actionType, "cache.refresh");
    assert.equal(moltbook?.actionTarget, "moltbook");
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
    const beforeDailyTime = new Date("2026-06-05T00:00:00.000Z");
    const expectedSameDay = new Date(beforeDailyTime);
    expectedSameDay.setHours(2, 40, 0, 0);
    assert.equal(
        __testing.nextDailyRunIso("02:40", beforeDailyTime),
        expectedSameDay.toISOString()
    );

    const afterDailyTime = new Date("2026-06-05T03:00:00.000Z");
    const expectedNextDay = new Date(afterDailyTime);
    expectedNextDay.setHours(2, 40, 0, 0);
    if (expectedNextDay.getTime() <= afterDailyTime.getTime()) {
        expectedNextDay.setDate(expectedNextDay.getDate() + 1);
    }
    assert.equal(
        __testing.nextDailyRunIso("02:40", afterDailyTime),
        expectedNextDay.toISOString()
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

    assert.equal(refreshedKeys[0], "moltbook");
    assert.deepEqual(moltbook.output.entry, { key: "moltbook" });
    assert.deepEqual(docker.output.steps, [{ ok: true, step: "docker-updater" }]);
    assert.deepEqual(logRotation.output.logRotation, {
        result: { dryRun: false, ok: true },
        stderr: "",
    });
    assert.deepEqual(backupWalg.output.entry, { key: "backup.walg.status" });
    assert.deepEqual(openClaw.output, { checked: true });
    assert.deepEqual(quotas.output, { checked: true });
    assert.deepEqual(refreshedKeys.slice(1), [
        "backup.walg.status",
        "notification.openclaw",
        "notification.quotas",
    ]);

    __testing.setActionRunnersForTests({
        dockerUpdater: async () => [
            { ok: false, step: "poll", stderr: "registry unavailable" },
        ],
    });
    const failedDocker = await runScheduledJob("docker.updater");
    assert.equal(failedDocker.status, "failed");
    assert.match(failedDocker.message ?? "", /registry unavailable/u);

    __testing.setActionRunnersForTests({
        dockerUpdater: async () => [{ ok: false, step: "poll", stderr: "" }],
    });
    const failedDockerFallback = await runScheduledJob("docker.updater");
    assert.equal(failedDockerFallback.status, "failed");
    assert.match(failedDockerFallback.message ?? "", /poll failed/u);
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

    db.prepare("UPDATE scheduled_jobs SET next_run_at = NULL WHERE id = ?").run(
        "cache.git"
    );
    await __testing.runDueJobs();

    const staleRow = db
        .prepare("SELECT * FROM scheduled_jobs WHERE id = ?")
        .get("cache.git");
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2999-01-01T00:00:00.000Z",
        "cache.git"
    );
    const originalPrepare = db.prepare.bind(db);
    const prepareMock = test.mock.method(db, "prepare", (sql: string) => {
        if (
            sql.includes(
                "WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?"
            )
        ) {
            return { all: () => [staleRow] };
        }
        return originalPrepare(sql);
    });
    try {
        await __testing.runDueJobs();
        assert.equal(ran.filter((id) => id === "cache.git").length, 1);
    } finally {
        prepareMock.mock.restore();
    }
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
            'custom.refresh-many', 'Refresh many', 'Refresh many', 1, 'interval', 60,
            'cache.refreshMany', 'many', ?, ?, ?, ?
        )`
    ).run(
        JSON.stringify({ keys: ["cache.weather", 42, "cache.git"] }),
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString()
    );
    const refreshed: string[] = [];
    __testing.setActionRunnersForTests({
        cacheRefresh: async (key) => {
            refreshed.push(key);
            return { key };
        },
    });
    const refreshMany = await runScheduledJob("custom.refresh-many");
    assert.deepEqual(refreshed, ["cache.weather", "cache.git"]);
    assert.equal(
        (refreshMany.output.entries as Array<{ key: string }>)[1]?.key,
        "cache.git"
    );

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
    assert.throws(() => {
        for (const job of __testing.defaultJobs
            .map((job) => ({ ...job }))
            .map((job) =>
                job.id === "cache.weather"
                    ? { ...job, cacheKey: undefined, actionTarget: undefined }
                    : job
            )) {
            if (job.id === "cache.weather") {
                __testing.getDefaultActionTargetForTests(job);
            }
        }
    }, /missing an action target/u);
});

test("rejects duplicate manual runs and starts the scheduler tick", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let intervalMs = 0;
    let cleared = false;
    let tick: (() => void) | undefined;
    const loggedErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    __testing.setActionExecutorForTests(
        () =>
            new Promise((_resolve, reject) =>
                setTimeout(() => reject(new Error("tick failed")), 25)
            )
    );
    const first = runScheduledJob("cache.weather");
    await assert.rejects(() => runScheduledJob("cache.weather"), /already running/u);
    const failedRun = await first;
    assert.equal(failedRun.status, "failed");
    assert.match(failedRun.message ?? "", /tick failed/u);

    globalThis.setInterval = ((callback: () => void, ms?: number) => {
        intervalMs = ms ?? 0;
        tick = callback;
        return { unref: () => {} } as unknown as NodeJS.Timeout;
    }) as typeof setInterval;
    globalThis.clearInterval = ((_timer?: NodeJS.Timeout | number | string) => {
        cleared = true;
    }) as typeof clearInterval;
    console.error = (...args: unknown[]) => {
        loggedErrors.push(args);
    };
    try {
        startScheduledJobScheduler();
        startScheduledJobScheduler();
        const prepareMock = test.mock.method(db, "prepare", () => {
            throw new Error("runDueJobs unavailable");
        });
        tick?.();
        tick?.();
        await new Promise((resolve) => setTimeout(resolve, 35));
        prepareMock.mock.restore();
        stopScheduledJobScheduler();
        assert.equal(intervalMs > 0, true);
        assert.equal(cleared, true);
        assert.equal(loggedErrors[0]?.[0], "[scheduledJobs] runDueJobs failed");
    } finally {
        stopScheduledJobScheduler();
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
        console.error = originalConsoleError;
    }
});
