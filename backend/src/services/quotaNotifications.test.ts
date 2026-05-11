import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { db } from "../db.js";

const originalPath = process.env.PATH;
const originalPercent = process.env.FAKE_OPENROUTER_PERCENT;

async function installFakeDocker(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const dockerPath = path.join(binDir, "docker");
    await writeFile(
        dockerPath,
        String.raw`#!/usr/bin/env node
const percent = Number(process.env.FAKE_OPENROUTER_PERCENT || "91");
const checkedAt = 1_800_000_000_000;
const data = {
  openrouter: { usage: 9, totalCredits: 10, remaining: 1.23, usageMonthly: 9, percentUsed: percent },
  elevenlabs: { status: "not_configured" },
  zai: { status: "not_configured" },
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

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-quota-notifications-"));
        await installFakeDocker(tempDir);
        ({ runQuotaNotificationCheck } = await import("./quotaNotifications.js"));
    });

    beforeEach(() => {
        db.exec("BEGIN TRANSACTION");
        process.env.FAKE_OPENROUTER_PERCENT = "91";
    });

    after(async () => {
        try {
            db.exec("ROLLBACK");
        } catch {
            // Ignore when the current test already rolled back.
        }
        process.env.PATH = originalPath;
        if (originalPercent === undefined) {
            delete process.env.FAKE_OPENROUTER_PERCENT;
        } else {
            process.env.FAKE_OPENROUTER_PERCENT = originalPercent;
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
});
