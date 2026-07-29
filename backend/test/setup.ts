import { afterAll, afterEach, jest } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetCoalescedSnapshotsForTests } from "../src/lib/coalescedSnapshot.ts";

const preloadDatabaseRoot = mkdtempSync(
    path.join(tmpdir(), "mira-dashboard-test-preload-")
);
const originalDatabasePath = process.env.MIRA_DASHBOARD_DB_PATH;
const originalAutomationCredentials = process.env.MIRA_DASHBOARD_AUTOMATION_CREDENTIALS;
const originalProjectRoot = process.env.MIRA_DASHBOARD_PROJECT_ROOT;
const originalSecretEncryptionKey = process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY;

process.env.NODE_ENV = "test";
process.env.MIRA_DASHBOARD_DB_PATH = path.join(preloadDatabaseRoot, "dashboard.db");
process.env.MIRA_DASHBOARD_PROJECT_ROOT = preloadDatabaseRoot;
process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY = new Uint8Array(32).fill(7).toBase64();
delete process.env.MIRA_DASHBOARD_AUTOMATION_CREDENTIALS;

afterAll(() => {
    if (originalDatabasePath === undefined) {
        delete process.env.MIRA_DASHBOARD_DB_PATH;
    } else {
        process.env.MIRA_DASHBOARD_DB_PATH = originalDatabasePath;
    }
    if (originalAutomationCredentials === undefined) {
        delete process.env.MIRA_DASHBOARD_AUTOMATION_CREDENTIALS;
    } else {
        process.env.MIRA_DASHBOARD_AUTOMATION_CREDENTIALS = originalAutomationCredentials;
    }
    if (originalProjectRoot === undefined) {
        delete process.env.MIRA_DASHBOARD_PROJECT_ROOT;
    } else {
        process.env.MIRA_DASHBOARD_PROJECT_ROOT = originalProjectRoot;
    }
    if (originalSecretEncryptionKey === undefined) {
        delete process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY;
    } else {
        process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY = originalSecretEncryptionKey;
    }
    rmSync(preloadDatabaseRoot, { force: true, recursive: true });
});

afterEach(() => {
    jest.restoreAllMocks();
    resetCoalescedSnapshotsForTests();
});
