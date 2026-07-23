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

CREATE INDEX IF NOT EXISTS idx_deployment_jobs_retention
    ON deployment_jobs(started_at DESC, id DESC, status)
    WHERE status NOT IN ('building', 'restart-scheduled');

CREATE INDEX IF NOT EXISTS idx_agent_task_history_retention
    ON agent_task_history(completed_at DESC, id DESC, status)
    WHERE status != 'active' AND completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reports_retention
    ON reports(occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_docker_update_events_retention
    ON docker_update_events(created_at DESC, id DESC);
`,
};
