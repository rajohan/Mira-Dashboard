import type { DatabaseMigration } from "./types.ts";

export const maintenanceCoverageMigration: DatabaseMigration = {
    version: 4,
    name: "sqlite-maintenance-coverage",
    sql: `
CREATE INDEX IF NOT EXISTS idx_notifications_read_retention
    ON notifications(is_read, occurred_at DESC, id DESC)
    WHERE is_read = 1;

CREATE INDEX IF NOT EXISTS idx_chat_runtime_snapshots_retention
    ON chat_runtime_snapshots(
        updated_at DESC,
        gateway_scope DESC,
        session_key DESC
    );
`,
};
