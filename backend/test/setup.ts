import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, jest } from "bun:test";

const preloadDatabaseRoot = mkdtempSync(
    path.join(tmpdir(), "mira-dashboard-test-preload-")
);
const originalDatabasePath = process.env.MIRA_DASHBOARD_DB_PATH;
const originalLoopbackAuth = process.env.MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH;

process.env.NODE_ENV = "test";
process.env.MIRA_DASHBOARD_DB_PATH = path.join(preloadDatabaseRoot, "dashboard.db");
process.env.MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH = "1";

afterAll(() => {
    if (originalDatabasePath === undefined) {
        delete process.env.MIRA_DASHBOARD_DB_PATH;
    } else {
        process.env.MIRA_DASHBOARD_DB_PATH = originalDatabasePath;
    }
    if (originalLoopbackAuth === undefined) {
        delete process.env.MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH;
    } else {
        process.env.MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH = originalLoopbackAuth;
    }
    rmSync(preloadDatabaseRoot, { force: true, recursive: true });
});

afterEach(() => {
    jest.restoreAllMocks();
});
