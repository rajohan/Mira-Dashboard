import { Database, type SQLQueryBindings } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyDatabaseMigrations } from "./databaseMigrationRunner.ts";
import {
    prepareDatabaseStorage,
    secureSqliteFilePermissions,
} from "./databaseStorage.ts";
import {
    resolveDashboardProjectPathsForRuntime,
    resolveDashboardRuntimePath,
} from "./lib/dashboardPaths.ts";
import { recordDatabaseOperation } from "./lib/databaseMetrics.ts";

type DatabaseSync = Database;

const SQLITE_BUSY_TIMEOUT_MS = 5000;
const SQLITE_JOURNAL_MODE_RETRY_DELAY_MS = 25;
const TEST_FILE_ARGUMENT_PATTERN = /(?:^|[\\/])[^\\/]+\.test\.[cm]?[jt]sx?$/u;

/**
 * Detects a Dashboard test process independently of mutable application mode.
 * A test may exercise production policy by changing NODE_ENV, but that must
 * never disable the database isolation boundary for the surrounding process.
 * @returns Whether the current process is executing a Dashboard test file.
 */
export function isDashboardTestProcess(
    environment: NodeJS.ProcessEnv = process.env,
    arguments_: readonly string[] = process.argv
): boolean {
    return (
        environment.NODE_ENV === "test" ||
        arguments_.some((argument) => TEST_FILE_ARGUMENT_PATTERN.test(argument))
    );
}

/**
 * Converts optional values to SQLite NULL-compatible bindings.
 * @returns Converted optional values to SQLite NULL-compatible bindings.
 */
export function sqlNullable(value?: SQLQueryBindings): SQLQueryBindings {
    return value === undefined ? null : value;
}

function resolveDatabasePath(): {
    configuredDatabasePath: string | undefined;
    databasePath: string;
} {
    const isTestProcess = isDashboardTestProcess();
    const projectPaths = isTestProcess
        ? undefined
        : resolveDashboardProjectPathsForRuntime();
    const configuredDatabasePath = isTestProcess
        ? process.env.MIRA_DASHBOARD_DB_PATH?.trim() || undefined
        : resolveDashboardRuntimePath(
              projectPaths?.productionDatabasePath,
              process.env.MIRA_DASHBOARD_DB_PATH
          );
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
    if (!isDashboardTestProcess()) {
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

/**
 * Prevents test-mode code paths from touching a database outside an isolated temp root.
 * @param databasePath Database path value.
 */
export function assertMiraDatabasePathSafeForEnvironment(databasePath: string): void {
    const { configuredDatabasePath } = resolveDatabasePath();
    assertTestDatabasePath(databasePath, configuredDatabasePath);
}

function sqliteJournalMode(
    databaseConnection: DatabaseSync,
    statement: "PRAGMA journal_mode" | "PRAGMA journal_mode = WAL"
): string | undefined {
    const row = databaseConnection.query(statement).get() as {
        journal_mode?: unknown;
    } | null;
    return typeof row?.journal_mode === "string" ? row.journal_mode : undefined;
}

function isSqliteLockContention(error: unknown): boolean {
    if (typeof error !== "object" || error === null) {
        return false;
    }
    const code: unknown = Reflect.get(error, "code");
    return (
        typeof code === "string" &&
        (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
    );
}

export function enableRequiredWalJournalMode(
    databaseConnection: DatabaseSync,
    databasePath: string
): void {
    const retryDeadline = Date.now() + SQLITE_BUSY_TIMEOUT_MS;
    while (true) {
        try {
            const currentJournalMode = sqliteJournalMode(
                databaseConnection,
                "PRAGMA journal_mode"
            );
            const journalMode =
                currentJournalMode?.toLowerCase() === "wal"
                    ? currentJournalMode
                    : sqliteJournalMode(databaseConnection, "PRAGMA journal_mode = WAL");
            if (journalMode?.toLowerCase() !== "wal") {
                throw new Error(
                    `SQLite WAL journal mode is required for ${databasePath}; got ${journalMode ?? "unknown"}`
                );
            }
            return;
        } catch (error) {
            if (isSqliteLockContention(error) && Date.now() < retryDeadline) {
                Bun.sleepSync(SQLITE_JOURNAL_MODE_RETRY_DELAY_MS);
                continue;
            }
            try {
                databaseConnection.close();
            } catch {
                // Preserve the original SQLite error.
            }
            throw error;
        }
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

const instrumentedStatements = new WeakMap<object, object>();
const measuredStatementMethods = new Set(["all", "get", "run", "values"]);
type UnknownDatabaseMethod = (this: object, ...arguments_: unknown[]) => unknown;

function measuredDatabaseOperation<T>(operation: () => T): T {
    const startedAt = performance.now();
    try {
        const result = operation();
        recordDatabaseOperation(performance.now() - startedAt);
        return result;
    } catch (error) {
        recordDatabaseOperation(performance.now() - startedAt, error);
        throw error;
    }
}

function instrumentStatement<T extends object>(statement: T): T {
    const cached = instrumentedStatements.get(statement);
    if (cached) return cached as T;
    const instrumented = new Proxy(statement, {
        get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== "function") {
                return value;
            }
            const method = value as UnknownDatabaseMethod;
            if (typeof property === "string" && measuredStatementMethods.has(property)) {
                return (...arguments_: unknown[]) =>
                    measuredDatabaseOperation(() =>
                        Reflect.apply(method, target, arguments_)
                    );
            }
            return (...arguments_: unknown[]) =>
                Reflect.apply(method, target, arguments_);
        },
    });
    instrumentedStatements.set(statement, instrumented);
    return instrumented;
}

function currentDatabase(): DatabaseSync {
    if (!isDashboardTestProcess() && activeDatabaseState.database !== undefined) {
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
    if (!isDashboardTestProcess()) {
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
        const value: unknown = Reflect.get(active, property, active);
        if (typeof value !== "function") return value;
        const method = value as UnknownDatabaseMethod;
        if (property === "prepare" || property === "query") {
            return (...arguments_: unknown[]) => {
                const statement = Reflect.apply(method, active, arguments_);
                return statement !== null && typeof statement === "object"
                    ? instrumentStatement(statement)
                    : statement;
            };
        }
        if (property === "exec" || property === "run") {
            return (...arguments_: unknown[]) =>
                measuredDatabaseOperation(() =>
                    Reflect.apply(method, active, arguments_)
                );
        }
        return (...arguments_: unknown[]) => Reflect.apply(method, active, arguments_);
    },
});
