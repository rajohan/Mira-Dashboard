import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";

test("uses process cwd data directory when no explicit db path is configured", async () => {
    const originalCwd = process.cwd();
    const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-db-default-"));
    let db: undefined | { close(): void };

    try {
        delete process.env.MIRA_DASHBOARD_DB_PATH;
        process.chdir(tempDir);
        try {
            const result = await import(`./db.js?defaultPath=${randomUUID()}`);
            db = result.db;
            const expectedPath = path.join(
                fs.realpathSync(tempDir),
                "data",
                "mira-dashboard.db"
            );

            assert.equal(result.miraDbPath, expectedPath);
        } finally {
            db?.close();
        }
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
    let db: undefined | { close(): void };

    try {
        process.env.MIRA_DASHBOARD_DB_PATH = configuredPath;
        try {
            const result = await import(`./db.js?configuredPath=${randomUUID()}`);
            db = result.db;

            assert.equal(result.miraDbPath, configuredPath);
        } finally {
            db?.close();
        }
    } finally {
        if (originalDbPath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
        }
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("adds deployment commit title column to existing databases", async () => {
    const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-db-migration-"));
    const configuredPath = path.join(tempDir, "configured.db");
    const oldDb = new DatabaseSync(configuredPath);
    let oldDbClosed = false;
    let db: undefined | { close(): void };

    try {
        oldDb.exec(`
            CREATE TABLE deployment_jobs (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                commit_sha TEXT,
                note TEXT,
                stdout TEXT,
                stderr TEXT
            )
        `);
        oldDb.close();
        oldDbClosed = true;
        process.env.MIRA_DASHBOARD_DB_PATH = configuredPath;

        try {
            const result = await import(`./db.js?migrationPath=${randomUUID()}`);
            db = result.db;
            const columns = dbColumnNames(db as DatabaseSync, "deployment_jobs");

            assert.ok(columns.includes("commit_title"));
        } finally {
            db?.close();
        }
    } finally {
        if (originalDbPath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
        }
        if (!oldDbClosed) {
            oldDb.close();
        }
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("ignores duplicate commit title migration errors from concurrent startup", async () => {
    const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-db-duplicate-"));
    const configuredPath = path.join(tempDir, "configured.db");
    const oldDb = createOldDeploymentDatabase(configuredPath);
    const originalExec = DatabaseSync.prototype.exec;
    let db: undefined | { close(): void };

    try {
        oldDb.close();
        process.env.MIRA_DASHBOARD_DB_PATH = configuredPath;
        const execMock = mock.method(
            DatabaseSync.prototype,
            "exec",
            function exec(this: DatabaseSync, sql: string) {
                if (sql.includes("ADD COLUMN commit_title")) {
                    throw new Error("duplicate column name: commit_title");
                }

                // eslint-disable-next-line unicorn/no-this-outside-of-class
                return originalExec.call(this, sql);
            }
        );

        try {
            const result = await import(`./db.js?duplicateColumn=${randomUUID()}`);
            db = result.db;
        } finally {
            execMock.mock.restore();
            db?.close();
        }
    } finally {
        if (originalDbPath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
        }
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("rethrows unexpected commit title migration errors", async () => {
    const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-db-alter-fail-"));
    const configuredPath = path.join(tempDir, "configured.db");
    const oldDb = createOldDeploymentDatabase(configuredPath);
    const originalExec = DatabaseSync.prototype.exec;

    try {
        oldDb.close();
        process.env.MIRA_DASHBOARD_DB_PATH = configuredPath;
        const execMock = mock.method(
            DatabaseSync.prototype,
            "exec",
            function exec(this: DatabaseSync, sql: string) {
                if (sql.includes("ADD COLUMN commit_title")) {
                    throw new Error("disk is full");
                }

                // eslint-disable-next-line unicorn/no-this-outside-of-class
                return originalExec.call(this, sql);
            }
        );

        try {
            await assert.rejects(
                import(`./db.js?alterFailure=${randomUUID()}`),
                /disk is full/u
            );
        } finally {
            execMock.mock.restore();
        }
    } finally {
        if (originalDbPath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
        }
        await rm(tempDir, { recursive: true, force: true });
    }
});

function createOldDeploymentDatabase(filePath: string): DatabaseSync {
    const oldDb = new DatabaseSync(filePath);
    oldDb.exec(`
        CREATE TABLE deployment_jobs (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            commit_sha TEXT,
            note TEXT,
            stdout TEXT,
            stderr TEXT
        )
    `);
    return oldDb;
}

function dbColumnNames(db: DatabaseSync, table: string): string[] {
    return (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((column) => column.name);
}
