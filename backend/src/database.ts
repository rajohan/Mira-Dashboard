import fs from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

type DatabaseSync = Database;

const configuredDatabasePath = process.env.MIRA_DASHBOARD_DB_PATH?.trim();
export const miraDatabasePath = configuredDatabasePath
    ? path.resolve(configuredDatabasePath)
    : path.join(process.cwd(), "data", "mira-dashboard.database");

const SCHEMA_SQL = `
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

CREATE INDEX IF NOT EXISTS idx_cache_entries_status ON cache_entries(status);
CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at ON cache_entries(expires_at);

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
    commit_title TEXT,
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
`;

function initializeDatabase(): DatabaseSync {
    const dataDirectory = path.dirname(miraDatabasePath);
    fs.mkdirSync(dataDirectory, { recursive: true });

    const initializedDatabase = new Database(miraDatabasePath);
    initializedDatabase.exec("PRAGMA foreign_keys = ON");
    initializedDatabase.exec("PRAGMA busy_timeout = 5000");
    initializedDatabase.exec(SCHEMA_SQL);

    return initializedDatabase;
}

/** Defines database. */
export const database = initializeDatabase();
