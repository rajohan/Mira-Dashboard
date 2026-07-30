import type { DatabaseMigration } from "./types.ts";

export const workerControlMigration: DatabaseMigration = {
    version: 8,
    name: "worker-control",
    sql: `
CREATE TABLE job_worker_control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    claims_paused INTEGER NOT NULL DEFAULT 0 CHECK (claims_paused IN (0, 1)),
    updated_at TEXT NOT NULL
);

INSERT INTO job_worker_control (id, claims_paused, updated_at)
VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`,
};
