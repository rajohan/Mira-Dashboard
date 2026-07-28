import fs from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import { secureDirectory, sqliteBackupDirectory } from "./databaseStorage.ts";

export type SqliteBackupKind = "cutover" | "pre-deploy" | "pre-migration" | "scheduled";

export interface SqliteBackupResult {
    bytes: number;
    createdAt: string;
    kind: SqliteBackupKind;
    path: string;
    restoreVerified: true;
}

interface BackupRetentionPolicy {
    maxAgeDays: number;
    maxCount: number;
}

export interface SqliteBackupRetentionResult {
    removed: string[];
    retained: number;
}

export interface SqliteBackupInventory {
    count: number;
    latest?: {
        bytes: number;
        createdAt: string;
        kind: SqliteBackupKind;
        name: string;
    };
}

type RestoreValidator = (restoredDatabase: Database) => void;

const STANDARD_BACKUP_FILE_PATTERN =
    /^mira-dashboard-(pre-deploy|pre-migration|scheduled)-\d{8}T\d{9}Z-\d+-[a-f0-9]{8}\.db$/u;
const CUTOVER_SNAPSHOT_ID_PATTERN =
    /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const CUTOVER_BACKUP_FILE_PATTERN =
    /^mira-dashboard-cutover-([\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12})\.db$/u;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export const SQLITE_BACKUP_RETENTION: Readonly<
    Record<SqliteBackupKind, BackupRetentionPolicy>
> = {
    cutover: { maxAgeDays: 2, maxCount: 5 },
    "pre-deploy": { maxAgeDays: 90, maxCount: 20 },
    "pre-migration": { maxAgeDays: 180, maxCount: 20 },
    scheduled: { maxAgeDays: 14, maxCount: 14 },
};

function timestampForFilename(date: Date): string {
    return date.toISOString().replaceAll(/[-:.]/gu, "");
}

function backupFilename(
    kind: Exclude<SqliteBackupKind, "cutover">,
    createdAt: Date
): string {
    return (
        [
            "mira-dashboard",
            kind,
            timestampForFilename(createdAt),
            process.pid,
            Bun.randomUUIDv7().replaceAll("-", "").slice(-8),
        ].join("-") + ".db"
    );
}

function cutoverSnapshotFilename(snapshotId: string): string {
    if (!CUTOVER_SNAPSHOT_ID_PATTERN.test(snapshotId)) {
        throw new TypeError("SQLite cutover snapshot id must be a lowercase UUIDv7");
    }
    return `mira-dashboard-cutover-${snapshotId}.db`;
}

function cutoverSnapshotPath(databasePath: string, snapshotId: string): string {
    return path.join(
        sqliteBackupDirectory(databasePath),
        cutoverSnapshotFilename(snapshotId)
    );
}

function backupKindFromFilename(name: string): SqliteBackupKind | undefined {
    const standardKind = name.match(STANDARD_BACKUP_FILE_PATTERN)?.[1] as
        Exclude<SqliteBackupKind, "cutover"> | undefined;
    if (standardKind) {
        return standardKind;
    }
    return CUTOVER_BACKUP_FILE_PATTERN.test(name) ? "cutover" : undefined;
}

function quickCheck(database: Database): void {
    const rows = database.query("PRAGMA quick_check").all() as Array<
        Record<string, unknown>
    >;
    if (
        rows.length !== 1 ||
        Object.values(rows[0] ?? {}).every(
            (value) => typeof value !== "string" || value.toLowerCase() !== "ok"
        )
    ) {
        throw new Error(`SQLite restore verification failed: ${JSON.stringify(rows)}`);
    }
}

function verifyRestoredCopy(
    backupPath: string,
    backupDirectory: string,
    validate?: RestoreValidator,
    exercise?: RestoreValidator
): void {
    const restoreDirectory = fs.mkdtempSync(
        path.join(backupDirectory, ".restore-check-"),
        { encoding: "utf8" }
    );
    fs.chmodSync(restoreDirectory, 0o700);
    const restoredPath = path.join(restoreDirectory, "restored.db");
    try {
        fs.copyFileSync(backupPath, restoredPath, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(restoredPath, 0o600);
        const restoredDatabase = exercise
            ? new Database(restoredPath)
            : new Database(restoredPath, { readonly: true });
        try {
            if (!exercise) {
                restoredDatabase.run("PRAGMA query_only = ON");
            }
            quickCheck(restoredDatabase);
            validate?.(restoredDatabase);
            if (exercise) {
                exercise(restoredDatabase);
                quickCheck(restoredDatabase);
            }
        } finally {
            restoredDatabase.close();
        }
    } finally {
        fs.rmSync(restoreDirectory, { force: true, recursive: true });
    }
}

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
    const targetPath = path.join(backupDirectory, backupFilename(kind, createdAt));

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

function assertRealRegularFile(filePath: string, label: string): fs.Stats {
    const fileStat = fs.lstatSync(filePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.nlink !== 1) {
        throw new Error(`${label} must be a real single-link regular file`);
    }
    return fileStat;
}

function syncFile(filePath: string): void {
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function syncDirectory(directoryPath: string): void {
    const descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

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

/** Revalidates the exact snapshot referenced by a guarded release cutover. */
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

/** Removes only the exact snapshot named by a validated cutover UUID. */
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

interface RetainedBackup {
    bytes: number;
    createdAtMs: number;
    kind: SqliteBackupKind;
    path: string;
}

function retainedBackupFiles(databasePath: string): RetainedBackup[] {
    const backupDirectory = sqliteBackupDirectory(databasePath);
    if (!fs.existsSync(backupDirectory)) {
        return [];
    }
    return fs
        .readdirSync(backupDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && backupKindFromFilename(entry.name))
        .map((entry) => {
            const filePath = path.join(backupDirectory, entry.name);
            const kind = backupKindFromFilename(entry.name);
            if (!kind) {
                throw new Error(`Unexpected SQLite backup filename: ${entry.name}`);
            }
            const fileStat = fs.statSync(filePath);
            return {
                bytes: fileStat.size,
                createdAtMs: fileStat.mtimeMs,
                kind,
                path: filePath,
            };
        });
}

export function getSqliteBackupInventory(databasePath: string): SqliteBackupInventory {
    const backups = retainedBackupFiles(databasePath).toSorted(
        (left, right) => right.createdAtMs - left.createdAtMs
    );
    const latest = backups[0];
    return {
        count: backups.length,
        latest: latest
            ? {
                  bytes: latest.bytes,
                  createdAt: new Date(latest.createdAtMs).toISOString(),
                  kind: latest.kind,
                  name: path.basename(latest.path),
              }
            : undefined,
    };
}

export function pruneSqliteBackups(
    databasePath: string,
    now = new Date()
): SqliteBackupRetentionResult {
    const retainedBackups = retainedBackupFiles(databasePath);
    const removed: string[] = [];

    for (const kind of Object.keys(SQLITE_BACKUP_RETENTION) as SqliteBackupKind[]) {
        const policy = SQLITE_BACKUP_RETENTION[kind];
        const kindBackups = retainedBackups
            .filter((backup) => backup.kind === kind)
            .toSorted((left, right) => right.createdAtMs - left.createdAtMs);
        const oldestAllowed = now.getTime() - policy.maxAgeDays * MILLISECONDS_PER_DAY;
        const backupsToRemove = kindBackups.filter(
            (backup, index) =>
                index >= policy.maxCount || backup.createdAtMs < oldestAllowed
        );
        for (const backup of backupsToRemove) {
            fs.rmSync(backup.path);
            removed.push(backup.path);
        }
    }

    return {
        removed,
        retained: retainedBackups.length - removed.length,
    };
}
