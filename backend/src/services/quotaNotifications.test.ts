import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";

import { db } from "../db.js";
import { insertCacheEntry } from "../testUtils/cacheFixtures.js";
import { runScheduledJob } from "./scheduledJobs.js";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

const originalPercent = process.env.FAKE_OPENROUTER_PERCENT;
const originalQuotasJson = process.env.FAKE_QUOTAS_JSON;

function quotaNotifications(): Array<{
    title: string;
    dedupe_key: string;
    metadata_json: string;
}> {
    return db
        .prepare(
            "SELECT title, dedupe_key, metadata_json FROM notifications WHERE source = 'quota' ORDER BY dedupe_key"
        )
        .all() as Array<{ title: string; dedupe_key: string; metadata_json: string }>;
}

function insertQuotaCacheFromEnv(): void {
    const percent = Number(process.env.FAKE_OPENROUTER_PERCENT || "91");
    let data: unknown;
    if (process.env.FAKE_QUOTAS_JSON) {
        try {
            data = JSON.parse(process.env.FAKE_QUOTAS_JSON);
        } catch {
            data = process.env.FAKE_QUOTAS_JSON;
        }
    } else {
        data = {
            openrouter: {
                usage: 9,
                totalCredits: 10,
                remaining: 1.23,
                usageMonthly: 9,
                percentUsed: percent,
            },
            elevenlabs: { status: "not_configured" },
            synthetic: { status: "not_configured" },
            openai: { status: "not_configured" },
            checkedAt: 1_800_000_000_000,
            cacheAgeMs: 0,
        };
    }
    insertCacheEntry({
        key: "quotas.summary",
        data,
        source: "quotas",
    });
}

describe("quota notifications", () => {
    let runQuotaNotificationCheck: () => Promise<void>;
    let registerQuotaNotificationScheduledJobs: () => void;
    let quotaTesting: typeof import("./quotaNotifications.js").__testing;

    before(async () => {
        ({ runQuotaNotificationCheck, registerQuotaNotificationScheduledJobs } =
            await import("./quotaNotifications.js"));
        ({ __testing: quotaTesting } = await import("./quotaNotifications.js"));
        const actualRunQuotaNotificationCheck = runQuotaNotificationCheck;
        runQuotaNotificationCheck = async () => {
            insertQuotaCacheFromEnv();
            await actualRunQuotaNotificationCheck();
        };
    });

    beforeEach(() => {
        db.exec("BEGIN TRANSACTION");
        db.exec("DELETE FROM notifications WHERE source = 'quota'");
        db.exec("DELETE FROM quota_alert_state");
        process.env.FAKE_OPENROUTER_PERCENT = "91";
        delete process.env.FAKE_QUOTAS_JSON;
    });

    afterEach(() => {
        db.exec("ROLLBACK");
    });

    after(async () => {
        if (originalPercent === undefined) {
            delete process.env.FAKE_OPENROUTER_PERCENT;
        } else {
            process.env.FAKE_OPENROUTER_PERCENT = originalPercent;
        }
        if (originalQuotasJson === undefined) {
            delete process.env.FAKE_QUOTAS_JSON;
        } else {
            process.env.FAKE_QUOTAS_JSON = originalQuotasJson;
        }
    });

    it("creates quota notifications for crossed thresholds and rearms after hysteresis", async () => {
        await runQuotaNotificationCheck();

        const notifications = quotaNotifications();
        assert.deepEqual(
            notifications.map((notification) => notification.dedupe_key),
            ["quota:openrouter:80", "quota:openrouter:90"]
        );
        assert.equal(notifications[0]?.title, "OpenRouter usage high (80%)");
        assert.deepEqual(JSON.parse(notifications[1]?.metadata_json || "{}"), {
            provider: "openrouter",
            bucket: 90,
            percent: 91,
        });

        const disarmed = (
            db
                .prepare(
                    "SELECT bucket, is_armed FROM quota_alert_state WHERE provider = 'openrouter' ORDER BY bucket"
                )
                .all() as Array<{ bucket: number; is_armed: number }>
        ).map((row) => ({ bucket: row.bucket, is_armed: row.is_armed }));
        assert.deepEqual(disarmed, [
            { bucket: 80, is_armed: 0 },
            { bucket: 90, is_armed: 0 },
            { bucket: 95, is_armed: 1 },
        ]);

        process.env.FAKE_OPENROUTER_PERCENT = "70";
        await runQuotaNotificationCheck();

        const rearmed = (
            db
                .prepare(
                    "SELECT bucket, is_armed FROM quota_alert_state WHERE provider = 'openrouter' ORDER BY bucket"
                )
                .all() as Array<{ bucket: number; is_armed: number }>
        ).map((row) => ({ bucket: row.bucket, is_armed: row.is_armed }));
        assert.deepEqual(rearmed, [
            { bucket: 80, is_armed: 1 },
            { bucket: 90, is_armed: 1 },
            { bucket: 95, is_armed: 1 },
        ]);
        assert.equal(quotaNotifications().length, 2);
    });

    it("creates provider-specific quota notifications and ignores status-only providers", async () => {
        process.env.FAKE_QUOTAS_JSON = JSON.stringify({
            openrouter: { status: "error", message: "missing cache" },
            elevenlabs: {
                usage: 8_700,
                limit: 10_000,
                remaining: 1_300,
                percentUsed: 87,
            },
            synthetic: {
                rollingFiveHourLimit: {
                    usedTokens: 0,
                    limit: 100,
                    remainingTokens: 8,
                    percentUsed: 92,
                },
                weeklyTokenLimit: {
                    usedTokens: 40,
                    limit: 100,
                    remainingTokens: 60,
                    percentRemaining: 60,
                },
            },
            openai: {
                fiveHourUsedPercent: 99,
                fiveHourLeftPercent: 1,
                weeklyUsedPercent: 20,
                weeklyLeftPercent: 80,
                percentUsed: 99,
            },
            checkedAt: 1_800_000_000_000,
            cacheAgeMs: 0,
        });

        await runQuotaNotificationCheck();

        assert.deepEqual(
            quotaNotifications().map((notification) => notification.dedupe_key),
            [
                "quota:elevenlabs:80",
                "quota:openai:80",
                "quota:openai:90",
                "quota:openai:95",
                "quota:synthetic:80",
                "quota:synthetic:90",
            ]
        );

        const titles = quotaNotifications().map((notification) => notification.title);
        assert.ok(titles.includes("ElevenLabs usage high (80%)"));
        assert.ok(titles.includes("Synthetic.new usage high (90%)"));
        assert.ok(titles.includes("OpenAI / Codex usage high (95%)"));
        assert.ok(titles.every((title) => !title.includes("OpenRouter")));
    });

    it("handles concurrent checks and cache failures", async () => {
        process.env.FAKE_QUOTAS_JSON = "{not-json";
        const originalError = console.error;
        const errors: unknown[][] = [];
        console.error = (...args: unknown[]) => {
            errors.push(args);
        };
        try {
            await Promise.all([runQuotaNotificationCheck(), runQuotaNotificationCheck()]);
            assert.equal(errors.length > 0, true);
            assert.equal(errors[0]?.[0], "[QuotaNotifications] check failed");

            process.env.FAKE_QUOTAS_JSON = JSON.stringify({
                openrouter: { status: "not_configured" },
                elevenlabs: { status: "not_configured" },
                synthetic: { status: "not_configured" },
                openai: { status: "not_configured" },
                checkedAt: 1_800_000_000_000,
                cacheAgeMs: 0,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
            for (
                let attempt = 0;
                quotaTesting.isRunning() && attempt < 200;
                attempt += 1
            ) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.equal(quotaTesting.isRunning(), false);
        } finally {
            console.error = originalError;
        }
    });

    it("registers quota notifications with the shared scheduler", async () => {
        db.exec("ROLLBACK");
        try {
            registerQuotaNotificationScheduledJobs();

            const job = db
                .prepare(
                    `SELECT id, name, enabled, schedule_type, interval_seconds, action_key, action_payload_json
                     FROM scheduled_jobs WHERE id = 'notifications.quota'`
                )
                .get() as {
                action_key: string;
                action_payload_json: string;
                enabled: number;
                id: string;
                interval_seconds: number;
                name: string;
                schedule_type: string;
            };

            assert.deepEqual(
                { ...job },
                {
                    action_key: "notifications.quota",
                    action_payload_json: "{}",
                    enabled: 1,
                    id: "notifications.quota",
                    interval_seconds: 15 * 60,
                    name: "Quota notifications",
                    schedule_type: "interval",
                }
            );

            const run = await runScheduledJob("notifications.quota");
            assert.equal(run.status, "success");
        } finally {
            db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(
                "notifications.quota"
            );
            db.exec("BEGIN TRANSACTION");
        }
    });

    it("rolls back quota notification schedule registration failures", () => {
        db.exec("ROLLBACK");
        const originalExec = db.exec.bind(db);
        const execMock = mock.method(db, "exec", (sql: string) => {
            if (sql === "COMMIT") {
                throw new Error("commit failed");
            }
            return originalExec(sql);
        });
        try {
            assert.throws(registerQuotaNotificationScheduledJobs, /commit failed/u);
        } finally {
            execMock.mock.restore();
            db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(
                "notifications.quota"
            );
            db.exec("BEGIN TRANSACTION");
        }
    });

    it("formats Synthetic.new weekly quota as percent even when credits are present", () => {
        assert.equal(
            quotaTesting.formatSyntheticWeeklyRemaining({
                maxCredits: "$25.00",
                nextRegenAt: null,
                percentRemaining: 98,
                remainingCredits: "$23.78",
            }),
            "98% left"
        );
    });

    it("handles synthetic rolling usage fallbacks", async () => {
        process.env.FAKE_QUOTAS_JSON = JSON.stringify({
            openrouter: { status: "not_configured" },
            elevenlabs: { status: "not_configured" },
            synthetic: {
                rollingFiveHourLimit: {
                    usedTokens: 0,
                    limit: 100,
                    remainingTokens: 100,
                    percentUsed: null,
                },
                weeklyTokenLimit: {
                    usedTokens: 96,
                    limit: 100,
                    remainingTokens: 4,
                    percentRemaining: 4,
                },
            },
            openai: { status: "not_configured" },
            checkedAt: 1_800_000_000_000,
            cacheAgeMs: 0,
        });

        await runQuotaNotificationCheck();

        assert.deepEqual(
            quotaNotifications().map((notification) => notification.dedupe_key),
            ["quota:synthetic:80", "quota:synthetic:90", "quota:synthetic:95"]
        );
    });

    it("covers quota helper fallback branches directly", () => {
        const quotas = {
            openrouter: { status: "not_configured" },
            elevenlabs: { status: "not_configured" },
            synthetic: {
                subscription: {
                    limit: 0,
                    requests: 0,
                    remaining: 0,
                    renewsAt: null,
                    percentUsed: null,
                },
                searchHourly: {
                    limit: 0,
                    requests: 0,
                    remaining: 0,
                    renewsAt: null,
                    percentUsed: null,
                },
                rollingFiveHourLimit: {
                    remaining: 100,
                    max: 100,
                    limited: false,
                    nextTickAt: null,
                    percentUsed: null,
                },
                weeklyTokenLimit: {
                    percentRemaining: 90,
                    nextRegenAt: null,
                    remainingCredits: "3",
                },
            },
            openai: { status: "not_configured" },
            checkedAt: 1_800_000_000_000,
            cacheAgeMs: 0,
        } as Awaited<
            ReturnType<typeof import("../lib/quotasCache.js").fetchCachedQuotas>
        >;

        assert.equal(quotaTesting.getProviderPercent("openrouter", quotas), null);
        assert.equal(quotaTesting.getProviderPercent("synthetic", quotas), 10);
        assert.equal(quotaTesting.getNotificationPayload("openrouter", 80, quotas), null);
        const originalWarn = console.warn;
        const warnings: unknown[][] = [];
        console.warn = (...args: unknown[]) => {
            warnings.push(args);
        };
        try {
            assert.equal(
                quotaTesting.getProviderNotificationPayload("openrouter", 80, quotas),
                null
            );
            quotaTesting.handleQuotaBucket(
                "openrouter",
                80,
                90,
                quotas,
                dateToISOString(new Date(quotas.checkedAt))
            );
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(
            warnings[0]?.[0],
            "[QuotaNotifications] Missing notification payload for openrouter 80%"
        );
        assert.deepEqual(quotaTesting.getNotificationPayload("synthetic", 80, quotas), {
            title: "Synthetic.new usage high (80%)",
            description: "5h 100% left · weekly 90% left",
        });
        assert.deepEqual(quotaTesting.getState("openrouter", 80), { is_armed: 1 });
    });
});
