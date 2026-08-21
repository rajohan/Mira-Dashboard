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
            const credentialHistoryPlan = database.sqlite
                .query<QueryPlanRow, [string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM automation_credentials
                    WHERE principal_id = ?
                    ORDER BY created_at DESC, id DESC
                    LIMIT 50
                `)
                .all("openclaw-task-tracking");
            const principalHistoryPlan = database.sqlite
                .query<QueryPlanRow, []>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM automation_principals
                    ORDER BY created_at DESC, id DESC
                    LIMIT 50
                `)
                .all();
            const enabledPrincipalPlan = database.sqlite
                .query<QueryPlanRow, []>(`
                    EXPLAIN QUERY PLAN
                    SELECT count(*)
                    FROM automation_principals
                    WHERE disabled_at IS NULL
                `)
                .all();
            const activeCredentialPlan = database.sqlite
                .query<QueryPlanRow, [string, number, number]>(`
                    EXPLAIN QUERY PLAN
                    SELECT count(*)
                    FROM automation_credentials
                    WHERE principal_id = ?
                      AND revoked_at IS NULL
                      AND created_at <= ?
                      AND (expires_at IS NULL OR expires_at > ?)
                `)
                .all("openclaw-task-tracking", 2000, 2000);
            const activeReplacementPlan = database.sqlite
                .query<QueryPlanRow, [string, string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM automation_credentials
                    WHERE principal_id = ?
                      AND replaces_credential_id = ?
                      AND revoked_at IS NULL
                `)
                .all("openclaw-task-tracking", "019fc968-1a9b-7771-9f1b-d5b863b0e7b4");
            const predecessorDeletePlan = database.sqlite
                .query<QueryPlanRow, [string]>(`
                    EXPLAIN QUERY PLAN
                    DELETE FROM automation_credentials
                    WHERE id = ?
                `)
                .all("019fc968-1a9b-7771-9f1b-d5b863b0e7b4");

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
            expect(
                credentialHistoryPlan.some((row) =>
                    row.detail.includes("automation_credentials_principal_created_idx")
                )
            ).toBeTrue();
            expect(
                principalHistoryPlan.some((row) =>
                    row.detail.includes("automation_principals_created_id_idx")
                )
            ).toBeTrue();
            expect(
                enabledPrincipalPlan.some((row) =>
                    row.detail.includes("automation_principals_active_created_id_idx")
                )
            ).toBeTrue();
            expect(
                activeCredentialPlan.some((row) =>
                    row.detail.includes(
                        "automation_credentials_active_principal_created_idx"
                    )
                )
            ).toBeTrue();
            expect(
                activeReplacementPlan.some((row) =>
                    row.detail.includes(
                        "automation_credentials_active_replacement_unique"
                    )
                )
            ).toBeTrue();
            expect(
                predecessorDeletePlan.some((row) =>
                    row.detail.includes("automation_credentials_replacement_idx")
                )
            ).toBeTrue();
        } finally {
            database.sqlite.close(true);
        }
    });
});
