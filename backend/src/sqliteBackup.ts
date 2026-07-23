import fs from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import { secureDirectory, sqliteBackupDirectory } from "./databaseStorage.ts";

export type SqliteBackupKind = "pre-deploy" | "pre-migration" | "scheduled";

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

const BACKUP_FILE_PATTERN =
    /^mira-dashboard-(pre-deploy|pre-migration|scheduled)-\d{8}T\d{9}Z-\d+-[a-f0-9]{8}\.db$/u;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export const SQLITE_BACKUP_RETENTION: Readonly<
    Record<SqliteBackupKind, BackupRetentionPolicy>
> = {
    "pre-deploy": { maxAgeDays: 90, maxCount: 20 },
    "pre-migration": { maxAgeDays: 180, maxCount: 20 },
    scheduled: { maxAgeDays: 14, maxCount: 14 },
};

function timestampForFilename(date: Date): string {
    return date.toISOString().replaceAll(/[-:.]/gu, "");
}

function backupFilename(kind: SqliteBackupKind, createdAt: Date): string {
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
    kind: SqliteBackupKind,
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

    try {
        sourceDatabase.prepare("VACUUM INTO ?").run(targetPath);
        fs.chmodSync(targetPath, 0o600);
        verifyRestoredCopy(
            targetPath,
            backupDirectory,
            options.validateRestore,
            options.exerciseRestore
        );
        return {
            bytes: fs.statSync(targetPath).size,
            createdAt: createdAt.toISOString(),
            kind,
            path: targetPath,
            restoreVerified: true,
        };
    } catch (error) {
        try {
            fs.rmSync(targetPath, { force: true });
        } catch {
            // Preserve the backup or verification error.
        }
        throw error;
    }
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
        .filter((entry) => entry.isFile() && BACKUP_FILE_PATTERN.test(entry.name))
        .map((entry) => {
            const filePath = path.join(backupDirectory, entry.name);
            const kind = entry.name.match(BACKUP_FILE_PATTERN)?.[1] as
                SqliteBackupKind | undefined;
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
