import fs from "node:fs";
import path from "node:path";

import { database, getMiraDatabasePath } from "../database.ts";
import { validateDatabaseMigrationHistory } from "../databaseMigrationRunner.ts";
import { databaseMigrations } from "../databaseMigrations/index.ts";
import { getSqliteBackupInventory } from "../sqliteBackup.ts";
import { SQLITE_MAINTENANCE_JOB_ID } from "./sqliteMaintenance.ts";

const SQLITE_BACKUP_REVIEW_AGE_HOURS = 48;

function fileBytes(filePath: string): number {
    try {
        return fs.statSync(filePath).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return 0;
        }
        throw error;
    }
}

function fileMode(filePath: string): string | undefined {
    try {
        return (fs.statSync(filePath).mode & 0o777).toString(8).padStart(4, "0");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

function pragmaNumber(name: "freelist_count" | "page_count" | "page_size"): number {
    const row = database.query(`PRAGMA ${name}`).get() as Record<string, number>;
    return Number(row[name] ?? 0);
}

export function getDashboardSqliteOverview() {
    const databasePath = getMiraDatabasePath();
    database.query("SELECT 1").get();
    const databaseBytes = fileBytes(databasePath);
    const walBytes = fileBytes(`${databasePath}-wal`);
    const shmBytes = fileBytes(`${databasePath}-shm`);
    const pageCount = pragmaNumber("page_count");
    const freePages = pragmaNumber("freelist_count");
    const pageSize = pragmaNumber("page_size");
    const journalMode = database.query("PRAGMA journal_mode").get() as {
        journal_mode: string;
    };
    const walAutoCheckpoint = database.query("PRAGMA wal_autocheckpoint").get() as {
        wal_autocheckpoint: number;
    };
    const foreignKeys = database.query("PRAGMA foreign_keys").get() as {
        foreign_keys: number;
    };
    const appliedMigrations = validateDatabaseMigrationHistory(database);
    const latestMigration = databaseMigrations.length;
    const backup = getSqliteBackupInventory(databasePath);
    const lastMaintenance = database
        .prepare(
            `SELECT status, started_at, finished_at, message
             FROM scheduled_job_runs
             WHERE job_id = ?
             ORDER BY started_at DESC, id DESC
             LIMIT 1`
        )
        .get(SQLITE_MAINTENANCE_JOB_ID) as
        | {
              finished_at: string | null;
              message: string | null;
              started_at: string;
              status: string;
          }
        | undefined;
    const permissions = {
        dataDirectory: fileMode(path.dirname(databasePath)),
        database: fileMode(databasePath),
        shm: fileMode(`${databasePath}-shm`),
        wal: fileMode(`${databasePath}-wal`),
    };
    const arePermissionsSecure =
        permissions.dataDirectory === "0700" &&
        permissions.database === "0600" &&
        (permissions.shm === undefined || permissions.shm === "0600") &&
        (permissions.wal === undefined || permissions.wal === "0600");
    const areMigrationsCurrent = appliedMigrations === latestMigration;
    const latestBackupAgeHours = backup.latest
        ? Math.max(
              0,
              (Date.now() - new Date(backup.latest.createdAt).getTime()) /
                  (60 * 60 * 1000)
          )
        : undefined;
    const isBackupCurrent =
        latestBackupAgeHours !== undefined &&
        latestBackupAgeHours <= SQLITE_BACKUP_REVIEW_AGE_HOURS;
    const attention: string[] = [];
    if (journalMode.journal_mode.toLowerCase() !== "wal") {
        attention.push("Journal mode is not WAL");
    }
    if (foreignKeys.foreign_keys !== 1) {
        attention.push("Foreign-key enforcement is disabled");
    }
    if (!areMigrationsCurrent) {
        attention.push("SQLite migrations are not current");
    }
    if (!arePermissionsSecure) {
        attention.push("SQLite storage permissions are not secure");
    }
    if (!backup.latest) {
        attention.push("No verified SQLite backup exists");
    } else if (!isBackupCurrent) {
        attention.push(
            `Latest verified SQLite backup is older than ${SQLITE_BACKUP_REVIEW_AGE_HOURS} hours`
        );
    }
    if (
        lastMaintenance &&
        lastMaintenance.status !== "queued" &&
        lastMaintenance.status !== "running" &&
        lastMaintenance.status !== "success"
    ) {
        attention.push(`Latest SQLite maintenance ${lastMaintenance.status}`);
    }

    return {
        attention,
        backup: {
            ...backup,
            current: isBackupCurrent,
            latestAgeHours: latestBackupAgeHours,
            reviewAgeHours: SQLITE_BACKUP_REVIEW_AGE_HOURS,
        },
        databaseBytes,
        fileName: path.basename(databasePath),
        freeBytes: freePages * pageSize,
        freePages,
        freePercent: pageCount > 0 ? (freePages / pageCount) * 100 : 0,
        foreignKeysEnabled: foreignKeys.foreign_keys === 1,
        journalMode: journalMode.journal_mode,
        lastMaintenance: lastMaintenance
            ? {
                  finishedAt: lastMaintenance.finished_at ?? undefined,
                  message: lastMaintenance.message ?? undefined,
                  startedAt: lastMaintenance.started_at,
                  status: lastMaintenance.status,
              }
            : undefined,
        migrations: {
            applied: appliedMigrations,
            current: areMigrationsCurrent,
            latest: latestMigration,
        },
        pageCount,
        pageSize,
        permissions: {
            ...permissions,
            secure: arePermissionsSecure,
        },
        shmBytes,
        status: attention.length === 0 ? ("healthy" as const) : ("review" as const),
        storageBytes: databaseBytes + walBytes + shmBytes,
        walAutoCheckpointPages: walAutoCheckpoint.wal_autocheckpoint,
        walBytes,
    };
}
