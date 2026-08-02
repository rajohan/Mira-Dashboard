import { type Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import { secureDirectory, sqliteBackupDirectory } from "../storage.ts";
import {
    cutoverSnapshotPath,
    type RestoreValidator,
    type SqliteBackupKind,
    type SqliteBackupResult,
    standardBackupFilename,
} from "./model.ts";
import {
    assertRealRegularFile,
    syncDirectory,
    syncFile,
    verifyRestoredCopy,
} from "./verification.ts";

export function createVerifiedSqliteBackup(
    sourceDatabase: Database,
    databasePath: string,
    kind: Exclude<SqliteBackupKind, "cutover">,
    options: {
        createdAt?: Date;
        exerciseRestore?: RestoreValidator;
        validateRestore?: RestoreValidator;
    } = {}
): SqliteBackupResult {
    const createdAt = options.createdAt ?? new Date();
    const backupDirectory = sqliteBackupDirectory(databasePath);
    secureDirectory(backupDirectory);
    const targetPath = path.join(
        backupDirectory,
        standardBackupFilename(kind, createdAt)
    );

    return createVerifiedSqliteBackupAtPath(
        sourceDatabase,
        targetPath,
        backupDirectory,
        kind,
        createdAt,
        options
    );
}

function createVerifiedSqliteBackupAtPath(
    sourceDatabase: Database,
    targetPath: string,
    backupDirectory: string,
    kind: SqliteBackupKind,
    createdAt: Date,
    options: {
        exerciseRestore?: RestoreValidator;
        validateRestore?: RestoreValidator;
    }
): SqliteBackupResult {
    let didCreateTarget = false;
    try {
        const descriptor = fs.openSync(targetPath, "wx", 0o600);
        didCreateTarget = true;
        fs.closeSync(descriptor);
        sourceDatabase.prepare("VACUUM INTO ?").run(targetPath);
        assertRealRegularFile(targetPath, "SQLite backup");
        fs.chmodSync(targetPath, 0o600);
        verifyRestoredCopy(
            targetPath,
            backupDirectory,
            options.validateRestore,
            options.exerciseRestore
        );
        syncFile(targetPath);
        syncDirectory(backupDirectory);
        return {
            bytes: fs.statSync(targetPath).size,
            createdAt: createdAt.toISOString(),
            kind,
            path: targetPath,
            restoreVerified: true,
        };
    } catch (error) {
        if (didCreateTarget) {
            try {
                fs.rmSync(targetPath, { force: true });
                syncDirectory(backupDirectory);
            } catch {
                // Preserve the backup or verification error.
            }
        }
        throw error;
    }
}

/**
 * Creates the exact database snapshot associated with one guarded release
 * cutover. The caller must keep every Dashboard writer stopped until this
 * function returns.
 * @returns Created the exact database snapshot associated with one guarded release cutover. The caller must keep every Dashboard writer stopped until this function returns.
 */
export function createVerifiedSqliteCutoverSnapshot(
    sourceDatabase: Database,
    databasePath: string,
    snapshotId: string,
    options: {
        createdAt?: Date;
        validateRestore?: RestoreValidator;
    } = {}
): SqliteBackupResult {
    const createdAt = options.createdAt ?? new Date();
    const backupDirectory = sqliteBackupDirectory(databasePath);
    secureDirectory(backupDirectory);
    const targetPath = cutoverSnapshotPath(databasePath, snapshotId);
    if (fs.existsSync(targetPath)) {
        throw new Error(`SQLite cutover snapshot already exists: ${snapshotId}`);
    }
    return createVerifiedSqliteBackupAtPath(
        sourceDatabase,
        targetPath,
        backupDirectory,
        "cutover",
        createdAt,
        options
    );
}
