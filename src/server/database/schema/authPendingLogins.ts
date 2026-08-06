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
import { opaqueTokenValidatorVersion } from "../../shared/opaqueToken.ts";
import { pendingLoginLifetimeMs } from "../../shared/pendingLoginPolicy.ts";
import { authSessions } from "./authSessions.ts";
import {
    boundedNonBlankTextCheck,
    lowercaseHexTextCheck,
    timestampMillisecondsCheck,
} from "./checks.ts";
import { users } from "./users.ts";

/** Password-verified, short-lived handoff awaiting one configured MFA method. */
export const authPendingLogins = sqliteTable(
    "auth_pending_logins",
    {
        allowsRecovery: integer("allows_recovery", { mode: "boolean" }).notNull(),
        allowsTotp: integer("allows_totp", { mode: "boolean" }).notNull(),
        attemptCount: integer("attempt_count").notNull().default(0),
        authenticationVersion: integer("authentication_version").notNull(),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
        id: text("id").notNull().primaryKey(),
        passwordVerifiedAt: integer("password_verified_at", {
            mode: "timestamp_ms",
        }).notNull(),
        replacedSessionId: text("replaced_session_id").references(() => authSessions.id, {
            onDelete: "set null",
        }),
        userAgent: text("user_agent"),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        validatorHash: text("validator_hash").notNull(),
        validatorVersion: integer("validator_version")
            .notNull()
            .default(opaqueTokenValidatorVersion),
    },
    (table) => [
        check(
            "auth_pending_logins_methods_check",
            sql`${table.allowsRecovery} IN (0, 1) AND ${table.allowsTotp} IN (0, 1) AND (${table.allowsRecovery} + ${table.allowsTotp}) >= 1`
        ),
        check(
            "auth_pending_logins_attempt_count_check",
            sql`${table.attemptCount} BETWEEN 0 AND 8`
        ),
        check(
            "auth_pending_logins_authentication_version_check",
            sql`${table.authenticationVersion} BETWEEN 1 AND 9007199254740991`
        ),
        check("auth_pending_logins_id_check", lowercaseHexTextCheck(table.id, 32)),
        check(
            "auth_pending_logins_time_check",
            sql`${timestampMillisecondsCheck(table.passwordVerifiedAt)} AND ${timestampMillisecondsCheck(table.createdAt)} AND ${timestampMillisecondsCheck(table.expiresAt)} AND ${table.passwordVerifiedAt} <= ${table.createdAt} AND ${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.passwordVerifiedAt} + ${sql.raw(String(pendingLoginLifetimeMs))}`
        ),
        check(
            "auth_pending_logins_user_agent_check",
            sql`${table.userAgent} IS NULL OR (${boundedNonBlankTextCheck(table.userAgent, browserSessionUserAgentMaximumLength)})`
        ),
        check(
            "auth_pending_logins_validator_hash_check",
            lowercaseHexTextCheck(table.validatorHash, 64)
        ),
        check(
            "auth_pending_logins_validator_version_check",
            sql`${table.validatorVersion} = ${sql.raw(String(opaqueTokenValidatorVersion))}`
        ),
        index("auth_pending_logins_expires_at_idx").on(table.expiresAt, table.id),
        index("auth_pending_logins_replaced_session_id_idx").on(table.replacedSessionId),
        index("auth_pending_logins_user_expires_at_idx").on(
            table.userId,
            table.expiresAt,
            table.id
        ),
        uniqueIndex("auth_pending_logins_validator_hash_unique").on(table.validatorHash),
    ]
);
