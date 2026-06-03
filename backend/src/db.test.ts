import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("uses process cwd data directory when no explicit db path is configured", async () => {
    const originalCwd = process.cwd();
    const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-db-default-"));

    try {
        delete process.env.MIRA_DASHBOARD_DB_PATH;
        process.chdir(tempDir);
        const { db, miraDbPath } = await import(`./db.js?defaultPath=${randomUUID()}`);
        const expectedPath = path.join(
            fs.realpathSync(tempDir),
            "data",
            "mira-dashboard.db"
        );

        assert.equal(miraDbPath, expectedPath);
        db.close();
    } finally {
        process.chdir(originalCwd);
        if (originalDbPath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
        }
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("uses configured db path when provided", async () => {
    const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-db-configured-"));
    const configuredPath = path.join(tempDir, "nested", "configured.db");

    try {
        process.env.MIRA_DASHBOARD_DB_PATH = configuredPath;
        const { db, miraDbPath } = await import(`./db.js?configuredPath=${randomUUID()}`);

        assert.equal(miraDbPath, configuredPath);
        db.close();
    } finally {
        if (originalDbPath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
        }
        await rm(tempDir, { recursive: true, force: true });
    }
});
