import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import { secureDirectory, sqliteBackupDirectory } from "../storage.ts";
import {
    cutoverSnapshotPath,
    type RestoreValidator,
    type SqliteBackupResult,
} from "./model.ts";
import {
    assertRealRegularFile,
    quickCheck,
    syncDirectory,
    syncFile,
    verifyRestoredCopy,
} from "./verification.ts";

function removeSqliteSidecar(filePath: string): void {
    try {
        assertRealRegularFile(filePath, "SQLite sidecar");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
        }
        throw error;
    }
    fs.unlinkSync(filePath);
}

/**
 * Atomically replaces a stopped live SQLite database with its exact cutover
 * snapshot. The source snapshot remains available until explicitly discarded.
 * @param databasePath Database path value.
 * @param snapshotId Snapshot identifier.
 * @param options Operation options.
 * @returns Restore verified sqlite cutover snapshot result.
 */
export function restoreVerifiedSqliteCutoverSnapshot(
    databasePath: string,
    snapshotId: string,
    options: { validateRestore?: RestoreValidator } = {}
): SqliteBackupResult {
    const snapshot = verifySqliteCutoverSnapshot(databasePath, snapshotId, options);
    const snapshotPath = snapshot.path;
    const snapshotStat = fs.lstatSync(snapshotPath);

    assertRealRegularFile(databasePath, "Live SQLite database");
    const liveDatabase = new Database(databasePath);
    try {
        liveDatabase.run("PRAGMA busy_timeout = 5000");
        const checkpoint = liveDatabase
            .query("PRAGMA wal_checkpoint(TRUNCATE)")
            .get() as { busy?: unknown };
        if (checkpoint.busy !== 0) {
            throw new Error("SQLite cutover restore requires every writer to be stopped");
        }
    } finally {
        liveDatabase.close();
    }

    const databaseDirectory = path.dirname(databasePath);
    secureDirectory(databaseDirectory);
    const temporaryPath = path.join(
        databaseDirectory,
        `.mira-dashboard-cutover-restore-${Bun.randomUUIDv7()}.db`
    );
    try {
        fs.copyFileSync(snapshotPath, temporaryPath, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(temporaryPath, 0o600);
        const restoredDatabase = new Database(temporaryPath, { readonly: true });
        try {
            restoredDatabase.run("PRAGMA query_only = ON");
            quickCheck(restoredDatabase);
            options.validateRestore?.(restoredDatabase);
        } finally {
            restoredDatabase.close();
        }
        syncFile(temporaryPath);
        removeSqliteSidecar(`${databasePath}-wal`);
        removeSqliteSidecar(`${databasePath}-shm`);
        fs.renameSync(temporaryPath, databasePath);
        syncDirectory(databaseDirectory);
        fs.chmodSync(databasePath, 0o600);
    } catch (error) {
        try {
            fs.rmSync(temporaryPath, { force: true });
        } catch {
            // Preserve the restore error.
        }
        throw error;
    }

    return {
        bytes: snapshotStat.size,
        createdAt: snapshotStat.mtime.toISOString(),
        kind: "cutover",
        path: snapshotPath,
        restoreVerified: true,
    };
}

/**
 * Revalidates the exact snapshot referenced by a guarded release cutover.
 * @param databasePath Database path value.
 * @param snapshotId Snapshot identifier.
 * @param options Operation options.
 * @returns Verify sqlite cutover snapshot result.
 */
export function verifySqliteCutoverSnapshot(
    databasePath: string,
    snapshotId: string,
    options: { validateRestore?: RestoreValidator } = {}
): SqliteBackupResult {
    const backupDirectory = sqliteBackupDirectory(databasePath);
    const backupDirectoryStat = fs.lstatSync(backupDirectory);
    if (backupDirectoryStat.isSymbolicLink() || !backupDirectoryStat.isDirectory()) {
        throw new Error("SQLite backup directory must be a real directory");
    }
    const snapshotPath = cutoverSnapshotPath(databasePath, snapshotId);
    const snapshotStat = assertRealRegularFile(snapshotPath, "SQLite cutover snapshot");
    verifyRestoredCopy(snapshotPath, backupDirectory, options.validateRestore);

    return {
        bytes: snapshotStat.size,
        createdAt: snapshotStat.mtime.toISOString(),
        kind: "cutover",
        path: snapshotPath,
        restoreVerified: true,
    };
}

/**
 * Removes only the exact snapshot named by a validated cutover UUID.
 * @param databasePath Database path value.
 * @param snapshotId Snapshot identifier.
 * @returns Did discard sqlite cutover snapshot result.
 */
export function didDiscardSqliteCutoverSnapshot(
    databasePath: string,
    snapshotId: string
): boolean {
    const snapshotPath = cutoverSnapshotPath(databasePath, snapshotId);
    let snapshotStat: fs.Stats;
    try {
        snapshotStat = fs.lstatSync(snapshotPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
        }
        throw error;
    }
    if (
        snapshotStat.isSymbolicLink() ||
        !snapshotStat.isFile() ||
        snapshotStat.nlink !== 1
    ) {
        throw new Error("SQLite cutover snapshot must be a real single-link file");
    }
    fs.unlinkSync(snapshotPath);
    syncDirectory(path.dirname(snapshotPath));
    return true;
}
