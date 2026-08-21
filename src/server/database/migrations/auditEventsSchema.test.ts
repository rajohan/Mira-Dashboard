import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";

interface QueryPlanRow {
    detail: string;
}

const auditId = "019fc968-1a9b-7772-af1b-d5b863b0e7b4";

interface AuditEventSqlRow {
    action: string;
    actorId: string;
    actorKind: string;
    authenticatorId: string | null;
    id: string;
    metadataJson: string;
    occurredAt: number;
    outcome: string;
    requestId: string | null;
    targetId: string;
    targetType: string;
}

const validAuditEventSqlRow: AuditEventSqlRow = {
    action: "security.session.authenticate",
    actorId: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
    actorKind: "user",
    authenticatorId: "a".repeat(32),
    id: auditId,
    metadataJson: '{"method":"password"}',
    occurredAt: 1000,
    outcome: "succeeded",
    requestId: "request-1",
    targetId: "a".repeat(32),
    targetType: "auth-session",
};

function insertAuditEvent(
    database: Awaited<ReturnType<typeof openFreshMigratedDatabase>>,
    overrides: Partial<AuditEventSqlRow> = {}
) {
    const event = { ...validAuditEventSqlRow, ...overrides };
    database.sqlite.run(
        `INSERT INTO audit_events (
            action,
            actor_id,
            actor_kind,
            authenticator_id,
            id,
            metadata_json,
            occurred_at,
            outcome,
            request_id,
            target_id,
            target_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            event.action,
            event.actorId,
            event.actorKind,
            event.authenticatorId,
            event.id,
            event.metadataJson,
            event.occurredAt,
            event.outcome,
            event.requestId,
            event.targetId,
            event.targetType,
        ]
    );
}

describe("audit events schema", () => {
    test("removes the hidden rowid replacement path", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            const table = database.sqlite
                .query<{ strict: number; wr: number }, [string]>(
                    "SELECT strict, wr FROM pragma_table_list WHERE name = ?"
                )
                .get("audit_events");

            expect(table).toEqual({ strict: 1, wr: 1 });
            expect(() =>
                database.sqlite.query("SELECT rowid FROM audit_events").get()
            ).toThrow("no such column: rowid");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects update, delete, and conflicting replacement", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            insertAuditEvent(database);

            expect(() =>
                database.sqlite.run(
                    "UPDATE audit_events SET outcome = 'failed' WHERE id = ?",
                    [auditId]
                )
            ).toThrow("audit_events is append-only");
            expect(() =>
                database.sqlite.run("DELETE FROM audit_events WHERE id = ?", [auditId])
            ).toThrow("audit_events is append-only");
            expect(() =>
                database.sqlite.run(
                    `INSERT OR REPLACE INTO audit_events (
                        action,
                        actor_id,
                        actor_kind,
                        authenticator_id,
                        id,
                        metadata_json,
                        occurred_at,
                        outcome,
                        target_id,
                        target_type
                    ) VALUES (
                        'security.session.authenticate',
                        '019fc968-1a9b-7770-8f1b-d5b863b0e7b4',
                        'user',
                        '${"a".repeat(32)}',
                        ?,
                        '{}',
                        1001,
                        'failed',
                        '${"a".repeat(32)}',
                        'auth-session'
                    )`,
                    [auditId]
                )
            ).toThrow("audit_events is append-only");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("bounds UTF-8 metadata and keeps actor/authenticator identity coherent", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            const oversizedMetadata = JSON.stringify({ value: "å".repeat(4096) });

            expect(() =>
                insertAuditEvent(database, {
                    id: "019fc968-1a9b-4775-9f1b-d5b863b0e7b4",
                })
            ).toThrow("audit_events_id_check");
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO audit_events (
                        action,
                        actor_id,
                        actor_kind,
                        authenticator_id,
                        id,
                        metadata_json,
                        occurred_at,
                        outcome,
                        target_id,
                        target_type
                    ) VALUES ('security.audit', 'system', 'system', NULL, ?, ?, 1000, 'succeeded', 'audit', 'system')`,
                    ["019fc968-1a9b-7775-9f1b-d5b863b0e7b4", oversizedMetadata]
                )
            ).toThrow("audit_events_metadata_json_check");
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO audit_events (
                        action,
                        actor_id,
                        actor_kind,
                        authenticator_id,
                        id,
                        occurred_at,
                        outcome,
                        target_id,
                        target_type
                    ) VALUES (
                        'security.audit',
                        'system',
                        'system',
                        'unexpected-authenticator',
                        '019fc968-1a9b-7776-af1b-d5b863b0e7b4',
                        1000,
                        'succeeded',
                        'audit',
                        'system'
                    )
                `)
            ).toThrow("audit_events_actor_check");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("keeps audit text checks aligned with the Valibot row boundary", async () => {
        const database = await openFreshMigratedDatabase();
        const invalidRows: ReadonlyArray<{
            constraint: string;
            overrides: Partial<AuditEventSqlRow>;
        }> = [
            {
                constraint: "audit_events_action_check",
                overrides: { action: "-login" },
            },
            {
                constraint: "audit_events_action_check",
                overrides: { action: "security.audit\0" },
            },
            {
                constraint: "audit_events_id_check",
                overrides: { id: `${auditId}\0` },
            },
            {
                constraint: "audit_events_target_check",
                overrides: { targetType: ".session" },
            },
            {
                constraint: "audit_events_target_check",
                overrides: { targetType: "system\0" },
            },
            {
                constraint: "audit_events_actor_check",
                overrides: { actorId: "\u3000" },
            },
            {
                constraint: "audit_events_authenticator_id_check",
                overrides: { authenticatorId: "\t\n" },
            },
            {
                constraint: "audit_events_request_id_check",
                overrides: { requestId: "request\0id" },
            },
            {
                constraint: "audit_events_target_check",
                overrides: { targetId: "   " },
            },
            {
                constraint: "audit_events_occurred_at_check",
                overrides: { occurredAt: -1 },
            },
            {
                constraint: "audit_events_occurred_at_check",
                overrides: { occurredAt: 8_640_000_000_000_001 },
            },
        ];

        try {
            for (const { constraint, overrides } of invalidRows) {
                expect(() => insertAuditEvent(database, overrides)).toThrow(constraint);
            }
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects metadata outside the bounded JSON object contract", async () => {
        const database = await openFreshMigratedDatabase();
        const excessiveDepth = `${'{"nested":'.repeat(14)}null${"}".repeat(14)}`;

        try {
            expect(() =>
                insertAuditEvent(database, { metadataJson: '{"number":1e400}' })
            ).toThrow("audit_events metadata must be a bounded JSON object");
            expect(() =>
                insertAuditEvent(database, {
                    metadataJson: '{"number":9007199254740993}',
                })
            ).toThrow("audit_events metadata must be a bounded JSON object");
            expect(() =>
                insertAuditEvent(database, { metadataJson: excessiveDepth })
            ).toThrow("audit_events metadata must be a bounded JSON object");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects duplicate metadata keys before durable storage", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            expect(() =>
                insertAuditEvent(database, {
                    metadataJson: '{"number":0,"number":1}',
                })
            ).toThrow("audit_events metadata must be a bounded JSON object");
            expect(() =>
                insertAuditEvent(database, {
                    id: "019fc968-1a9b-7779-af1b-d5b863b0e7b4",
                    metadataJson: '{"nested":{"key":0,"key":1}}',
                })
            ).toThrow("audit_events metadata must be a bounded JSON object");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("supports deterministic request and target cursor scans", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            const requestPlan = database.sqlite
                .query<QueryPlanRow, [string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM audit_events
                    WHERE request_id = ?
                    ORDER BY occurred_at DESC, id DESC
                    LIMIT 100
                `)
                .all("request-1");
            const targetPlan = database.sqlite
                .query<QueryPlanRow, [string, string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM audit_events
                    WHERE target_type = ? AND target_id = ?
                    ORDER BY occurred_at DESC, id DESC
                    LIMIT 100
                `)
                .all("auth-session", "a".repeat(32));

            expect(
                requestPlan.some((row) =>
                    row.detail.includes("audit_events_request_occurred_idx")
                )
            ).toBeTrue();
            expect(
                targetPlan.some((row) =>
                    row.detail.includes("audit_events_target_occurred_idx")
                )
            ).toBeTrue();
        } finally {
            database.sqlite.close(true);
        }
    });
});
