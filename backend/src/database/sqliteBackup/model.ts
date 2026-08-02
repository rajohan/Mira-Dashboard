import { type Database } from "bun:sqlite";
import path from "node:path";

import { sqliteBackupDirectory } from "../storage.ts";

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

export type RestoreValidator = (restoredDatabase: Database) => void;

const STANDARD_BACKUP_FILE_PATTERN =
    /^mira-dashboard-(pre-deploy|pre-migration|scheduled)-\d{8}T\d{9}Z-\d+-[a-f0-9]{8}\.db$/u;
const CUTOVER_SNAPSHOT_ID_PATTERN =
    /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const CUTOVER_BACKUP_FILE_PATTERN =
    /^mira-dashboard-cutover-([\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12})\.db$/u;

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

export function standardBackupFilename(
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

export function cutoverSnapshotPath(databasePath: string, snapshotId: string): string {
    return path.join(
        sqliteBackupDirectory(databasePath),
        cutoverSnapshotFilename(snapshotId)
    );
}

export function backupKindFromFilename(name: string): SqliteBackupKind | undefined {
    const standardKind = name.match(STANDARD_BACKUP_FILE_PATTERN)?.[1] as
        | Exclude<SqliteBackupKind, "cutover">
        | undefined;
    if (standardKind) {
        return standardKind;
    }
    return CUTOVER_BACKUP_FILE_PATTERN.test(name) ? "cutover" : undefined;
}
