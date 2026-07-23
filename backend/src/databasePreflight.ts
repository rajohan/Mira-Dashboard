import { Database } from "bun:sqlite";

import {
    assertMiraDatabasePathSafeForEnvironment,
    enableRequiredWalJournalMode,
    getMiraDatabasePath,
} from "./database.ts";
import {
    migrateDisposableDatabaseCopy,
    validateDatabaseMigrationHistory,
} from "./databaseMigrationRunner.ts";
import { secureSqliteFilePermissions } from "./databaseStorage.ts";
import { createVerifiedSqliteBackup, pruneSqliteBackups } from "./sqliteBackup.ts";

export async function runDatabasePreflight() {
    const databasePath = getMiraDatabasePath();
    assertMiraDatabasePathSafeForEnvironment(databasePath);
    secureSqliteFilePermissions(databasePath);
    const databaseFile = Bun.file(databasePath);
    const databaseExists = await databaseFile.exists();
    const databaseStat = databaseExists ? await databaseFile.stat() : undefined;
    if (!databaseStat || databaseStat.size === 0) {
        throw new Error(`Dashboard SQLite database does not exist: ${databasePath}`);
    }

    const sourceDatabase = new Database(databasePath);
    try {
        sourceDatabase.run("PRAGMA busy_timeout = 5000");
        const journalMode = sourceDatabase.query("PRAGMA journal_mode").get() as {
            journal_mode?: unknown;
        };
        if (
            typeof journalMode.journal_mode !== "string" ||
            journalMode.journal_mode.toLowerCase() !== "wal"
        ) {
            throw new Error(
                `Dashboard SQLite preflight requires WAL mode; got ${String(journalMode.journal_mode)}`
            );
        }
        validateDatabaseMigrationHistory(sourceDatabase);
        let testedMigrationVersions: number[] = [];
        let testedSchemaVersion = 0;
        const backup = createVerifiedSqliteBackup(
            sourceDatabase,
            databasePath,
            "pre-deploy",
            {
                exerciseRestore: (restoredDatabase) => {
                    restoredDatabase.run("PRAGMA foreign_keys = ON");
                    restoredDatabase.run("PRAGMA busy_timeout = 5000");
                    enableRequiredWalJournalMode(
                        restoredDatabase,
                        "disposable restore copy"
                    );
                    testedMigrationVersions =
                        migrateDisposableDatabaseCopy(restoredDatabase).applied;
                    testedSchemaVersion =
                        validateDatabaseMigrationHistory(restoredDatabase);
                },
                validateRestore: validateDatabaseMigrationHistory,
            }
        );
        const retention = pruneSqliteBackups(databasePath);
        secureSqliteFilePermissions(databasePath);
        return {
            backup,
            migrationTest: {
                applied: testedMigrationVersions,
                currentVersion: testedSchemaVersion,
            },
            retention,
        };
    } finally {
        sourceDatabase.close();
    }
}

if (import.meta.main) {
    console.log(JSON.stringify(await runDatabasePreflight()));
}
