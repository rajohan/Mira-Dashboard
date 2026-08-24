import { sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { browserSessionUserAgentMaximumLength } from "../../../contracts/auth.ts";
import {
    boundedNonBlankTextCheck,
    lowercaseHexTextCheck,
    timestampMillisecondsCheck,
} from "./checks.ts";
import { users } from "./users.ts";

/** Revocable browser sessions backed by selector/validator tokens. */
export const authSessions = sqliteTable(
    "auth_sessions",
    {
        authenticatedAt: integer("authenticated_at", { mode: "timestamp_ms" }).notNull(),
        authenticationVersion: integer("authentication_version").notNull(),
        authMethod: text("auth_method", {
            enum: ["password", "recovery", "totp", "webauthn"],
        }).notNull(),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
        id: text("id").notNull().primaryKey(),
        lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
        mfaVerifiedAt: integer("mfa_verified_at", { mode: "timestamp_ms" }),
        passwordVerifiedAt: integer("password_verified_at", {
            mode: "timestamp_ms",
        }).notNull(),
        userAgent: text("user_agent"),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        validatorHash: text("validator_hash").notNull(),
        validatorVersion: integer("validator_version").notNull().default(1),
    },
    (table) => [
        check(
            "auth_sessions_authentication_version_check",
            sql`${table.authenticationVersion} BETWEEN 1 AND 9007199254740991`
        ),
        check(
            "auth_sessions_auth_method_check",
            sql`${table.authMethod} IN ('password', 'recovery', 'totp', 'webauthn')`
        ),
        check(
            "auth_sessions_expiry_check",
            sql`${timestampMillisecondsCheck(table.createdAt)} AND ${timestampMillisecondsCheck(table.expiresAt)} AND ${table.expiresAt} > ${table.createdAt}`
        ),
        check(
            "auth_sessions_authentication_time_check",
            sql`${timestampMillisecondsCheck(table.authenticatedAt)} AND ${table.authenticatedAt} <= ${table.createdAt}`
        ),
        check(
            "auth_sessions_last_seen_check",
            sql`${timestampMillisecondsCheck(table.lastSeenAt)} AND ${table.lastSeenAt} >= ${table.createdAt} AND ${table.lastSeenAt} < ${table.expiresAt}`
        ),
        check(
            "auth_sessions_mfa_time_check",
            sql`${table.mfaVerifiedAt} IS NULL OR (${timestampMillisecondsCheck(table.mfaVerifiedAt)} AND ${table.mfaVerifiedAt} >= ${table.authenticatedAt} AND ${table.mfaVerifiedAt} <= ${table.createdAt})`
        ),
        check(
            "auth_sessions_password_time_check",
            sql`${timestampMillisecondsCheck(table.passwordVerifiedAt)} AND ${table.passwordVerifiedAt} >= ${table.authenticatedAt} AND ${table.passwordVerifiedAt} <= ${table.createdAt}`
        ),
        check(
            "auth_sessions_mfa_method_check",
            sql`${table.authMethod} = 'password' OR ${table.mfaVerifiedAt} IS NOT NULL`
        ),
        check("auth_sessions_id_check", lowercaseHexTextCheck(table.id, 32)),
        check(
            "auth_sessions_user_agent_check",
            sql`${table.userAgent} IS NULL OR (${boundedNonBlankTextCheck(table.userAgent, browserSessionUserAgentMaximumLength)})`
        ),
        check(
            "auth_sessions_validator_hash_check",
            lowercaseHexTextCheck(table.validatorHash, 64)
        ),
        check(
            "auth_sessions_validator_version_check",
            sql`${table.validatorVersion} = 1`
        ),
        index("auth_sessions_expires_at_idx").on(table.expiresAt),
        index("auth_sessions_user_last_seen_idx").on(
            table.userId,
            table.lastSeenAt,
            table.createdAt,
            table.id
        ),
        uniqueIndex("auth_sessions_validator_hash_unique").on(table.validatorHash),
    ]
);
