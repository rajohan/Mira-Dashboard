import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { lowercaseHexTextCheck, timestampMillisecondsCheck } from "./checks.ts";

/** Authentication operations with independent persisted failure budgets. */
export const authenticationRateLimitKinds = [
    "account-password",
    "bootstrap-gateway-global",
    "bootstrap-gateway-source",
    "login-password-global",
    "login-password-source",
] as const;

export type AuthenticationRateLimitKind = (typeof authenticationRateLimitKinds)[number];

/** Durable progressive-cooldown state keyed by a domain-separated subject digest. */
export const authRateLimitBuckets = sqliteTable(
    "auth_rate_limit_buckets",
    {
        blockedUntil: integer("blocked_until", { mode: "timestamp_ms" }),
        bucketKey: text("bucket_key").notNull().primaryKey(),
        failureCount: integer("failure_count").notNull(),
        firstFailedAt: integer("first_failed_at", {
            mode: "timestamp_ms",
        }).notNull(),
        kind: text("kind", { enum: authenticationRateLimitKinds }).notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    },
    (table) => [
        check(
            "auth_rate_limit_buckets_blocked_until_check",
            sql`${table.blockedUntil} IS NULL OR (${timestampMillisecondsCheck(table.blockedUntil)} AND ${table.blockedUntil} > ${table.updatedAt})`
        ),
        check(
            "auth_rate_limit_buckets_bucket_key_check",
            lowercaseHexTextCheck(table.bucketKey, 64)
        ),
        check(
            "auth_rate_limit_buckets_failure_count_check",
            sql`${table.failureCount} BETWEEN 1 AND 9007199254740991`
        ),
        check(
            "auth_rate_limit_buckets_kind_check",
            sql`${table.kind} IN ('account-password', 'bootstrap-gateway-global', 'bootstrap-gateway-source', 'login-password-global', 'login-password-source')`
        ),
        check(
            "auth_rate_limit_buckets_timestamps_check",
            sql`${timestampMillisecondsCheck(table.firstFailedAt)} AND ${timestampMillisecondsCheck(table.updatedAt)} AND ${table.updatedAt} >= ${table.firstFailedAt}`
        ),
        index("auth_rate_limit_buckets_kind_updated_at_idx").on(
            table.kind,
            table.updatedAt,
            table.bucketKey
        ),
    ]
);
