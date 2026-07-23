import type { DatabaseMigration } from "./types.ts";

export const lifecycleIndexesMigration: DatabaseMigration = {
    version: 2,
    name: "sqlite-lifecycle-indexes",
    sql: `
CREATE INDEX IF NOT EXISTS idx_task_events_task_created
    ON task_events(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_updates_task_created
    ON task_updates(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_finished
    ON scheduled_job_runs(finished_at)
    WHERE finished_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_job_executions_finished
    ON job_executions(finished_at)
    WHERE finished_at IS NOT NULL;
`,
};
