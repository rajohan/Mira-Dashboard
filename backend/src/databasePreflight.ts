import { Database } from "bun:sqlite";

import {
    assertMiraDatabasePathSafeForEnvironment,
    getMiraDatabasePath,
} from "./database.ts";
import { validateDatabaseMigrationHistory } from "./databaseMigrationRunner.ts";
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
        const backup = createVerifiedSqliteBackup(
            sourceDatabase,
            databasePath,
            "pre-deploy",
            { validateRestore: validateDatabaseMigrationHistory }
        );
        const retention = pruneSqliteBackups(databasePath);
        secureSqliteFilePermissions(databasePath);
        return { backup, retention };
    } finally {
        sourceDatabase.close();
    }
}

if (import.meta.main) {
    console.log(JSON.stringify(await runDatabasePreflight()));
}
