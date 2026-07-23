import type { DatabaseMigration } from "./types.ts";

export const maintenanceCoverageMigration: DatabaseMigration = {
    version: 4,
    name: "sqlite-maintenance-coverage",
    sql: `
DROP INDEX IF EXISTS idx_notifications_read;

CREATE INDEX IF NOT EXISTS idx_notifications_read_retention
    ON notifications(
        is_read,
        COALESCE(datetime(occurred_at), datetime(created_at)) DESC,
        id DESC
    );

CREATE INDEX IF NOT EXISTS idx_chat_runtime_snapshots_retention
    ON chat_runtime_snapshots(updated_at);
`,
};
