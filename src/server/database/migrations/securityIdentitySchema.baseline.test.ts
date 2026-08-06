import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { securityIdentityUserId } from "./testSupport/securityIdentitySchema.ts";

interface QueryPlanRow {
    detail: string;
}

interface TableListRow {
    name: string;
    strict: number;
}

interface TableInfoRow {
    name: string;
    notNull: number;
    primaryKeyPosition: number;
}

describe("security identity baseline", () => {
    test("creates every security-core table as STRICT", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            const strictByTable = new Map(
                database.sqlite
                    .query<TableListRow, []>("PRAGMA table_list")
                    .all()
                    .map((row) => [row.name, row.strict])
            );

            for (const table of [
                "audit_events",
                "auth_pending_logins",
                "auth_rate_limit_buckets",
                "auth_sessions",
                "automation_credentials",
                "automation_principal_capabilities",
                "automation_principals",
                "user_recovery_codes",
                "user_totp_factors",
                "users",
            ]) {
                expect(strictByTable.get(table)).toBe(1);
            }
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enforces every rowid security identity primary key as NOT NULL", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            for (const table of [
                "auth_pending_logins",
                "auth_sessions",
                "automation_credentials",
                "automation_principals",
                "user_recovery_codes",
                "user_totp_factors",
                "users",
            ]) {
                expect(
                    database.sqlite
                        .query<TableInfoRow, [string]>(`
                            SELECT
                                name,
                                "notnull" AS "notNull",
                                pk AS "primaryKeyPosition"
                            FROM pragma_table_info(?)
                            WHERE name = 'id'
                        `)
                        .get(table)
                ).toEqual({ name: "id", notNull: 1, primaryKeyPosition: 1 });
            }
        } finally {
            database.sqlite.close(true);
        }
    });

    test("supports session administration and credential lookup indexes", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            const sessionPlan = database.sqlite
                .query<QueryPlanRow, [string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM auth_sessions
                    WHERE user_id = ?
                    ORDER BY last_seen_at DESC, created_at DESC, id DESC
                    LIMIT 100
                `)
                .all(securityIdentityUserId);
            const credentialPlan = database.sqlite
                .query<QueryPlanRow, [string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM automation_credentials
                    WHERE prefix = ?
                `)
                .all("c".repeat(32));

            expect(
                sessionPlan.some((row) =>
                    row.detail.includes("auth_sessions_user_last_seen_idx")
                )
            ).toBeTrue();
            expect(
                credentialPlan.some((row) =>
                    row.detail.includes("automation_credentials_prefix_unique")
                )
            ).toBeTrue();
        } finally {
            database.sqlite.close(true);
        }
    });
});
