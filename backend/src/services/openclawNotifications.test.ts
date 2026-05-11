import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { db } from "../db.js";

const originalPath = process.env.PATH;
const originalUpdateAvailable = process.env.FAKE_OPENCLAW_UPDATE_AVAILABLE;
const originalLatest = process.env.FAKE_OPENCLAW_LATEST;

async function installFakeDocker(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const dockerPath = path.join(binDir, "docker");
    await writeFile(
        dockerPath,
        String.raw`#!/usr/bin/env node
const updateAvailable = process.env.FAKE_OPENCLAW_UPDATE_AVAILABLE !== "false";
const latest = process.env.FAKE_OPENCLAW_LATEST || "v2026.5.99";
const data = {
  version: {
    current: "v2026.5.4",
    latest,
    updateAvailable,
    checkedAt: 1800000000000,
  },
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

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-openclaw-notifications-"));
        await installFakeDocker(tempDir);
        ({ runOpenClawNotificationCheck } = await import("./openclawNotifications.js"));
    });

    beforeEach(() => {
        db.exec("BEGIN TRANSACTION");
        process.env.FAKE_OPENCLAW_UPDATE_AVAILABLE = "true";
        process.env.FAKE_OPENCLAW_LATEST = "v2026.5.99";
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
        await rm(tempDir, { recursive: true, force: true });
    });

    it("creates one update notification per latest version and disarms repeated alerts", async () => {
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
});
