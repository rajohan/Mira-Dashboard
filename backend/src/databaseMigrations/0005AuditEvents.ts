import type { DatabaseMigration } from "./types.ts";

export const auditEventsMigration: DatabaseMigration = {
    version: 5,
    name: "append-only-audit-events",
    sql: `
CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL
        CHECK (
            actor_type IN ('anonymous', 'automation', 'loopback', 'system', 'user')
        ),
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    outcome TEXT NOT NULL
        CHECK (
            outcome IN (
                'attempted',
                'accepted',
                'succeeded',
                'failed',
                'denied',
                'cancelled'
            )
        ),
    request_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
    occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_audit_events_occurred
    ON audit_events(occurred_at DESC, id DESC);

CREATE INDEX idx_audit_events_request
    ON audit_events(request_id, occurred_at DESC)
    WHERE request_id IS NOT NULL;

CREATE INDEX idx_audit_events_target
    ON audit_events(target_type, target_id, occurred_at DESC);

CREATE TRIGGER audit_events_reject_replace
BEFORE INSERT ON audit_events
WHEN EXISTS (SELECT 1 FROM audit_events WHERE id = NEW.id)
BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_reject_update
BEFORE UPDATE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_reject_delete
BEFORE DELETE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only');
END;
`,
};
