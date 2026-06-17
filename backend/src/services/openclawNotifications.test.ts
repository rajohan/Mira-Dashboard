import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";

import { db } from "../db.js";
import { insertCacheEntry } from "../testUtils/cacheFixtures.js";
import { runScheduledJob } from "./scheduledJobs.js";

const originalUpdateAvailable = process.env.FAKE_OPENCLAW_UPDATE_AVAILABLE;
const originalLatest = process.env.FAKE_OPENCLAW_LATEST;
const originalMissingVersion = process.env.FAKE_OPENCLAW_MISSING_VERSION;

function openClawNotifications(): Array<{
    title: string;
    description: string;
    dedupe_key: string;
    metadata_json: string;
}> {
    return db
        .prepare(
            "SELECT title, description, dedupe_key, metadata_json FROM notifications WHERE source = 'openclaw' ORDER BY dedupe_key"
        )
        .all()
        .map((row) => {
            const item = row as {
                title: string;
                description: string;
                dedupe_key: string;
                metadata_json: string;
            };
            return {
                title: item.title,
                description: item.description,
                dedupe_key: item.dedupe_key,
                metadata_json: item.metadata_json,
            };
        });
}

function insertSystemHostCacheFromEnv(): void {
    const updateAvailable = process.env.FAKE_OPENCLAW_UPDATE_AVAILABLE !== "false";
    const latest = process.env.FAKE_OPENCLAW_LATEST || "v2026.5.99";
    const version =
        process.env.FAKE_OPENCLAW_MISSING_VERSION === "true"
            ? undefined
            : {
                  current: "v2026.5.4",
                  latest,
                  updateAvailable,
                  checkedAt: 1_800_000_000_000,
              };
    insertCacheEntry({
        key: "system.host",
        data: {
            version,
            checkedAt: "2026-05-11T00:00:00.000Z",
        },
        source: "system",
    });
}

describe("OpenClaw update notifications", () => {
    let runOpenClawNotificationCheck: () => Promise<void>;
    let registerOpenClawNotificationScheduledJobs: () => void;
    let getState: () => { is_armed: number; last_latest: string | null };

    before(async () => {
        const openClawNotifications = await import("./openclawNotifications.js");
        registerOpenClawNotificationScheduledJobs =
            openClawNotifications.registerOpenClawNotificationScheduledJobs;
        runOpenClawNotificationCheck = async () => {
            insertSystemHostCacheFromEnv();
            await openClawNotifications.runOpenClawNotificationCheck();
        };
        ({ getState } = openClawNotifications.__testing);
    });

    beforeEach(() => {
        db.exec("BEGIN TRANSACTION");
        process.env.FAKE_OPENCLAW_UPDATE_AVAILABLE = "true";
        process.env.FAKE_OPENCLAW_LATEST = "v2026.5.99";
        delete process.env.FAKE_OPENCLAW_MISSING_VERSION;
    });

    afterEach(() => {
        db.exec("ROLLBACK");
    });

    after(async () => {
        if (originalUpdateAvailable === undefined) {
            delete process.env.FAKE_OPENCLAW_UPDATE_AVAILABLE;
        } else {
            process.env.FAKE_OPENCLAW_UPDATE_AVAILABLE = originalUpdateAvailable;
        }
        if (originalLatest === undefined) {
            delete process.env.FAKE_OPENCLAW_LATEST;
        } else {
            process.env.FAKE_OPENCLAW_LATEST = originalLatest;
        }
        if (originalMissingVersion === undefined) {
            delete process.env.FAKE_OPENCLAW_MISSING_VERSION;
        } else {
            process.env.FAKE_OPENCLAW_MISSING_VERSION = originalMissingVersion;
        }
    });

    it("creates one update notification per latest version and disarms repeated alerts", async () => {
        db.prepare("DELETE FROM openclaw_alert_state WHERE id = 1").run();
        assert.equal(getState().is_armed, 1);
        assert.equal(getState().last_latest, null);

        await runOpenClawNotificationCheck();
        await runOpenClawNotificationCheck();

        const notifications = openClawNotifications();
        assert.equal(notifications.length, 1);
        assert.deepEqual(notifications[0], {
            title: "OpenClaw update available",
            description: "Current v2026.5.4 → latest v2026.5.99.",
            dedupe_key: "openclaw:update:v2026.5.99",
            metadata_json: JSON.stringify({
                current: "v2026.5.4",
                latest: "v2026.5.99",
                updateAvailable: true,
            }),
        });

        const state = db
            .prepare(
                "SELECT is_armed, last_latest FROM openclaw_alert_state WHERE id = 1"
            )
            .get() as { is_armed: number; last_latest: string };
        assert.deepEqual(
            { is_armed: state.is_armed, last_latest: state.last_latest },
            { is_armed: 0, last_latest: "v2026.5.99" }
        );
    });

    it("rearms when no update is available and alerts for a new latest version", async () => {
        await runOpenClawNotificationCheck();

        process.env.FAKE_OPENCLAW_UPDATE_AVAILABLE = "false";
        await runOpenClawNotificationCheck();

        const rearmed = db
            .prepare(
                "SELECT is_armed, last_latest FROM openclaw_alert_state WHERE id = 1"
            )
            .get() as { is_armed: number; last_latest: string };
        assert.deepEqual(
            { is_armed: rearmed.is_armed, last_latest: rearmed.last_latest },
            { is_armed: 1, last_latest: "v2026.5.99" }
        );

        process.env.FAKE_OPENCLAW_UPDATE_AVAILABLE = "true";
        process.env.FAKE_OPENCLAW_LATEST = "v2026.6.0";
        await runOpenClawNotificationCheck();

        assert.deepEqual(
            openClawNotifications().map((notification) => notification.dedupe_key),
            ["openclaw:update:v2026.5.99", "openclaw:update:v2026.6.0"]
        );
    });

    it("ignores concurrent checks and malformed version cache rows", async () => {
        const first = runOpenClawNotificationCheck();
        await runOpenClawNotificationCheck();
        await first;
        assert.equal(openClawNotifications().length, 1);
        const stateBeforeMalformedCache = getState();

        process.env.FAKE_OPENCLAW_MISSING_VERSION = "true";
        await runOpenClawNotificationCheck();
        assert.equal(openClawNotifications().length, 1);
        assert.deepEqual(getState(), stateBeforeMalformedCache);
    });

    it("registers OpenClaw notifications with the shared scheduler", async () => {
        db.exec("ROLLBACK");
        try {
            registerOpenClawNotificationScheduledJobs();

            const job = db
                .prepare(
                    `SELECT id, name, enabled, schedule_type, interval_seconds, action_key, action_payload_json
                     FROM scheduled_jobs WHERE id = 'notifications.openclaw'`
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
                    action_key: "notifications.openclaw",
                    action_payload_json: "{}",
                    enabled: 1,
                    id: "notifications.openclaw",
                    interval_seconds: 60 * 60,
                    name: "OpenClaw notifications",
                    schedule_type: "interval",
                }
            );

            const run = await runScheduledJob("notifications.openclaw");
            assert.equal(run.status, "success");
        } finally {
            db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(
                "notifications.openclaw"
            );
            db.exec("BEGIN TRANSACTION");
        }
    });

    it("rolls back OpenClaw notification schedule registration failures", () => {
        db.exec("ROLLBACK");
        const originalExec = db.exec.bind(db);
        const execMock = mock.method(db, "exec", (sql: string) => {
            if (sql === "COMMIT") {
                throw new Error("commit failed");
            }
            return originalExec(sql);
        });
        try {
            assert.throws(registerOpenClawNotificationScheduledJobs, /commit failed/u);
        } finally {
            execMock.mock.restore();
            db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(
                "notifications.openclaw"
            );
            db.exec("BEGIN TRANSACTION");
        }
    });
});
