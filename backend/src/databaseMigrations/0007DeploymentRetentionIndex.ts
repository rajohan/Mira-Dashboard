import type { DatabaseMigration } from "./types.ts";

export const deploymentRetentionIndexMigration: DatabaseMigration = {
    version: 7,
    name: "deployment-retention-index",
    sql: `
DROP INDEX IF EXISTS idx_deployment_jobs_retention;

CREATE INDEX idx_deployment_jobs_retention
    ON deployment_jobs(started_at DESC, id DESC, status)
    WHERE status NOT IN ('building', 'verifying');
`,
};
