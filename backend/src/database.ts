import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database, type SQLQueryBindings } from "bun:sqlite";

type DatabaseSync = Database;

const SQLITE_NULL = JSON.parse("null") as SQLQueryBindings;

/** Converts optional values to SQLite NULL-compatible bindings. */
export function sqlNullable(value: SQLQueryBindings | undefined): SQLQueryBindings {
    return value === undefined ? SQLITE_NULL : value;
}

function resolveDatabasePath(): {
    configuredDatabasePath: string | undefined;
    databasePath: string;
} {
    const configuredDatabasePath = process.env.MIRA_DASHBOARD_DB_PATH?.trim();
    return {
        configuredDatabasePath,
        databasePath: configuredDatabasePath
            ? path.resolve(configuredDatabasePath)
            : path.join(process.cwd(), "data", "mira-dashboard.db"),
    };
}

export function getMiraDatabasePath(): string {
    return resolveDatabasePath().databasePath;
}

export const miraDatabasePath = getMiraDatabasePath();

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
    const relativePath = path.relative(rootPath, candidatePath);
    return (
        relativePath === "" ||
        (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
    );
}

function findExistingParent(directoryPath: string): string {
    let currentPath = directoryPath;
    while (!fs.existsSync(currentPath)) {
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            return currentPath;
        }
        currentPath = parentPath;
    }
    return currentPath;
}

function assertTestDatabasePath(
    databasePath: string,
    configuredDatabasePath: string | undefined
): void {
    if (process.env.NODE_ENV !== "test") {
        return;
    }
    const configuredTemporaryRoot = path.resolve(os.tmpdir());
    const realTemporaryRoot = fs.realpathSync(configuredTemporaryRoot);
    const databaseParent = path.dirname(databasePath);
    if (
        !configuredDatabasePath ||
        (!isPathWithinRoot(databasePath, configuredTemporaryRoot) &&
            !isPathWithinRoot(databasePath, realTemporaryRoot))
    ) {
        throw new Error(
            `Refusing to open non-temporary Dashboard test database: ${databasePath}`
        );
    }
    const existingDatabaseParent = findExistingParent(databaseParent);
    if (fs.lstatSync(existingDatabaseParent).isSymbolicLink()) {
        throw new Error(
            `Refusing to open symlinked Dashboard test database: ${databasePath}`
        );
    }
    const realExistingDatabaseParent = fs.realpathSync(existingDatabaseParent);
    if (!isPathWithinRoot(realExistingDatabaseParent, realTemporaryRoot)) {
        throw new Error(
            `Refusing to open symlinked Dashboard test database: ${databasePath}`
        );
    }
    fs.mkdirSync(databaseParent, { recursive: true });
    const realDatabaseParent = fs.realpathSync(databaseParent);
    let existingDatabaseStat: fs.Stats | undefined;
    try {
        existingDatabaseStat = fs.lstatSync(databasePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
    if (
        !isPathWithinRoot(realDatabaseParent, realTemporaryRoot) ||
        existingDatabaseStat?.isSymbolicLink() === true
    ) {
        throw new Error(
            `Refusing to open symlinked Dashboard test database: ${databasePath}`
        );
    }
}

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

CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    title TEXT NOT NULL,
    body_md TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    source TEXT,
    source_job_id TEXT,
    dedupe_key TEXT UNIQUE,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_occurred_at ON reports(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_type_occurred_at ON reports(type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status_occurred_at ON reports(status, occurred_at DESC);

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
    disable_intent_json TEXT,
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
    ON scheduled_jobs(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS openclaw_cron_job_metadata (
    job_id TEXT PRIMARY KEY,
    disable_intent_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS scheduled_job_execution_policies (
    job_id TEXT PRIMARY KEY,
    resource_class TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(job_id) REFERENCES scheduled_jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_workers (
    id TEXT PRIMARY KEY,
    capacity INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_workers_heartbeat
    ON job_workers(heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS job_executions (
    id TEXT PRIMARY KEY,
    scheduled_job_id TEXT,
    scheduled_run_id INTEGER,
    action_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    resource_class TEXT NOT NULL,
    priority INTEGER NOT NULL,
    status TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    queued_at TEXT NOT NULL,
    available_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    heartbeat_at TEXT,
    cancel_requested_at TEXT,
    cancellable INTEGER NOT NULL DEFAULT 1,
    attempt INTEGER NOT NULL DEFAULT 0,
    timeout_ms INTEGER NOT NULL,
    message TEXT,
    output_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_job_executions_queue
    ON job_executions(status, available_at, priority DESC, queued_at);

CREATE INDEX IF NOT EXISTS idx_job_executions_scheduled_run
    ON job_executions(scheduled_run_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_executions_active_scheduled_job
    ON job_executions(scheduled_job_id)
    WHERE scheduled_job_id IS NOT NULL AND status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS chat_runtime_snapshots (
    gateway_scope TEXT NOT NULL,
    session_key TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (gateway_scope, session_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_runtime_snapshots_scope_session_normalized
    ON chat_runtime_snapshots(gateway_scope, lower(trim(session_key)));

CREATE TABLE IF NOT EXISTS chat_runtime_snapshot_events (
    gateway_scope TEXT NOT NULL,
    session_key TEXT NOT NULL,
    runtime_sequence INTEGER NOT NULL,
    envelope_json TEXT NOT NULL,
    PRIMARY KEY (gateway_scope, session_key, runtime_sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_runtime_snapshot_events_scope_session_sequence_normalized
    ON chat_runtime_snapshot_events(
        gateway_scope,
        lower(trim(session_key)),
        runtime_sequence
    );

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

function runSchemaSql(databaseConnection: DatabaseSync, schemaSql: string): void {
    for (const statement of schemaSql.split(";")) {
        const trimmedStatement = statement.trim();
        if (trimmedStatement) {
            databaseConnection.run(trimmedStatement);
        }
    }
}

function initializeDatabase(databasePath: string): DatabaseSync {
    const { configuredDatabasePath } = resolveDatabasePath();
    assertTestDatabasePath(databasePath, configuredDatabasePath);
    const dataDirectory = path.dirname(databasePath);
    fs.mkdirSync(dataDirectory, { recursive: true });

    const initializedDatabase = new Database(databasePath);
    initializedDatabase.run("PRAGMA foreign_keys = ON");
    initializedDatabase.run("PRAGMA busy_timeout = 5000");
    initializedDatabase.run("PRAGMA journal_mode = WAL");
    runSchemaSql(initializedDatabase, SCHEMA_SQL);

    return initializedDatabase;
}

const activeDatabaseState: {
    database: DatabaseSync | undefined;
    path: string | undefined;
} = {
    database: undefined,
    path: undefined,
};

function currentDatabase(): DatabaseSync {
    if (process.env.NODE_ENV !== "test" && activeDatabaseState.database !== undefined) {
        return activeDatabaseState.database;
    }
    const { databasePath } = resolveDatabasePath();
    if (
        activeDatabaseState.database !== undefined &&
        activeDatabaseState.path === databasePath
    ) {
        return activeDatabaseState.database;
    }
    const nextDatabase = initializeDatabase(databasePath);
    activeDatabaseState.database?.close();
    activeDatabaseState.database = nextDatabase;
    activeDatabaseState.path = databasePath;
    return activeDatabaseState.database;
}

function closeActiveDatabase(): void {
    activeDatabaseState.database?.close();
    activeDatabaseState.database = undefined;
    activeDatabaseState.path = undefined;
}

export function closeDatabaseForTests(): void {
    if (process.env.NODE_ENV !== "test") {
        throw new Error("closeDatabaseForTests can only be used in test");
    }
    closeActiveDatabase();
}

/** Defines database. */
export const database = new Proxy({} as DatabaseSync, {
    get(_target, property) {
        if (property === "close") {
            return closeActiveDatabase;
        }
        const active = currentDatabase();
        const value = Reflect.get(active, property, active);
        return typeof value === "function" ? value.bind(active) : value;
    },
});
