import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "mira-dashboard.db");
/** Defines db. */
export const db = new DatabaseSync(dbPath);

interface MigrationDatabase {
    exec(sql: string): unknown;
    prepare(sql: string): {
        all(): Array<Record<string, unknown>>;
    };
}

const TASK_AUTOMATION_COLUMN_SQL =
    "ALTER TABLE tasks ADD COLUMN automation_json TEXT NOT NULL DEFAULT '{}'";

function taskAutomationColumnExists(targetDb: MigrationDatabase): boolean {
    const taskColumns = targetDb.prepare("PRAGMA table_info(tasks)").all();
    return taskColumns.some((column) => column.name === "automation_json");
}

function isDuplicateColumnError(error: unknown): boolean {
    return (
        error instanceof Error &&
        /duplicate column name:\s*automation_json/u.test(error.message)
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
        /database is locked/iu.test(message)
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

await ensureTaskAutomationColumn(db);
