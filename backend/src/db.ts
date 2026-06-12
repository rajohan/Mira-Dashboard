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
const SCHEDULED_JOBS_CRON_EXPRESSION_COLUMN_SQL =
    "ALTER TABLE scheduled_jobs ADD COLUMN cron_expression TEXT";

function taskAutomationColumnExists(targetDb: MigrationDatabase): boolean {
    const taskColumns = targetDb.prepare("PRAGMA table_info(tasks)").all();
    return taskColumns.some((column) => column.name === "automation_json");
}

function columnExists(
    targetDb: MigrationDatabase,
    table: string,
    columnName: string
): boolean {
    const columns = targetDb.prepare(`PRAGMA table_info(${table})`).all();
    return columns.some((column) => column.name === columnName);
}

function isDuplicateColumnError(error: unknown, columnName: string): boolean {
    return (
        error instanceof Error &&
        new RegExp(String.raw`duplicate column name:\s*${columnName}`, "u").test(
            error.message
        )
    );
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

async function sleep(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS task_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    author TEXT NOT NULL,
    message_md TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
);

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
    enabled INTEGER NOT NULL DEFAULT 0,
    schedule_type TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL DEFAULT 3600,
    time_of_day TEXT,
    cron_expression TEXT,
    action_key TEXT NOT NULL,
    action_payload_json TEXT NOT NULL DEFAULT '{}',
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
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
`);

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
            if (isDuplicateColumnError(error, "automation_json")) {
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

await ensureTaskAutomationColumn(db);

/** Ensures older scheduled job databases have the cron expression column. */
export async function ensureScheduledJobCronExpressionColumn(
    targetDb: MigrationDatabase
): Promise<void> {
    const cronExpressionColumnExists = (): boolean =>
        columnExists(targetDb, "scheduled_jobs", "cron_expression");

    try {
        if (cronExpressionColumnExists()) {
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
            targetDb.exec(SCHEDULED_JOBS_CRON_EXPRESSION_COLUMN_SQL);
            return;
        } catch (error) {
            lastError = error;
            if (isDuplicateColumnError(error, "cron_expression")) {
                return;
            }

            try {
                if (cronExpressionColumnExists()) {
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
        if (cronExpressionColumnExists()) {
            return;
        }
    } catch {
        // Preserve the migration error that triggered the retry loop.
    }

    throw lastError;
}

await ensureScheduledJobCronExpressionColumn(db);
