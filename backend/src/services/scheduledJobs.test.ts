import assert from "node:assert/strict";
import test from "node:test";

import { db } from "../db.js";
import { __testing as logRotationTesting } from "./logRotation.js";
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
    __testing.seedDefaultScheduledJobs();
    __testing.setActionExecutorForTests(undefined);
    __testing.setActionRunnersForTests(undefined);
    __testing.resetStaleRunningRunReconciliationForTests();
});

test.afterEach(() => {
    __testing.setActionExecutorForTests(undefined);
    __testing.setActionRunnersForTests(undefined);
    logRotationTesting.resetElevatedLogRotationExecFileRunner();
});

test("creates built-in jobs with interval and precise daily schedules", () => {
    const beforeList = Date.now();
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
    for (const job of jobs.filter((item) =>
        __testing.defaultJobs.some((defaultJob) => defaultJob.id === item.id)
    )) {
        assert.ok(job.nextRunAt);
        if (job.id === "notification.openclaw" || job.id === "notification.quotas") {
            assert.ok(
                new Date(job.nextRunAt).getTime() <= Date.now(),
                `${job.id} should run once immediately after initial seeding`
            );
            continue;
        }
        const nextRunTime = new Date(job.nextRunAt).getTime();
        assert.ok(nextRunTime > Date.now(), `${job.id} should follow its schedule`);
        assert.ok(nextRunTime >= beforeList, `${job.id} should not be backdated`);
    }
    updateScheduledJob("cache.weather", { enabled: true, intervalSeconds: 7200 });
    const rescheduled = getScheduledJob("cache.weather")?.nextRunAt;
    assert.ok(rescheduled);
    __testing.seedDefaultScheduledJobs();
    assert.equal(getScheduledJob("cache.weather")?.nextRunAt, rescheduled);
});

test("lists jobs with latest runs from one batched lookup", () => {
    const older = "2026-06-05T00:00:00.000Z";
    const newer = "2026-06-05T01:00:00.000Z";
    db.prepare(
        `INSERT INTO scheduled_job_runs (
            job_id, status, trigger_type, started_at, finished_at, message, output_json
        ) VALUES
            ('cache.weather', 'success', 'manual', ?, ?, 'older', '{}'),
            ('cache.weather', 'failed', 'manual', ?, ?, 'newer', '{}')`
    ).run(older, older, newer, newer);
    const originalPrepare = db.prepare.bind(db);
    let latestLookupCount = 0;
    const prepareMock = test.mock.method(db, "prepare", (sql: string) => {
        if (sql.includes("FROM scheduled_job_runs WHERE job_id = ?")) {
            latestLookupCount += 1;
        }
        return originalPrepare(sql);
    });

    const weather = listScheduledJobs().find((job) => job.id === "cache.weather");

    assert.equal(weather?.lastRun?.message, "newer");
    assert.equal(latestLookupCount, 0);
    prepareMock.mock.restore();
});

test("lists no jobs when the scheduled job table is empty", () => {
    db.exec("DELETE FROM scheduled_job_runs; DELETE FROM scheduled_jobs;");
    assert.deepEqual(listScheduledJobs(), []);
});

test("computes next daily run for today or tomorrow", () => {
    const beforeDailyTime = new Date("2026-06-05T00:00:00.000Z");
    const expectedSameDay = new Date(beforeDailyTime);
    expectedSameDay.setUTCHours(2, 40, 0, 0);
    assert.equal(
        __testing.nextDailyRunIso("02:40", beforeDailyTime),
        expectedSameDay.toISOString()
    );

    const afterDailyTime = new Date("2026-06-05T03:00:00.000Z");
    const expectedNextDay = new Date(afterDailyTime);
    expectedNextDay.setUTCHours(2, 40, 0, 0);
    if (expectedNextDay.getTime() <= afterDailyTime.getTime()) {
        expectedNextDay.setUTCDate(expectedNextDay.getUTCDate() + 1);
    }
    assert.equal(
        __testing.nextDailyRunIso("02:40", afterDailyTime),
        expectedNextDay.toISOString()
    );
    assert.throws(() => __testing.nextDailyRunIso("25:00"), /HH:mm/u);
    assert.throws(
        () => __testing.nextIntervalRunIso(Number.MAX_SAFE_INTEGER),
        /outside JS Date bounds/u
    );
    assert.ok(
        new Date(
            __testing.computeDefaultNextRunIso({
                id: "test.interval",
                name: "Test interval",
                description: "Test interval",
                cacheKey: "system.host",
                scheduleType: "interval",
                intervalSeconds: 60,
                timeOfDay: null,
                cronExpression: null,
            })
        ).getTime() > Date.now()
    );
    assert.ok(
        new Date(
            __testing.computeDefaultNextRunIso({
                id: "test.invalid",
                name: "Test invalid",
                description: "Test invalid",
                cacheKey: "system.host",
                scheduleType: "daily",
                intervalSeconds: 60,
                timeOfDay: "nope",
                cronExpression: null,
            })
        ).getTime() <= Date.now()
    );
});

test("updates enable state, interval schedules, and daily schedules", () => {
    const original = getScheduledJob("cache.weather");
    const disabled = updateScheduledJob("cache.weather", {
        enabled: false,
        intervalSeconds: 7200,
    });
    assert.equal(disabled?.enabled, false);
    assert.equal(disabled?.nextRunAt, null);

    const reenabled = updateScheduledJob("cache.weather", { enabled: true });
    assert.equal(reenabled?.enabled, true);
    assert.ok(reenabled?.nextRunAt);
    assert.notEqual(reenabled?.nextRunAt, original?.nextRunAt);

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
        () => updateScheduledJob("cache.weather", { scheduleType: "cron" as never }),
        /scheduleType must be interval or daily/u
    );
    assert.equal(updateScheduledJob("missing", { enabled: true }), null);
});

test("runs jobs and records success or failure", async () => {
    __testing.setActionExecutorForTests(async (job) => ({
        actionType: job.actionType,
        actionTarget: job.actionTarget,
    }));
    const nonDueNextRun = "2999-01-01T00:00:00.000Z";
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        nonDueNextRun,
        "cache.weather"
    );
    const nextRunBeforeManualSuccess = getScheduledJob("cache.weather")?.nextRunAt;
    const success = await runScheduledJob("cache.weather");
    assert.equal(success.status, "success");
    assert.equal(success.output.actionTarget, "weather.spydeberg");
    assert.equal(getScheduledJob("cache.weather")?.lastRun?.status, "success");
    assert.equal(getScheduledJob("cache.weather")?.nextRunAt, nextRunBeforeManualSuccess);

    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2026-06-06T00:00:00.000Z",
        "cache.weather"
    );
    const manualDueSuccess = await runScheduledJob("cache.weather");
    assert.equal(manualDueSuccess.status, "success");
    assert.notEqual(
        getScheduledJob("cache.weather")?.nextRunAt,
        "2026-06-06T00:00:00.000Z"
    );

    __testing.setActionExecutorForTests(async () => {
        updateScheduledJob("cache.weather", { enabled: false, intervalSeconds: 7200 });
        return { updated: true };
    });
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2026-06-06T00:00:00.000Z",
        "cache.weather"
    );
    const concurrentPatch = await runScheduledJob("cache.weather", "schedule");
    assert.equal(concurrentPatch.status, "success");
    const patchedJob = getScheduledJob("cache.weather");
    assert.equal(patchedJob?.enabled, false);
    assert.equal(patchedJob?.nextRunAt, null);

    db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run("cache.weather");
    __testing.updateNextRunFromLatestJob("cache.weather");
    assert.equal(
        db.prepare("SELECT id FROM scheduled_jobs WHERE id = ?").get("cache.weather"),
        undefined
    );
    __testing.seedDefaultScheduledJobs();

    __testing.setActionExecutorForTests(async () => {
        throw new Error("boom");
    });
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2026-06-06T00:00:00.000Z",
        "cache.quotas"
    );
    const failure = await runScheduledJob("cache.quotas", "schedule");
    assert.equal(failure.status, "failed");
    assert.equal(failure.triggerType, "schedule");
    assert.equal(failure.message, "boom");

    updateScheduledJob("cache.weather", { enabled: true, intervalSeconds: 7200 });
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2026-06-06T00:00:00.000Z",
        "cache.weather"
    );
    const manualFailure = await runScheduledJob("cache.weather");
    assert.equal(manualFailure.status, "failed");
    assert.notEqual(
        getScheduledJob("cache.weather")?.nextRunAt,
        "2026-06-06T00:00:00.000Z"
    );

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
        "system.host",
        "notification.openclaw",
        "quotas.summary",
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

    __testing.setActionRunnersForTests({
        cacheRefresh: async (key) => {
            refreshedKeys.push(key);
            return { key };
        },
        openClawNotification: async () => false,
        quotaNotification: async () => false,
        logRotation: async () => ({ ok: false }),
    });
    const failedOpenClaw = await runScheduledJob("notification.openclaw");
    const failedQuotas = await runScheduledJob("notification.quotas");
    const failedLogRotation = await runScheduledJob("ops.log-rotation");
    assert.equal(failedOpenClaw.status, "failed");
    assert.equal(failedQuotas.status, "failed");
    assert.equal(failedLogRotation.status, "failed");

    __testing.setActionRunnersForTests({
        logRotation: async () => ({ result: { ok: false }, stderr: "" }),
    });
    const failedNestedLogRotation = await runScheduledJob("ops.log-rotation");
    assert.equal(failedNestedLogRotation.status, "failed");
});

test("runs default scheduled log rotation through the elevated helper", async () => {
    const commands: Array<{ args: readonly string[]; file: string }> = [];
    logRotationTesting.setElevatedLogRotationExecFileRunner(
        async (file: string, args: readonly string[] | undefined) => {
            commands.push({ args: args ?? [], file });
            return { stderr: "", stdout: JSON.stringify({ ok: true, dryRun: false }) };
        }
    );

    const run = await runScheduledJob("ops.log-rotation");

    assert.equal(run.status, "success");
    assert.deepEqual(run.output.logRotation, {
        result: { ok: true, dryRun: false },
        stderr: "",
    });
    assert.equal(commands[0]?.file, "sudo");
    assert.deepEqual(commands[0]?.args.slice(0, 3), ["-n", "-E", process.execPath]);
    assert.equal(commands[0]?.args[3], "--input-type=module");
    assert.equal(commands[0]?.args[4], "--eval");
    assert.match(commands[0]?.args[5] ?? "", /services\/logRotation\.js/u);
    assert.equal(commands[0]?.args.includes("--dry-run"), false);
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

test("rejects scheduled runs that are disabled or no longer due", async () => {
    updateScheduledJob("cache.weather", { enabled: false });
    await assert.rejects(() => runScheduledJob("cache.weather", "schedule"), {
        message: "Scheduled job not enabled or not due",
        statusCode: 409,
    });

    updateScheduledJob("cache.weather", { enabled: true, intervalSeconds: 60 });
    db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?").run(
        "2999-01-01T00:00:00.000Z",
        "cache.weather"
    );
    await assert.rejects(() => runScheduledJob("cache.weather", "schedule"), {
        message: "Scheduled job not enabled or not due",
        statusCode: 409,
    });
});

test("reconciles stale persisted running runs once on scheduler initialization", () => {
    const timestamp = new Date().toISOString();
    db.prepare(
        `INSERT INTO scheduled_jobs (
            id, name, description, enabled, schedule_type, interval_seconds,
            action_type, action_target, settings_json, next_run_at, created_at, updated_at
        ) VALUES (
            'custom.stale', 'Stale', 'Stale run', 1, 'interval', 60,
            'cache.refresh', 'weather.spydeberg', '{}', ?, ?, ?
        )`
    ).run(timestamp, timestamp, timestamp);
    db.prepare(
        `INSERT INTO scheduled_job_runs (
            job_id, status, trigger_type, started_at, output_json
        ) VALUES ('custom.stale', 'running', 'schedule', ?, '{}')`
    ).run(timestamp);

    __testing.seedDefaultScheduledJobs();
    const job = getScheduledJob("custom.stale");

    assert.equal(job?.lastRun?.status, "failed");
    assert.equal(job?.lastRun?.message, "Job was abandoned after backend restart");
    assert.ok(job?.lastRun?.finishedAt);
});

test("continues due-job tick across expected per-job races", async () => {
    const timestamp = "2000-01-01T00:00:00.000Z";
    for (const job of __testing.defaultJobs) {
        db.prepare("UPDATE scheduled_jobs SET enabled = 0 WHERE id = ?").run(job.id);
    }
    for (const [id, target] of [
        ["custom.race", "race"],
        ["custom.next", "next"],
    ] as const) {
        db.prepare(
            `INSERT INTO scheduled_jobs (
                id, name, description, enabled, schedule_type, interval_seconds,
                action_type, action_target, settings_json, next_run_at, created_at, updated_at
            ) VALUES (?, ?, 'Due', 1, 'interval', 60, 'cache.refresh', ?, '{}', ?, ?, ?)`
        ).run(id, id, target, timestamp, timestamp, timestamp);
    }
    const originalGet = db.prepare.bind(db);
    let raceLookupCount = 0;
    const prepareMock = test.mock.method(db, "prepare", (sql: string) => {
        if (sql.includes("SELECT * FROM scheduled_jobs WHERE id = ? LIMIT 1")) {
            return {
                get: (id: string) => {
                    if (id === "custom.race") {
                        raceLookupCount += 1;
                        if (raceLookupCount > 1) {
                            return;
                        }
                    }
                    return originalGet(sql).get(id);
                },
            };
        }
        return originalGet(sql);
    });
    const refreshed: string[] = [];
    __testing.setActionExecutorForTests(async (job) => {
        refreshed.push(job.actionTarget);
        return {};
    });
    try {
        await __testing.runDueJobs();
    } finally {
        prepareMock.mock.restore();
        __testing.setActionExecutorForTests(undefined);
    }

    assert.deepEqual(refreshed, ["next"]);
    assert.equal(__testing.isScheduledJobRaceError({ status: 409 }), true);
    assert.equal(__testing.isScheduledJobRaceError({ statusCode: 404 }), true);
    assert.equal(__testing.isScheduledJobRaceError({ code: "409" }), true);
    assert.equal(
        __testing.isScheduledJobRaceError(new Error("Job is already running")),
        true
    );
    assert.equal(__testing.isScheduledJobRaceError({}), false);
    assert.equal(__testing.isScheduledJobRaceError(new Error("boom")), false);
});

test("rethrows unexpected due-job errors", async () => {
    const timestamp = "2000-01-01T00:00:00.000Z";
    db.prepare(
        `INSERT INTO scheduled_jobs (
            id, name, description, enabled, schedule_type, interval_seconds,
            action_type, action_target, settings_json, next_run_at, created_at, updated_at
        ) VALUES (
            'custom.unexpected-race', 'Unexpected', 'Due', 1, 'interval', 60,
            'cache.refresh', 'weather', '{}', ?, ?, ?
        )`
    ).run(timestamp, timestamp, timestamp);
    const originalGet = db.prepare.bind(db);
    const prepareMock = test.mock.method(db, "prepare", (sql: string) => {
        if (sql.includes("INSERT INTO scheduled_job_runs")) {
            return {
                run: () => {
                    throw new Error("run insert failed");
                },
            };
        }
        return originalGet(sql);
    });
    try {
        await assert.rejects(__testing.runDueJobs(), /run insert failed/u);
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
