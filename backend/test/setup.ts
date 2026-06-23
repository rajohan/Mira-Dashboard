import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, jest } from "bun:test";

const preloadDatabaseRoot = mkdtempSync(
    path.join(tmpdir(), "mira-dashboard-test-preload-")
);

process.env.NODE_ENV = "test";
process.env.MIRA_DASHBOARD_DB_PATH ??= path.join(preloadDatabaseRoot, "dashboard.db");
process.env.MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH ??= "1";

afterAll(() => {
    rmSync(preloadDatabaseRoot, { force: true, recursive: true });
});

afterEach(() => {
    jest.restoreAllMocks();
});
