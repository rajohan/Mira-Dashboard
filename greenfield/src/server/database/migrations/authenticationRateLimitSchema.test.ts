import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";

const bucketKey = "a".repeat(64);

function requiredBinding(
    value: string | number | null | undefined
): string | number | null {
    if (value === undefined) throw new Error("Missing test SQL binding");
    return value;
}

describe("authentication rate-limit schema", () => {
    test("persists one canonical STRICT throttle bucket", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run(
                `INSERT INTO auth_rate_limit_buckets (
                    blocked_until,
                    bucket_key,
                    failure_count,
                    first_failed_at,
                    kind,
                    updated_at
                ) VALUES (17000, ?, 3, 1000, 'login-password-source', 2000)`,
                [bucketKey]
            );

            expect(
                database.sqlite
                    .query<{ failureCount: number; kind: string }, [string]>(`
                        SELECT
                            failure_count AS "failureCount",
                            kind
                        FROM auth_rate_limit_buckets
                        WHERE bucket_key = ?
                    `)
                    .get(bucketKey)
            ).toEqual({ failureCount: 3, kind: "login-password-source" });
            expect(
                database.sqlite
                    .query<{ strict: number }, []>(`
                        SELECT strict
                        FROM pragma_table_list
                        WHERE name = 'auth_rate_limit_buckets'
                    `)
                    .get()
            ).toEqual({ strict: 1 });
            const prunePlan = database.sqlite
                .query<{ detail: string }, [string, string, number, number]>(`
                    EXPLAIN QUERY PLAN
                    SELECT bucket_key
                    FROM auth_rate_limit_buckets
                    WHERE kind = ? AND bucket_key <> ?
                    ORDER BY updated_at DESC, bucket_key DESC
                    LIMIT ? OFFSET ?
                `)
                .all("login-password-source", bucketKey, 2_147_483_647, 255);
            expect(
                prunePlan.some(({ detail }) =>
                    detail.includes("auth_rate_limit_buckets_kind_updated_at_idx")
                )
            ).toBeTrue();
        } finally {
            database.sqlite.close(true);
        }
    });

    test.each([
        { column: "bucket_key", value: "A".repeat(64) },
        { column: "bucket_key", value: `${bucketKey}\0suffix` },
        { column: "failure_count", value: 0 },
        { column: "kind", value: "password" },
        { column: "updated_at", value: 999 },
        { column: "blocked_until", value: 2000 },
    ])("rejects invalid persisted throttle field %#", async ({ column, value }) => {
        const database = await openFreshMigratedDatabase();

        try {
            const values: Record<string, string | number | null> = {
                blocked_until: 17_000,
                bucket_key: bucketKey,
                failure_count: 3,
                first_failed_at: 1000,
                kind: "login-password-source",
                updated_at: 2000,
                [column]: value,
            };
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO auth_rate_limit_buckets (
                        blocked_until,
                        bucket_key,
                        failure_count,
                        first_failed_at,
                        kind,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        requiredBinding(values.blocked_until),
                        requiredBinding(values.bucket_key),
                        requiredBinding(values.failure_count),
                        requiredBinding(values.first_failed_at),
                        requiredBinding(values.kind),
                        requiredBinding(values.updated_at),
                    ]
                )
            ).toThrow();
        } finally {
            database.sqlite.close(true);
        }
    });
});
