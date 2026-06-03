import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { db } from "../db.js";

const originalPath = process.env.PATH;
const originalUpdateAvailable = process.env.FAKE_OPENCLAW_UPDATE_AVAILABLE;
const originalLatest = process.env.FAKE_OPENCLAW_LATEST;
const originalMissingVersion = process.env.FAKE_OPENCLAW_MISSING_VERSION;

async function installFakeDocker(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const dockerPath = path.join(binDir, "docker");
    await writeFile(
        dockerPath,
        String.raw`#!${process.execPath}
	const updateAvailable = process.env.FAKE_OPENCLAW_UPDATE_AVAILABLE !== "false";
	const latest = process.env.FAKE_OPENCLAW_LATEST || "v2026.5.99";
	const version = process.env.FAKE_OPENCLAW_MISSING_VERSION === "true" ? undefined : {
	  current: "v2026.5.4",
	  latest,
	  updateAvailable,
	  checkedAt: 1800000000000,
	};
	const data = {
	  version,
	  checkedAt: "2026-05-11T00:00:00.000Z",
	};
process.stdout.write([
  "key\tdata\tsource\tupdated_at\tlast_attempt_at\texpires_at\tstatus\terror_code\terror_message\tconsecutive_failures\tmeta",
  "system.host\t" + JSON.stringify(data) + "\tsystem\t2026-05-11T00:00:00.000Z\t2026-05-11T00:00:00.000Z\t2026-05-11T01:00:00.000Z\tfresh\t\t\t0\t{}",
  "",
].join("\n"));
`,
        "utf8"
    );
    await chmod(dockerPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
}

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

describe("OpenClaw update notifications", () => {
    let tempDir: string;
    let runOpenClawNotificationCheck: () => Promise<void>;
    let startOpenClawNotificationMonitor: (intervalMs?: number) => void;
    let getState: () => { is_armed: number; last_latest: string | null };
    let stopOpenClawNotificationMonitorForTest: () => void;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-openclaw-notifications-"));
        await installFakeDocker(tempDir);
        const openClawNotifications = await import("./openclawNotifications.js");
        ({ runOpenClawNotificationCheck, startOpenClawNotificationMonitor } =
            openClawNotifications);
        ({ getState, stopOpenClawNotificationMonitorForTest } =
            openClawNotifications.__testing);
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
        process.env.PATH = originalPath;
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
        await rm(tempDir, { recursive: true, force: true });
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

    it("starts the monitor with a safe interval fallback", async () => {
        const originalSetInterval = globalThis.setInterval;
        let scheduledInterval = 0;
        let callbackRuns = 0;
        globalThis.setInterval = ((callback: () => void, intervalMs?: number) => {
            scheduledInterval = intervalMs ?? 0;
            callback();
            callbackRuns += 1;
            const timer = { unref: () => timer } as unknown as NodeJS.Timeout;
            return timer;
        }) as typeof setInterval;
        try {
            startOpenClawNotificationMonitor(Number.MAX_SAFE_INTEGER);
            assert.equal(scheduledInterval, 2_147_483_647);
            stopOpenClawNotificationMonitorForTest();

            startOpenClawNotificationMonitor(1);
            assert.equal(scheduledInterval, 60 * 60 * 1000);
            assert.equal(callbackRuns, 2);
            await new Promise((resolve) => setTimeout(resolve, 100));
        } finally {
            stopOpenClawNotificationMonitorForTest();
            stopOpenClawNotificationMonitorForTest();
            globalThis.setInterval = originalSetInterval;
        }
    });
});
