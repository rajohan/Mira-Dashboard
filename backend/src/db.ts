import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const configuredDbPath = process.env.MIRA_DASHBOARD_DB_PATH?.trim();
export const miraDbPath = configuredDbPath
    ? path.resolve(configuredDbPath)
    : path.join(process.cwd(), "data", "mira-dashboard.db");
const dataDir = path.dirname(miraDbPath);
fs.mkdirSync(dataDir, { recursive: true });

/** Defines db. */
export const db = new DatabaseSync(miraDbPath);
db.exec("PRAGMA busy_timeout = 5000");

interface MigrationDatabase {
    exec(sql: string): unknown;
    prepare(sql: string): {
        all(): Array<Record<string, unknown>>;
    };
}

const TASK_AUTOMATION_COLUMN_SQL =
    "ALTER TABLE tasks ADD COLUMN automation_json TEXT NOT NULL DEFAULT '{}'";

const TASK_CHILD_TABLES = ["task_events", "task_updates", "task_dependencies"] as const;
const TASK_CHILD_TABLE_SET = new Set<string>(TASK_CHILD_TABLES);
const TASK_HISTORY_TABLES = ["task_events", "task_updates"] as const;

function validateTaskChildTableName(tableName: string): string {
    if (!TASK_CHILD_TABLE_SET.has(tableName)) {
        throw new Error(`Unsupported task child table: ${tableName}`);
    }
    return tableName;
}

function sqliteTableExists(targetDb: MigrationDatabase, tableName: string): boolean {
    const validatedTableName = validateTaskChildTableName(tableName);
    return (
        targetDb
            .prepare(
                `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${validatedTableName}'`
            )
            .all().length > 0
    );
}

export function cleanupTaskForeignKeyOrphans(targetDb: MigrationDatabase): void {
    for (const tableName of TASK_CHILD_TABLES) {
        deleteTaskOrphans(targetDb, tableName);
    }
}

function taskAutomationColumnExists(targetDb: MigrationDatabase): boolean {
    const taskColumns = targetDb.prepare("PRAGMA table_info(tasks)").all();
    return taskColumns.some((column) => column.name === "automation_json");
}

function isDuplicateColumnError(error: unknown): boolean {
    return error instanceof Error && /duplicate column name:/iu.test(error.message);
}

function assertDuplicateColumnError(error: unknown): void {
    if (!isDuplicateColumnError(error)) {
        throw error;
    }
}

function isTransientSqliteLock(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    const code = "code" in error ? String(error.code).toUpperCase() : "";
    const message = error.message;
    return (
        /\bSQLITE_(?:BUSY|LOCKED)\b/u.test(`${code} ${message.toUpperCase()}`) ||
        /database\b.*\blocked\b/iu.test(message)
    );
}

function hasNotNullEmptyTextDefault(
    column: Record<string, unknown> | undefined
): boolean {
    return (
        Boolean(column) &&
        Number(column?.notnull || 0) === 1 &&
        String(column?.dflt_value || "").trim() === "''"
    );
}

async function sleep(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sleepSync(milliseconds: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function execBlockWithTransientLockRetry<T>(operation: () => T): T {
    let lastError: unknown;
    for (const delay of [0, 10, 25, 50]) {
        if (delay > 0) {
            sleepSync(delay);
        }
        try {
            return operation();
        } catch (error) {
            lastError = error;
            if (!isTransientSqliteLock(error)) {
                throw error;
            }
        }
    }
    throw lastError;
}

function execAlterTableWithDuplicateColumnRetry(
    sql: string,
    targetDb: Pick<MigrationDatabase, "exec"> = db,
    sleepFor: (milliseconds: number) => void = sleepSync
): void {
    let lastError: unknown;
    for (const delay of [0, 10, 25, 50, 100]) {
        if (delay > 0) {
            sleepFor(delay);
        }
        try {
            targetDb.exec(sql);
            return;
        } catch (error) {
            if (!isTransientSqliteLock(error)) {
                assertDuplicateColumnError(error);
                return;
            }
            lastError = error;
        }
    }
    throw lastError;
}

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    labels_json TEXT NOT NULL DEFAULT '[]',
    automation_json TEXT NOT NULL DEFAULT '{}',
    assignee TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    author TEXT NOT NULL,
    message_md TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id INTEGER NOT NULL,
    depends_on_task_id INTEGER NOT NULL,
    PRIMARY KEY(task_id, depends_on_task_id),
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY(depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on_task_id
    ON task_dependencies(depends_on_task_id);

CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'info',
    source TEXT,
    dedupe_key TEXT UNIQUE,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_occurred_at ON notifications(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);

CREATE TABLE IF NOT EXISTS cache_entries (
    key TEXT PRIMARY KEY,
    data_json TEXT,
    source TEXT NOT NULL,
    updated_at TEXT,
    last_attempt_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS quota_alert_state (
    provider TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    is_armed INTEGER NOT NULL DEFAULT 1,
    period_key TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (provider, bucket)
);

CREATE TABLE IF NOT EXISTS openclaw_alert_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    is_armed INTEGER NOT NULL DEFAULT 1,
    last_latest TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    last_activity_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_task_history_agent_status ON agent_task_history(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_task_history_completed_at ON agent_task_history(completed_at DESC);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployment_jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    commit_sha TEXT,
    note TEXT,
    stdout TEXT,
    stderr TEXT
);

CREATE INDEX IF NOT EXISTS idx_deployment_jobs_updated_at ON deployment_jobs(updated_at DESC);

    CREATE TABLE IF NOT EXISTS deployment_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      job_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    schedule_type TEXT NOT NULL DEFAULT 'interval',
    interval_seconds INTEGER NOT NULL,
    time_of_day TEXT,
    cron_expression TEXT,
    action_type TEXT NOT NULL,
    action_target TEXT NOT NULL,
    settings_json TEXT NOT NULL DEFAULT '{}',
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_enabled_next_run
    ON scheduled_jobs(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS scheduled_job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    message TEXT,
    output_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(job_id) REFERENCES scheduled_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job_started
    ON scheduled_job_runs(job_id, started_at DESC);

CREATE TABLE IF NOT EXISTS docker_managed_services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_slug TEXT NOT NULL,
    service_name TEXT NOT NULL,
    compose_path TEXT NOT NULL,
    image_repo TEXT NOT NULL,
    compose_image_ref TEXT,
    compose_image_field TEXT,
    current_tag TEXT,
    current_digest TEXT,
    latest_tag TEXT,
    latest_digest TEXT,
    policy TEXT NOT NULL DEFAULT 'notify',
    pin_mode TEXT NOT NULL DEFAULT 'tag',
    tag_match_type TEXT NOT NULL DEFAULT 'exact',
    tag_match_pattern TEXT,
    version_group TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    last_checked_at TEXT,
    last_updated_at TEXT,
    last_status TEXT,
    UNIQUE(app_slug, service_name)
);

CREATE INDEX IF NOT EXISTS idx_docker_managed_services_enabled
    ON docker_managed_services(enabled);

CREATE TABLE IF NOT EXISTS docker_update_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    managed_service_id INTEGER,
    app_slug TEXT NOT NULL DEFAULT '',
    service_name TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    from_tag TEXT,
    to_tag TEXT,
    from_digest TEXT,
    to_digest TEXT,
    message TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY(managed_service_id) REFERENCES docker_managed_services(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_docker_update_events_created_at
    ON docker_update_events(created_at DESC);
`);

cleanupTaskForeignKeyOrphans(db);
ensureTaskHistoryCascadeSchemas(db);
ensureTaskDependenciesSchema(db);
db.exec("PRAGMA foreign_keys = ON");

for (const sql of [
    "ALTER TABLE scheduled_jobs ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'interval'",
    "ALTER TABLE scheduled_jobs ADD COLUMN time_of_day TEXT",
    "ALTER TABLE scheduled_jobs ADD COLUMN cron_expression TEXT",
]) {
    execAlterTableWithDuplicateColumnRetry(sql);
}

/** Ensures older task databases have the automation column. */
export async function ensureTaskAutomationColumn(
    targetDb: MigrationDatabase
): Promise<void> {
    try {
        if (taskAutomationColumnExists(targetDb)) {
            return;
        }
    } catch (error) {
        if (!isTransientSqliteLock(error)) {
            throw error;
        }
    }

    let lastError: unknown;

    for (const delay of [0, 10, 25, 50]) {
        if (delay > 0) {
            await sleep(delay);
        }

        try {
            targetDb.exec(TASK_AUTOMATION_COLUMN_SQL);
            return;
        } catch (error) {
            lastError = error;
            if (isDuplicateColumnError(error)) {
                return;
            }

            try {
                if (taskAutomationColumnExists(targetDb)) {
                    return;
                }
            } catch (columnError) {
                if (!isTransientSqliteLock(columnError)) {
                    throw columnError;
                }
            }

            if (!isTransientSqliteLock(error)) {
                throw error;
            }
        }
    }

    try {
        if (taskAutomationColumnExists(targetDb)) {
            return;
        }
    } catch {
        // Preserve the migration error that triggered the retry loop.
    }

    throw lastError;
}

function deleteTaskOrphans(targetDb: MigrationDatabase, tableName: string): void {
    const validatedTableName = validateTaskChildTableName(tableName);
    execBlockWithTransientLockRetry(() => {
        if (!sqliteTableExists(targetDb, validatedTableName)) {
            return;
        }
        targetDb.exec(`
            DELETE FROM ${validatedTableName}
            WHERE task_id NOT IN (SELECT id FROM tasks)
        `);
        if (validatedTableName === "task_dependencies") {
            targetDb.exec(`
                DELETE FROM ${validatedTableName}
                WHERE depends_on_task_id NOT IN (SELECT id FROM tasks)
            `);
        }
    });
}

function ensureTaskDependenciesSchema(targetDb: MigrationDatabase): void {
    let lastError: unknown;
    for (const delay of [0, 10, 25, 50]) {
        if (delay > 0) {
            sleepSync(delay);
        }

        try {
            if (!sqliteTableExists(targetDb, "task_dependencies")) {
                return;
            }
            const columns = targetDb
                .prepare("PRAGMA table_info(task_dependencies)")
                .all();
            const primaryKeyColumns = columns
                .filter((column) => Number(column.pk || 0) > 0)
                .sort((left, right) => Number(left.pk) - Number(right.pk))
                .map((column) => String(column.name));
            const foreignKeys = targetDb
                .prepare("PRAGMA foreign_key_list(task_dependencies)")
                .all();
            const hasCascadeTaskId = foreignKeys.some(
                (key) =>
                    key.from === "task_id" &&
                    key.table === "tasks" &&
                    key.to === "id" &&
                    String(key.on_delete).toUpperCase() === "CASCADE"
            );
            const hasCascadeDependsOnTaskId = foreignKeys.some(
                (key) =>
                    key.from === "depends_on_task_id" &&
                    key.table === "tasks" &&
                    key.to === "id" &&
                    String(key.on_delete).toUpperCase() === "CASCADE"
            );
            if (
                primaryKeyColumns.join(",") === "task_id,depends_on_task_id" &&
                hasCascadeTaskId &&
                hasCascadeDependsOnTaskId
            ) {
                return;
            }

            targetDb.exec(`
                BEGIN;
                ALTER TABLE task_dependencies RENAME TO task_dependencies_old;
                CREATE TABLE task_dependencies (
                    task_id INTEGER NOT NULL,
                    depends_on_task_id INTEGER NOT NULL,
                    PRIMARY KEY(task_id, depends_on_task_id),
                    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                    FOREIGN KEY(depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
                );
                INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id)
                SELECT task_id, depends_on_task_id
                FROM task_dependencies_old
                WHERE task_id IN (SELECT id FROM tasks)
                  AND depends_on_task_id IN (SELECT id FROM tasks);
                DROP TABLE task_dependencies_old;
                CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on_task_id
                    ON task_dependencies(depends_on_task_id);
                COMMIT;
            `);
            return;
        } catch (error) {
            try {
                targetDb.exec("ROLLBACK");
            } catch {
                // Preserve the migration failure that triggered rollback.
            }
            lastError = error;
            if (!isTransientSqliteLock(error)) {
                throw error;
            }
        }
    }

    throw lastError;
}

function ensureTaskHistoryCascadeSchemas(targetDb: MigrationDatabase): void {
    for (const tableName of TASK_HISTORY_TABLES) {
        ensureTaskHistoryCascadeSchema(targetDb, tableName);
    }
}

function ensureTaskHistoryCascadeSchema(
    targetDb: MigrationDatabase,
    tableName: (typeof TASK_HISTORY_TABLES)[number]
): void {
    const validatedTableName = validateTaskChildTableName(tableName);
    let lastError: unknown;
    for (const delay of [0, 10, 25, 50]) {
        if (delay > 0) {
            sleepSync(delay);
        }

        try {
            const foreignKeys = targetDb
                .prepare(`PRAGMA foreign_key_list(${validatedTableName})`)
                .all();
            const hasCascadeTaskId = foreignKeys.some(
                (key) =>
                    key.from === "task_id" &&
                    key.table === "tasks" &&
                    key.to === "id" &&
                    String(key.on_delete).toUpperCase() === "CASCADE"
            );
            if (hasCascadeTaskId) {
                return;
            }

            if (validatedTableName === "task_events") {
                targetDb.exec(`
                    BEGIN;
                    ALTER TABLE task_events RENAME TO task_events_old;
                    CREATE TABLE task_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        task_id INTEGER NOT NULL,
                        event_type TEXT NOT NULL,
                        payload_json TEXT NOT NULL DEFAULT '{}',
                        created_at TEXT NOT NULL,
                        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
                    );
                    INSERT INTO task_events (id, task_id, event_type, payload_json, created_at)
                    SELECT id, task_id, event_type, payload_json, created_at
                    FROM task_events_old
                    WHERE task_id IN (SELECT id FROM tasks);
                    DROP TABLE task_events_old;
                    COMMIT;
                `);
                return;
            }

            targetDb.exec(`
                BEGIN;
                ALTER TABLE task_updates RENAME TO task_updates_old;
                CREATE TABLE task_updates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id INTEGER NOT NULL,
                    author TEXT NOT NULL,
                    message_md TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
                );
                INSERT INTO task_updates (id, task_id, author, message_md, created_at)
                SELECT id, task_id, author, message_md, created_at
                FROM task_updates_old
                WHERE task_id IN (SELECT id FROM tasks);
                DROP TABLE task_updates_old;
                COMMIT;
            `);
            return;
        } catch (error) {
            try {
                targetDb.exec("ROLLBACK");
            } catch {
                // Preserve the migration failure that triggered rollback.
            }
            lastError = error;
            if (!isTransientSqliteLock(error)) {
                throw error;
            }
        }
    }

    throw lastError;
}

export function ensureCacheEntriesUpdatedAtNullable(targetDb: MigrationDatabase): void {
    let lastError: unknown;
    for (const delay of [0, 10, 25, 50]) {
        if (delay > 0) {
            sleepSync(delay);
        }

        try {
            const columns = targetDb.prepare("PRAGMA table_info(cache_entries)").all();
            const updatedAt = columns.find((column) => column.name === "updated_at");
            const columnNames = new Set(columns.map((column) => String(column.name)));
            const requiredColumns = [
                "data_json",
                "source",
                "last_attempt_at",
                "expires_at",
                "status",
                "error_code",
                "error_message",
                "consecutive_failures",
                "metadata_json",
            ];
            const hasExpandedSchema = requiredColumns.every((column) =>
                columnNames.has(column)
            );
            if (updatedAt && Number(updatedAt.notnull || 0) === 0 && hasExpandedSchema) {
                return;
            }
            const dataExpression = columnNames.has("data_json") ? "data_json" : "NULL";
            const sourceExpression = columnNames.has("source") ? "source" : "'legacy'";
            const updatedAtExpression = columnNames.has("updated_at")
                ? "updated_at"
                : "NULL";
            const lastAttemptExpression = columnNames.has("last_attempt_at")
                ? "last_attempt_at"
                : columnNames.has("updated_at")
                  ? "COALESCE(updated_at, datetime('now'))"
                  : "datetime('now')";
            const expiresAtExpression = columnNames.has("expires_at")
                ? "expires_at"
                : columnNames.has("updated_at")
                  ? "COALESCE(updated_at, datetime('now'))"
                  : "datetime('now')";
            const statusExpression = columnNames.has("status") ? "status" : "'fresh'";
            const errorCodeExpression = columnNames.has("error_code")
                ? "error_code"
                : "NULL";
            const errorMessageExpression = columnNames.has("error_message")
                ? "error_message"
                : "NULL";
            const consecutiveFailuresExpression = columnNames.has("consecutive_failures")
                ? "consecutive_failures"
                : "0";
            const metadataExpression = columnNames.has("metadata_json")
                ? "metadata_json"
                : "'{}'";

            targetDb.exec("BEGIN IMMEDIATE");
            targetDb.exec(`
                ALTER TABLE cache_entries RENAME TO cache_entries_old;
                CREATE TABLE cache_entries (
                    key TEXT PRIMARY KEY,
                    data_json TEXT,
                    source TEXT NOT NULL,
                    updated_at TEXT,
                    last_attempt_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    error_code TEXT,
                    error_message TEXT,
                    consecutive_failures INTEGER NOT NULL DEFAULT 0,
                    metadata_json TEXT NOT NULL DEFAULT '{}'
                );
                INSERT INTO cache_entries (
                    key, data_json, source, updated_at, last_attempt_at, expires_at,
                    status, error_code, error_message, consecutive_failures, metadata_json
                )
                SELECT
                    key,
                    ${dataExpression},
                    ${sourceExpression},
                    ${updatedAtExpression},
                    ${lastAttemptExpression},
                    ${expiresAtExpression},
                    ${statusExpression},
                    ${errorCodeExpression},
                    ${errorMessageExpression},
                    ${consecutiveFailuresExpression},
                    ${metadataExpression}
                FROM cache_entries_old;
                DROP TABLE cache_entries_old;
                CREATE INDEX IF NOT EXISTS idx_cache_entries_status ON cache_entries(status);
                CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at ON cache_entries(expires_at);
            `);
            targetDb.exec("COMMIT");
            return;
        } catch (error) {
            try {
                targetDb.exec("ROLLBACK");
            } catch {
                // Preserve the migration failure that triggered rollback.
            }
            lastError = error;
            if (!isTransientSqliteLock(error)) {
                throw error;
            }
        }
    }

    throw lastError;
}

function ensureCacheEntriesIndexes(targetDb: MigrationDatabase): void {
    targetDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_cache_entries_status ON cache_entries(status);
        CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at ON cache_entries(expires_at);
    `);
}

export function ensureDockerUpdateEventsSetNull(targetDb: MigrationDatabase): void {
    let lastError: unknown;
    for (const delay of [0, 10, 25, 50]) {
        if (delay > 0) {
            sleepSync(delay);
        }

        try {
            const columns = targetDb
                .prepare("PRAGMA table_info(docker_update_events)")
                .all();
            const managedServiceId = columns.find(
                (column) => column.name === "managed_service_id"
            );
            const appSlug = columns.find((column) => column.name === "app_slug");
            const serviceName = columns.find((column) => column.name === "service_name");
            const foreignKeys = targetDb
                .prepare("PRAGMA foreign_key_list(docker_update_events)")
                .all();
            const serviceForeignKey = foreignKeys.find(
                (foreignKey) =>
                    foreignKey.from === "managed_service_id" &&
                    foreignKey.table === "docker_managed_services"
            );
            if (
                managedServiceId &&
                Number(managedServiceId.notnull || 0) === 0 &&
                String(serviceForeignKey?.on_delete || "").toUpperCase() === "SET NULL" &&
                hasNotNullEmptyTextDefault(appSlug) &&
                hasNotNullEmptyTextDefault(serviceName)
            ) {
                return;
            }

            const oldManagedServiceId = managedServiceId
                ? "docker_update_events_old.managed_service_id"
                : "NULL";
            const oldAppSlug = appSlug
                ? "NULLIF(docker_update_events_old.app_slug, '')"
                : "NULL";
            const oldServiceName = serviceName
                ? "NULLIF(docker_update_events_old.service_name, '')"
                : "NULL";

            targetDb.exec("BEGIN IMMEDIATE");
            targetDb.exec(`
                ALTER TABLE docker_update_events RENAME TO docker_update_events_old;
                CREATE TABLE docker_update_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    managed_service_id INTEGER,
                    app_slug TEXT NOT NULL DEFAULT '',
                    service_name TEXT NOT NULL DEFAULT '',
                    event_type TEXT NOT NULL,
                    from_tag TEXT,
                    to_tag TEXT,
                    from_digest TEXT,
                    to_digest TEXT,
                    message TEXT,
                    details_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(managed_service_id) REFERENCES docker_managed_services(id) ON DELETE SET NULL
                );
                INSERT INTO docker_update_events (
                    id, managed_service_id, app_slug, service_name, event_type,
                    from_tag, to_tag, from_digest, to_digest, message, details_json,
                    created_at
                )
                SELECT
                    docker_update_events_old.id,
                    CASE
                        WHEN docker_managed_services.id IS NULL THEN NULL
                        ELSE ${oldManagedServiceId}
                    END,
                    COALESCE(
                        ${oldAppSlug},
                        docker_managed_services.app_slug,
                        ''
                    ),
                    COALESCE(
                        ${oldServiceName},
                        docker_managed_services.service_name,
                        ''
                    ),
                    docker_update_events_old.event_type,
                    docker_update_events_old.from_tag,
                    docker_update_events_old.to_tag,
                    docker_update_events_old.from_digest,
                    docker_update_events_old.to_digest,
                    docker_update_events_old.message,
                    docker_update_events_old.details_json,
                    docker_update_events_old.created_at
                FROM docker_update_events_old
                LEFT JOIN docker_managed_services
                    ON docker_managed_services.id = ${oldManagedServiceId};
                DROP TABLE docker_update_events_old;
                CREATE INDEX IF NOT EXISTS idx_docker_update_events_created_at
                    ON docker_update_events(created_at DESC);
            `);
            targetDb.exec("COMMIT");
            return;
        } catch (error) {
            try {
                targetDb.exec("ROLLBACK");
            } catch {
                // Preserve the migration failure that triggered rollback.
            }
            lastError = error;
            if (!isTransientSqliteLock(error)) {
                throw error;
            }
        }
    }

    throw lastError;
}

ensureDockerUpdateEventsSetNull(db);
ensureCacheEntriesUpdatedAtNullable(db);
ensureCacheEntriesIndexes(db);
await ensureTaskAutomationColumn(db);

export const __testing = {
    assertDuplicateColumnError,
    cleanupTaskForeignKeyOrphans,
    ensureDockerUpdateEventsSetNull,
    ensureTaskHistoryCascadeSchemas,
    ensureTaskDependenciesSchema,
    ensureCacheEntriesUpdatedAtNullable,
    ensureCacheEntriesIndexes,
    execAlterTableWithDuplicateColumnRetry,
    isDuplicateColumnError,
    validateTaskChildTableName,
};
