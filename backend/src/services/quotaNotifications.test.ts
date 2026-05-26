import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { db } from "../db.js";

const originalPath = process.env.PATH;
const originalPercent = process.env.FAKE_OPENROUTER_PERCENT;
const originalQuotasJson = process.env.FAKE_QUOTAS_JSON;

async function installFakeDocker(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const dockerPath = path.join(binDir, "docker");
    await writeFile(
        dockerPath,
        String.raw`#!${process.execPath}
const percent = Number(process.env.FAKE_OPENROUTER_PERCENT || "91");
const checkedAt = 1_800_000_000_000;
const data = process.env.FAKE_QUOTAS_JSON
  ? JSON.parse(process.env.FAKE_QUOTAS_JSON)
  : {
      openrouter: { usage: 9, totalCredits: 10, remaining: 1.23, usageMonthly: 9, percentUsed: percent },
      elevenlabs: { status: "not_configured" },
      synthetic: { status: "not_configured" },
      openai: { status: "not_configured" },
      checkedAt,
      cacheAgeMs: 0,
    };
process.stdout.write([
  "key\tdata\tsource\tupdated_at\tlast_attempt_at\texpires_at\tstatus\terror_code\terror_message\tconsecutive_failures\tmeta",
  "quotas.summary\t" + JSON.stringify(data) + "\tquotas\t2026-05-11T00:00:00.000Z\t2026-05-11T00:00:00.000Z\t2026-05-11T01:00:00.000Z\tfresh\t\t\t0\t{}",
  "",
].join("\n"));
`,
        "utf8"
    );
    await chmod(dockerPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
}

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

describe("quota notifications", () => {
    let tempDir: string;
    let runQuotaNotificationCheck: () => Promise<void>;
    let startQuotaNotificationMonitor: (intervalMs?: number) => void;
    let quotaTesting: typeof import("./quotaNotifications.js").__testing;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-quota-notifications-"));
        await installFakeDocker(tempDir);
        ({ runQuotaNotificationCheck, startQuotaNotificationMonitor } =
            await import("./quotaNotifications.js"));
        ({ __testing: quotaTesting } = await import("./quotaNotifications.js"));
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
        process.env.PATH = originalPath;
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
        await rm(tempDir, { recursive: true, force: true });
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
        assert.ok(!titles.some((title) => title.includes("OpenRouter")));
    });

    it("handles concurrent checks, cache failures, and monitor interval fallbacks", async () => {
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
            const originalSetInterval = globalThis.setInterval;
            const scheduled: number[] = [];
            globalThis.setInterval = ((_callback: () => void, intervalMs?: number) => {
                _callback();
                scheduled.push(intervalMs ?? 0);
                return { unref: () => {} } as unknown as NodeJS.Timeout;
            }) as typeof setInterval;
            try {
                startQuotaNotificationMonitor(1);
                startQuotaNotificationMonitor(60_000);
                assert.deepEqual(scheduled, [15 * 60 * 1000, 60_000]);
                await new Promise((resolve) => setTimeout(resolve, 100));
            } finally {
                globalThis.setInterval = originalSetInterval;
            }
        } finally {
            console.error = originalError;
        }
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
                new Date(quotas.checkedAt).toISOString()
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
            description: "5h 100% left · weekly 3 left",
        });
        assert.deepEqual(quotaTesting.getState("openrouter", 80), { is_armed: 1 });
    });
});
