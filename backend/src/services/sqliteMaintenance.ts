import { type Database } from "bun:sqlite";

import { sessionIdleTtlMs } from "../auth/sessionService.ts";
import { database, getMiraDatabasePath } from "../database/connection.ts";
import { validateDatabaseMigrationHistory } from "../database/migrationRunner.ts";
import {
    createVerifiedSqliteBackup,
    pruneSqliteBackups,
} from "../database/sqliteBackup.ts";
import { errorMessage } from "../lib/errors.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import {
    DEPLOYMENT_RUNTIME_FAILURE_NOTE_PATTERNS,
    DEPLOYMENT_RUNTIME_FAILURE_NOTE_PREDICATE_SQL,
} from "./deploymentRuntimeResults.ts";
import { pruneReadNotifications } from "./notificationMaintenance.ts";
import { readDashboardReleaseState } from "./releases/managerOperations.ts";
import { resolveDashboardReleasesRoot } from "./releases/releaseLayout.ts";
import { registerScheduledJobAction } from "./scheduledJobs/actionRegistry.ts";
import {
    getScheduledJob,
    removeScheduledJobsNotInAction,
    upsertScheduledJob,
} from "./scheduledJobs/repository.ts";

export const SQLITE_MAINTENANCE_JOB_ID = "database.maintenance";
const logger = createStructuredLogger("sqlite-maintenance");

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const SQLITE_MAINTENANCE_TIMEOUT_MS = 15 * 60 * 1000;
const CHAT_RUNTIME_SNAPSHOT_RETENTION_DAYS = 30;
const MAX_CHAT_RUNTIME_SNAPSHOTS = 200;
const FULL_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;

function retentionCutoff(now: Date, days: number): string {
    return new Date(now.getTime() - days * MILLISECONDS_PER_DAY).toISOString();
}

interface DatabaseHistoryRetentionOptions {
    protectedDeploymentCommits?: readonly string[];
    pruneDeploymentJobs?: boolean;
}

function protectedDeploymentRuntimeJobIds(
    databaseConnection: Database,
    commits: readonly string[]
): string[] {
    const query = databaseConnection.prepare(
        `SELECT id
         FROM deployment_jobs
         WHERE commit_sha = ?
           AND (
               status = 'isOk'
               OR (
                   status = 'failed'
                   AND (
                       ${DEPLOYMENT_RUNTIME_FAILURE_NOTE_PREDICATE_SQL}
                   )
               )
           )
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`
    );
    return commits.flatMap((commit) => {
        const row = query.get(commit, ...DEPLOYMENT_RUNTIME_FAILURE_NOTE_PATTERNS) as
            | { id: string }
            | undefined;
        return row ? [row.id] : [];
    });
}

export function pruneDatabaseHistory(
    databaseConnection: Database,
    now: Date,
    options: DatabaseHistoryRetentionOptions = {}
) {
    const protectedDeploymentCommits = [...new Set(options.protectedDeploymentCommits)];
    if (
        protectedDeploymentCommits.some((commit) => !FULL_COMMIT_SHA_PATTERN.test(commit))
    ) {
        throw new TypeError(
            "Protected deployment runtime results require full commit SHAs"
        );
    }
    const changes = {
        agentTaskHistory: 0,
        authPendingLogins: 0,
        authRateLimitBuckets: 0,
        authSessions: 0,
        authTotpEnrollments: 0,
        authWebAuthnChallenges: 0,
        chatRuntimeSnapshotEvents: 0,
        chatRuntimeSnapshots: 0,
        deploymentJobs: 0,
        dockerUpdateEvents: 0,
        jobExecutions: 0,
        jobWorkers: 0,
        notifications: 0,
        reports: 0,
        scheduledJobRuns: 0,
        tasks: 0,
        taskEvents: 0,
        taskUpdates: 0,
    };

    databaseConnection.run("BEGIN IMMEDIATE");
    try {
        const timestamp = now.toISOString();
        const idleCutoff = new Date(now.getTime() - sessionIdleTtlMs()).toISOString();
        changes.authWebAuthnChallenges = databaseConnection
            .prepare("DELETE FROM auth_webauthn_challenges WHERE expires_at <= ?")
            .run(timestamp).changes;
        changes.authPendingLogins = databaseConnection
            .prepare("DELETE FROM auth_pending_logins WHERE expires_at <= ?")
            .run(timestamp).changes;
        changes.authRateLimitBuckets = databaseConnection
            .prepare(
                `DELETE FROM auth_rate_limit_buckets
                 WHERE updated_at <= ?
                   AND (blocked_until IS NULL OR blocked_until <= ?)`
            )
            .run(
                new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
                timestamp
            ).changes;
        changes.authTotpEnrollments = databaseConnection
            .prepare(
                `DELETE FROM user_totp_factors
                 WHERE confirmed_at IS NULL AND created_at <= ?`
            )
            .run(new Date(now.getTime() - 5 * 60_000).toISOString()).changes;
        changes.authSessions = databaseConnection
            .prepare(
                `DELETE FROM auth_sessions
                 WHERE expires_at <= ?
                    OR last_seen_at IS NULL
                    OR last_seen_at <= ?
                    OR auth_method IS NULL
                    OR authenticated_at IS NULL`
            )
            .run(timestamp, idleCutoff).changes;
        const taskHistoryCutoff = retentionCutoff(now, 365);
        changes.taskEvents = databaseConnection
            .prepare(
                `DELETE FROM task_events
                 WHERE NOT EXISTS (
                           SELECT 1 FROM tasks WHERE tasks.id = task_events.task_id
                       )
                    OR task_id IN (
                        SELECT id
                        FROM tasks
                        WHERE status = 'done' AND updated_at < ?
                    )
                    OR id IN (
                        SELECT id
                        FROM (
                            SELECT id,
                                   ROW_NUMBER() OVER (
                                       PARTITION BY task_id
                                       ORDER BY created_at DESC, id DESC
                                   ) AS retention_rank
                            FROM task_events
                        )
                        WHERE retention_rank > 5000
                    )`
            )
            .run(taskHistoryCutoff).changes;
        changes.taskUpdates = databaseConnection
            .prepare(
                `DELETE FROM task_updates
                 WHERE NOT EXISTS (
                           SELECT 1 FROM tasks WHERE tasks.id = task_updates.task_id
                       )
                    OR task_id IN (
                        SELECT id
                        FROM tasks
                        WHERE status = 'done' AND updated_at < ?
                    )
                    OR id IN (
                        SELECT id
                        FROM (
                            SELECT id,
                                   ROW_NUMBER() OVER (
                                       PARTITION BY task_id
                                       ORDER BY created_at DESC, id DESC
                                   ) AS retention_rank
                            FROM task_updates
                        )
                        WHERE retention_rank > 5000
                    )`
            )
            .run(taskHistoryCutoff).changes;
        changes.tasks = databaseConnection
            .prepare("DELETE FROM tasks WHERE status = 'done' AND updated_at < ?")
            .run(taskHistoryCutoff).changes;
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
        if (options.pruneDeploymentJobs !== false) {
            const protectedJobIds = protectedDeploymentRuntimeJobIds(
                databaseConnection,
                protectedDeploymentCommits
            );
            const protectedJobClause =
                protectedJobIds.length > 0
                    ? `AND id NOT IN (${protectedJobIds.map(() => "?").join(", ")})`
                    : "";
            changes.deploymentJobs = databaseConnection
                .prepare(
                    `DELETE FROM deployment_jobs
                     WHERE status NOT IN ('building', 'verifying')
                       ${protectedJobClause}
                       AND (
                           started_at < ?
                           OR id IN (
                               SELECT id
                               FROM deployment_jobs
                               WHERE status NOT IN ('building', 'verifying')
                               ORDER BY started_at DESC, id DESC
                               LIMIT -1 OFFSET 500
                           )
                       )`
                )
                .run(...protectedJobIds, retentionCutoff(now, 90)).changes;
        }
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
        changes.notifications += databaseConnection
            .prepare(
                `DELETE FROM notifications
                 WHERE json_extract(metadata_json, '$.reportId') IN (
                     SELECT id
                     FROM reports
                     WHERE occurred_at < ?
                        OR id IN (
                            SELECT id
                            FROM reports
                            ORDER BY occurred_at DESC, id DESC
                            LIMIT -1 OFFSET 5000
                        )
                 )`
            )
            .run(retentionCutoff(now, 365)).changes;
        changes.notifications += pruneReadNotifications(databaseConnection, now);
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
            .run(retentionCutoff(now, 1)).changes;
        changes.chatRuntimeSnapshotEvents += databaseConnection
            .prepare(
                `DELETE FROM chat_runtime_snapshot_events AS events
                 WHERE NOT EXISTS (
                     SELECT 1
                     FROM chat_runtime_snapshots AS snapshots
                     WHERE snapshots.gateway_scope = events.gateway_scope
                       AND snapshots.session_key = events.session_key
                 )`
            )
            .run().changes;
        const snapshotRetentionCutoff = retentionCutoff(
            now,
            CHAT_RUNTIME_SNAPSHOT_RETENTION_DAYS
        );
        changes.chatRuntimeSnapshotEvents += databaseConnection
            .prepare(
                `WITH ranked AS (
                     SELECT gateway_scope,
                            session_key,
                            updated_at,
                            ROW_NUMBER() OVER (
                                ORDER BY updated_at DESC,
                                         rowid DESC
                            ) AS retention_rank
                     FROM chat_runtime_snapshots
                 ),
                 doomed AS (
                     SELECT gateway_scope, session_key
                     FROM ranked
                     WHERE updated_at < ? OR retention_rank > ?
                 )
                 DELETE FROM chat_runtime_snapshot_events AS events
                 WHERE EXISTS (
                     SELECT 1
                     FROM doomed
                     WHERE doomed.gateway_scope = events.gateway_scope
                       AND doomed.session_key = events.session_key
                 )`
            )
            .run(snapshotRetentionCutoff, MAX_CHAT_RUNTIME_SNAPSHOTS).changes;
        changes.chatRuntimeSnapshots = databaseConnection
            .prepare(
                `WITH ranked AS (
                     SELECT gateway_scope,
                            session_key,
                            updated_at,
                            ROW_NUMBER() OVER (
                                ORDER BY updated_at DESC,
                                         rowid DESC
                            ) AS retention_rank
                     FROM chat_runtime_snapshots
                 ),
                 doomed AS (
                     SELECT gateway_scope, session_key
                     FROM ranked
                     WHERE updated_at < ? OR retention_rank > ?
                 )
                 DELETE FROM chat_runtime_snapshots AS snapshots
                 WHERE EXISTS (
                     SELECT 1
                     FROM doomed
                     WHERE doomed.gateway_scope = snapshots.gateway_scope
                       AND doomed.session_key = snapshots.session_key
                 )`
            )
            .run(snapshotRetentionCutoff, MAX_CHAT_RUNTIME_SNAPSHOTS).changes;
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

async function protectedDeploymentCommitsForMaintenance(): Promise<string[] | undefined> {
    try {
        const state = await readDashboardReleaseState(resolveDashboardReleasesRoot());
        return [state.current?.commitSha, state.previous?.commitSha].filter(
            (commit): commit is string => commit !== undefined
        );
    } catch (error) {
        logger.warn("sqlite_maintenance.release_status_unavailable", { error });
        return undefined;
    }
}

export async function runSqliteMaintenance(now = new Date()) {
    const databasePath = getMiraDatabasePath();
    const protectedDeploymentCommits = await protectedDeploymentCommitsForMaintenance();
    const before = sqlitePageMetrics();
    const backup = createVerifiedSqliteBackup(database, databasePath, "scheduled", {
        createdAt: now,
        validateRestore: validateDatabaseMigrationHistory,
    });
    const prunedRows = pruneDatabaseHistory(database, now, {
        ...(protectedDeploymentCommits && { protectedDeploymentCommits }),
        pruneDeploymentJobs: protectedDeploymentCommits !== undefined,
    });
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

interface SqliteMaintenanceScheduledJobOptions {
    enqueueDatabaseSummaryRefresh?: () => void;
}

export function registerSqliteMaintenanceScheduledJob(
    options: SqliteMaintenanceScheduledJobOptions = {}
): void {
    registerScheduledJobAction(
        SQLITE_MAINTENANCE_JOB_ID,
        async (_job, _signal, context) => {
            context.protectFromCancellation();
            const result = await runSqliteMaintenance();
            if (!options.enqueueDatabaseSummaryRefresh) {
                return result;
            }
            try {
                options.enqueueDatabaseSummaryRefresh();
                return {
                    ...result,
                    cacheRefresh: { status: "queued" },
                };
            } catch (error) {
                const message = errorMessage(
                    error,
                    "Database summary cache refresh enqueue failed"
                );
                logger.warn("sqlite_maintenance.summary_refresh_enqueue_failed", {
                    error,
                });
                return {
                    ...result,
                    cacheRefresh: {
                        message,
                        status: "failed",
                    },
                };
            }
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
