import { Database } from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";

const qualificationDatabaseStatements = [
    "PRAGMA foreign_keys = ON",
    `CREATE TABLE qualification_incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        incident_key TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        resolved_at INTEGER,
        status TEXT NOT NULL,
        CONSTRAINT qualification_incidents_resolution_check CHECK (
            (status = 'open' AND resolved_at IS NULL)
            OR (status = 'resolved' AND resolved_at IS NOT NULL)
        )
    ) STRICT`,
    `CREATE UNIQUE INDEX qualification_incidents_active_key_unique
        ON qualification_incidents (incident_key)
        WHERE resolved_at IS NULL`,
    `CREATE INDEX qualification_incidents_status_seen_idx
        ON qualification_incidents (status, last_seen_at)`,
    `CREATE TABLE qualification_events (
        aggregate_id INTEGER NOT NULL REFERENCES qualification_incidents(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        payload TEXT NOT NULL,
        topic TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX qualification_events_topic_id_idx
        ON qualification_events (topic, id)`,
] as const;

/**
 * Opens a strict in-memory SQLite database through both Bun and Drizzle.
 * @returns Paired native and typed database clients.
 */
export function createQualificationDatabase() {
    const sqlite = new Database(":memory:", { strict: true });
    for (const statement of qualificationDatabaseStatements) {
        sqlite.run(statement);
    }

    const orm = drizzle({ client: sqlite });

    return { orm, sqlite };
}
