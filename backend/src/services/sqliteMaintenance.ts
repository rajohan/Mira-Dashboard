import { database, getMiraDatabasePath } from "../database/connection.ts";
import { validateDatabaseMigrationHistory } from "../database/migrationRunner.ts";
import { createVerifiedSqliteBackup } from "../database/sqliteBackup/creation.ts";
import { pruneSqliteBackups } from "../database/sqliteBackup/retention.ts";
import { errorMessage } from "../lib/errors.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { readDashboardReleaseState } from "./releases/releaseActivation.ts";
import { resolveDashboardReleasesRoot } from "./releases/releaseLayout.ts";
import { registerScheduledJobAction } from "./scheduledJobs/actionRegistry.ts";
import {
    getScheduledJob,
    removeScheduledJobsNotInAction,
    upsertScheduledJob,
} from "./scheduledJobs/repository.ts";
import { pruneDatabaseHistory } from "./sqliteMaintenance/databaseHistoryRetention.ts";

export const SQLITE_MAINTENANCE_JOB_ID = "database.maintenance";
const logger = createStructuredLogger("sqlite-maintenance");

const SQLITE_MAINTENANCE_TIMEOUT_MS = 15 * 60 * 1000;

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
