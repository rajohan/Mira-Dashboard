import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database, type SQLQueryBindings } from "bun:sqlite";

import { applyDatabaseMigrations } from "./databaseMigrationRunner.ts";
import {
    prepareDatabaseStorage,
    secureSqliteFilePermissions,
} from "./databaseStorage.ts";

type DatabaseSync = Database;

const SQLITE_NULL = JSON.parse("null") as SQLQueryBindings;

/** Converts optional values to SQLite NULL-compatible bindings. */
export function sqlNullable(value: SQLQueryBindings | undefined): SQLQueryBindings {
    return value === undefined ? SQLITE_NULL : value;
}

function resolveDatabasePath(): {
    configuredDatabasePath: string | undefined;
    databasePath: string;
} {
    const configuredDatabasePath = process.env.MIRA_DASHBOARD_DB_PATH?.trim();
    return {
        configuredDatabasePath,
        databasePath: configuredDatabasePath
            ? path.resolve(configuredDatabasePath)
            : path.join(process.cwd(), "data", "mira-dashboard.db"),
    };
}

export function getMiraDatabasePath(): string {
    return resolveDatabasePath().databasePath;
}

export const miraDatabasePath = getMiraDatabasePath();

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
    const relativePath = path.relative(rootPath, candidatePath);
    return (
        relativePath === "" ||
        (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
    );
}

function findExistingParent(directoryPath: string): string {
    let currentPath = directoryPath;
    while (!fs.existsSync(currentPath)) {
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            return currentPath;
        }
        currentPath = parentPath;
    }
    return currentPath;
}

function assertTestDatabasePath(
    databasePath: string,
    configuredDatabasePath: string | undefined
): void {
    if (process.env.NODE_ENV !== "test") {
        return;
    }
    const configuredTemporaryRoot = path.resolve(os.tmpdir());
    const realTemporaryRoot = fs.realpathSync(configuredTemporaryRoot);
    const databaseParent = path.dirname(databasePath);
    if (
        !configuredDatabasePath ||
        (!isPathWithinRoot(databasePath, configuredTemporaryRoot) &&
            !isPathWithinRoot(databasePath, realTemporaryRoot))
    ) {
        throw new Error(
            `Refusing to open non-temporary Dashboard test database: ${databasePath}`
        );
    }
    const existingDatabaseParent = findExistingParent(databaseParent);
    if (fs.lstatSync(existingDatabaseParent).isSymbolicLink()) {
        throw new Error(
            `Refusing to open symlinked Dashboard test database: ${databasePath}`
        );
    }
    const realExistingDatabaseParent = fs.realpathSync(existingDatabaseParent);
    if (!isPathWithinRoot(realExistingDatabaseParent, realTemporaryRoot)) {
        throw new Error(
            `Refusing to open symlinked Dashboard test database: ${databasePath}`
        );
    }
    fs.mkdirSync(databaseParent, { recursive: true });
    const realDatabaseParent = fs.realpathSync(databaseParent);
    let existingDatabaseStat: fs.Stats | undefined;
    try {
        existingDatabaseStat = fs.lstatSync(databasePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
    if (
        !isPathWithinRoot(realDatabaseParent, realTemporaryRoot) ||
        existingDatabaseStat?.isSymbolicLink() === true
    ) {
        throw new Error(
            `Refusing to open symlinked Dashboard test database: ${databasePath}`
        );
    }
}

/** Prevents test-mode code paths from touching a database outside an isolated temp root. */
export function assertMiraDatabasePathSafeForEnvironment(databasePath: string): void {
    const { configuredDatabasePath } = resolveDatabasePath();
    assertTestDatabasePath(databasePath, configuredDatabasePath);
}

export function enableRequiredWalJournalMode(
    databaseConnection: DatabaseSync,
    databasePath: string
): void {
    let journalModeRow: { journal_mode?: unknown } | null;
    try {
        journalModeRow = databaseConnection.query("PRAGMA journal_mode = WAL").get() as {
            journal_mode?: unknown;
        } | null;
    } catch (error) {
        try {
            databaseConnection.close();
        } catch {
            // Preserve the original SQLite error.
        }
        throw error;
    }
    const journalMode =
        typeof journalModeRow?.journal_mode === "string"
            ? journalModeRow.journal_mode
            : undefined;
    if (journalMode?.toLowerCase() !== "wal") {
        databaseConnection.close();
        throw new Error(
            `SQLite WAL journal mode is required for ${databasePath}; got ${journalMode ?? "unknown"}`
        );
    }
}

function initializeDatabase(databasePath: string): DatabaseSync {
    assertMiraDatabasePathSafeForEnvironment(databasePath);
    prepareDatabaseStorage(databasePath);

    const initializedDatabase = new Database(databasePath);
    try {
        initializedDatabase.run("PRAGMA foreign_keys = ON");
        initializedDatabase.run("PRAGMA busy_timeout = 5000");
        enableRequiredWalJournalMode(initializedDatabase, databasePath);
        initializedDatabase.run("PRAGMA wal_autocheckpoint = 1000");
        applyDatabaseMigrations(initializedDatabase, databasePath);
        secureSqliteFilePermissions(databasePath);
        return initializedDatabase;
    } catch (error) {
        try {
            initializedDatabase.close();
        } catch {
            // Preserve the initialization error.
        }
        throw error;
    }
}

const activeDatabaseState: {
    database: DatabaseSync | undefined;
    path: string | undefined;
} = {
    database: undefined,
    path: undefined,
};

function currentDatabase(): DatabaseSync {
    if (process.env.NODE_ENV !== "test" && activeDatabaseState.database !== undefined) {
        return activeDatabaseState.database;
    }
    const { databasePath } = resolveDatabasePath();
    if (
        activeDatabaseState.database !== undefined &&
        activeDatabaseState.path === databasePath
    ) {
        return activeDatabaseState.database;
    }
    const nextDatabase = initializeDatabase(databasePath);
    activeDatabaseState.database?.close();
    activeDatabaseState.database = nextDatabase;
    activeDatabaseState.path = databasePath;
    return activeDatabaseState.database;
}

function closeActiveDatabase(): void {
    activeDatabaseState.database?.close();
    activeDatabaseState.database = undefined;
    activeDatabaseState.path = undefined;
}

export function closeDatabaseForTests(): void {
    if (process.env.NODE_ENV !== "test") {
        throw new Error("closeDatabaseForTests can only be used in test");
    }
    closeActiveDatabase();
}

/** Defines database. */
export const database = new Proxy({} as DatabaseSync, {
    get(_target, property) {
        if (property === "close") {
            return closeActiveDatabase;
        }
        const active = currentDatabase();
        const value = Reflect.get(active, property, active);
        return typeof value === "function" ? value.bind(active) : value;
    },
});
