import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { opaqueTokenValidatorVersion } from "../../shared/opaqueToken.ts";
import {
    lowercaseHexTextCheck,
    nulFreeTextCheck,
    timestampMillisecondsCheck,
} from "./checks.ts";
import { users } from "./users.ts";

export const passwordResetTokenLifetimeMaximumMs = 15 * 60 * 1000;

/** Hashed, short-lived, single-use password-reset tokens. */
export const authPasswordResetTokens = sqliteTable(
    "auth_password_reset_tokens",
    {
        authenticationVersion: integer("authentication_version").notNull(),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
        pendingEmail: text("pending_email"),
        prefix: text("prefix").notNull().primaryKey(),
        purpose: text("purpose", {
            enum: ["email-verification", "password-reset"],
        }).notNull(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        validatorHash: text("validator_hash").notNull(),
        validatorVersion: integer("validator_version").notNull(),
    },
    (table) => [
        check(
            "auth_password_reset_tokens_authentication_version_check",
            sql`${table.authenticationVersion} BETWEEN 1 AND 9007199254740991`
        ),
        check(
            "auth_password_reset_tokens_pending_email_check",
            sql`(${table.purpose} = 'password-reset' AND ${table.pendingEmail} IS NULL) OR (${table.purpose} = 'email-verification' AND length(${table.pendingEmail}) BETWEEN 3 AND 254 AND ${nulFreeTextCheck(table.pendingEmail)} AND ${table.pendingEmail} = lower(${table.pendingEmail}) AND instr(${table.pendingEmail}, '@') BETWEEN 2 AND length(${table.pendingEmail}) - 2 AND instr(${table.pendingEmail}, ' ') = 0)`
        ),
        check(
            "auth_password_reset_tokens_prefix_check",
            lowercaseHexTextCheck(table.prefix, 32)
        ),
        check(
            "auth_password_reset_tokens_validator_hash_check",
            lowercaseHexTextCheck(table.validatorHash, 64)
        ),
        check(
            "auth_password_reset_tokens_validator_version_check",
            sql`${table.validatorVersion} = ${opaqueTokenValidatorVersion}`
        ),
        check(
            "auth_password_reset_tokens_time_check",
            sql`${timestampMillisecondsCheck(table.createdAt)} AND ${timestampMillisecondsCheck(table.expiresAt)} AND ${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + ${passwordResetTokenLifetimeMaximumMs}`
        ),
        index("auth_password_reset_tokens_expires_idx").on(table.expiresAt, table.prefix),
        index("auth_password_reset_tokens_user_purpose_idx").on(
            table.userId,
            table.purpose
        ),
    ]
);
