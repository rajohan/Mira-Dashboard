import { type Database } from "bun:sqlite";

import { database, getMiraDatabasePath } from "../database.ts";
import { validateDatabaseMigrationHistory } from "../databaseMigrationRunner.ts";
import { createVerifiedSqliteBackup, pruneSqliteBackups } from "../sqliteBackup.ts";
import {
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    upsertScheduledJob,
} from "./scheduledJobs.ts";

export const SQLITE_MAINTENANCE_JOB_ID = "database.maintenance";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const SQLITE_MAINTENANCE_TIMEOUT_MS = 15 * 60 * 1000;

function retentionCutoff(now: Date, days: number): string {
    return new Date(now.getTime() - days * MILLISECONDS_PER_DAY).toISOString();
}

export function pruneDatabaseHistory(databaseConnection: Database, now: Date) {
    const changes = {
        agentTaskHistory: 0,
        authSessions: 0,
        deploymentJobs: 0,
        dockerUpdateEvents: 0,
        jobExecutions: 0,
        jobWorkers: 0,
        reports: 0,
        scheduledJobRuns: 0,
    };

    databaseConnection.run("BEGIN IMMEDIATE");
    try {
        changes.authSessions = databaseConnection
            .prepare("DELETE FROM auth_sessions WHERE expires_at <= ?")
            .run(now.toISOString()).changes;
        changes.jobExecutions = databaseConnection
            .prepare(
                `DELETE FROM job_executions
                 WHERE finished_at IS NOT NULL
                   AND status IN ('success', 'failed', 'cancelled')
                   AND (
                       finished_at < ?
                       OR id IN (
                           SELECT id
                           FROM job_executions
                           WHERE finished_at IS NOT NULL
                             AND status IN ('success', 'failed', 'cancelled')
                           ORDER BY finished_at DESC, id DESC
                           LIMIT -1 OFFSET 20000
                       )
                   )`
            )
            .run(retentionCutoff(now, 90)).changes;
        changes.scheduledJobRuns = databaseConnection
            .prepare(
                `DELETE FROM scheduled_job_runs
                 WHERE finished_at IS NOT NULL
                   AND status IN ('success', 'failed', 'cancelled')
                   AND (
                       finished_at < ?
                       OR id IN (
                           SELECT id
                           FROM scheduled_job_runs
                           WHERE finished_at IS NOT NULL
                             AND status IN ('success', 'failed', 'cancelled')
                           ORDER BY finished_at DESC, id DESC
                           LIMIT -1 OFFSET 20000
                       )
                   )`
            )
            .run(retentionCutoff(now, 90)).changes;
        changes.deploymentJobs = databaseConnection
            .prepare(
                `DELETE FROM deployment_jobs
                 WHERE status NOT IN ('building', 'restart-scheduled')
                   AND (
                       started_at < ?
                       OR id IN (
                           SELECT id
                           FROM deployment_jobs
                           WHERE status NOT IN ('building', 'restart-scheduled')
                           ORDER BY started_at DESC, id DESC
                           LIMIT -1 OFFSET 500
                       )
                   )`
            )
            .run(retentionCutoff(now, 90)).changes;
        changes.agentTaskHistory = databaseConnection
            .prepare(
                `DELETE FROM agent_task_history
                 WHERE status != 'active'
                   AND completed_at IS NOT NULL
                   AND (
                       completed_at < ?
                       OR id IN (
                           SELECT id
                           FROM agent_task_history
                           WHERE status != 'active' AND completed_at IS NOT NULL
                           ORDER BY completed_at DESC, id DESC
                           LIMIT -1 OFFSET 10000
                       )
                   )`
            )
            .run(retentionCutoff(now, 90)).changes;
        changes.reports = databaseConnection
            .prepare(
                `DELETE FROM reports
                 WHERE occurred_at < ?
                    OR id IN (
                        SELECT id
                        FROM reports
                        ORDER BY occurred_at DESC, id DESC
                        LIMIT -1 OFFSET 5000
                    )`
            )
            .run(retentionCutoff(now, 365)).changes;
        changes.dockerUpdateEvents = databaseConnection
            .prepare(
                `DELETE FROM docker_update_events
                 WHERE created_at < ?
                    OR id IN (
                        SELECT id
                        FROM docker_update_events
                        ORDER BY created_at DESC, id DESC
                        LIMIT -1 OFFSET 5000
                    )`
            )
            .run(retentionCutoff(now, 180)).changes;
        changes.jobWorkers = databaseConnection
            .prepare("DELETE FROM job_workers WHERE heartbeat_at < ?")
            .run(retentionCutoff(now, 7)).changes;
        databaseConnection.run("COMMIT");
    } catch (error) {
        try {
            databaseConnection.run("ROLLBACK");
        } catch {
            // Preserve the retention error.
        }
        throw error;
    }
    return changes;
}

function sqlitePageMetrics() {
    const pageCount = database.query("PRAGMA page_count").get() as {
        page_count: number;
    };
    const freePages = database.query("PRAGMA freelist_count").get() as {
        freelist_count: number;
    };
    const pageSize = database.query("PRAGMA page_size").get() as {
        page_size: number;
    };
    return {
        freeBytes: freePages.freelist_count * pageSize.page_size,
        freePages: freePages.freelist_count,
        pageCount: pageCount.page_count,
        pageSize: pageSize.page_size,
    };
}

function passiveWalCheckpoint() {
    return database.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
        busy: number;
        checkpointed: number;
        log: number;
    };
}

export function runSqliteMaintenance(now = new Date()) {
    const databasePath = getMiraDatabasePath();
    const before = sqlitePageMetrics();
    const backup = createVerifiedSqliteBackup(database, databasePath, "scheduled", {
        createdAt: now,
        validateRestore: validateDatabaseMigrationHistory,
    });
    const prunedRows = pruneDatabaseHistory(database, now);
    database.run("PRAGMA optimize");
    const checkpoint = passiveWalCheckpoint();
    const after = sqlitePageMetrics();
    const backupRetention = pruneSqliteBackups(databasePath, now);

    return {
        after,
        backup,
        backupRetention,
        before,
        checkpoint,
        finishedAt: new Date().toISOString(),
        prunedRows,
    };
}

export function registerSqliteMaintenanceScheduledJob(): void {
    registerScheduledJobAction(
        SQLITE_MAINTENANCE_JOB_ID,
        (_job, _signal, context) => {
            context.protectFromCancellation();
            return Promise.resolve(runSqliteMaintenance());
        },
        { timeoutMs: SQLITE_MAINTENANCE_TIMEOUT_MS }
    );

    database.run("BEGIN IMMEDIATE");
    try {
        removeScheduledJobsNotInAction(SQLITE_MAINTENANCE_JOB_ID, [
            SQLITE_MAINTENANCE_JOB_ID,
        ]);
        const existing = getScheduledJob(SQLITE_MAINTENANCE_JOB_ID);
        upsertScheduledJob({
            id: SQLITE_MAINTENANCE_JOB_ID,
            name: "Dashboard SQLite maintenance",
            description:
                "Create and restore-verify a WAL-safe SQLite backup, prune bounded history, optimize, and checkpoint WAL.",
            enabled: existing?.enabled ?? true,
            scheduleType: existing?.scheduleType ?? "daily",
            intervalSeconds: existing?.intervalSeconds ?? 24 * 60 * 60,
            timeOfDay: existing ? existing.timeOfDay : "02:40",
            cronExpression: existing?.cronExpression ?? undefined,
            actionKey: SQLITE_MAINTENANCE_JOB_ID,
            actionPayload: {},
            resourceClass: "host-heavy",
            timeoutMs: SQLITE_MAINTENANCE_TIMEOUT_MS,
        });
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the registration error.
        }
        throw error;
    }
}
