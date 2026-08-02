import fs from "node:fs";
import path from "node:path";

import { sqliteBackupDirectory } from "../storage.ts";
import {
    backupKindFromFilename,
    SQLITE_BACKUP_RETENTION,
    type SqliteBackupInventory,
    type SqliteBackupKind,
    type SqliteBackupRetentionResult,
} from "./model.ts";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

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
