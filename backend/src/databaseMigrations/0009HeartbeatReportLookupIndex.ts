import type { DatabaseMigration } from "./types.ts";

export const heartbeatReportLookupIndexMigration: DatabaseMigration = {
    version: 9,
    name: "heartbeat-report-lookup-index",
    sql: `
CREATE INDEX idx_reports_heartbeat_stream_latest
    ON reports(type, source, source_job_id, occurred_at DESC, id DESC);
`,
};
