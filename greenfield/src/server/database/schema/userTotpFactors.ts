import { isNotNull, isNull, sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { totpFactorLabelMaximumLength } from "../../../contracts/accountSecurity.ts";
import {
    boundedControlSafeTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";
import { encryptedTotpSecretEnvelopeCheck, mfaSecretKeyIdCheck } from "./mfaFormats.ts";
import { users } from "./users.ts";

export const totpEnrollmentLifetimeMaximumMs = 5 * 60 * 1000;

/** Encrypted RFC 6238 factors, including an explicit non-destructive enrollment state. */
export const userTotpFactors = sqliteTable(
    "user_totp_factors",
    {
        confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        encryptedSecret: text("encrypted_secret").notNull(),
        enrollmentExpiresAt: integer("enrollment_expires_at", {
            mode: "timestamp_ms",
        }).notNull(),
        id: text("id").notNull().primaryKey(),
        label: text("label").notNull(),
        lastUsedStep: integer("last_used_step"),
        secretKeyId: text("secret_key_id").notNull(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
    },
    (table) => [
        check("user_totp_factors_id_check", uuidV7TextCheck(table.id)),
        check(
            "user_totp_factors_label_check",
            boundedControlSafeTextCheck(table.label, totpFactorLabelMaximumLength)
        ),
        check(
            "user_totp_factors_secret_key_id_check",
            mfaSecretKeyIdCheck(table.secretKeyId)
        ),
        check(
            "user_totp_factors_encrypted_secret_check",
            encryptedTotpSecretEnvelopeCheck(table.encryptedSecret)
        ),
        check(
            "user_totp_factors_enrollment_time_check",
            sql`${timestampMillisecondsCheck(table.createdAt)} AND ${timestampMillisecondsCheck(table.enrollmentExpiresAt)} AND ${table.enrollmentExpiresAt} > ${table.createdAt} AND ${table.enrollmentExpiresAt} <= ${table.createdAt} + ${sql.raw(String(totpEnrollmentLifetimeMaximumMs))}`
        ),
        check(
            "user_totp_factors_confirmation_check",
            sql`(${table.confirmedAt} IS NULL AND ${table.lastUsedStep} IS NULL) OR (${table.confirmedAt} IS NOT NULL AND ${table.lastUsedStep} IS NOT NULL AND ${timestampMillisecondsCheck(table.confirmedAt)} AND ${table.confirmedAt} >= ${table.createdAt} AND ${table.confirmedAt} < ${table.enrollmentExpiresAt} AND ${table.lastUsedStep} BETWEEN 0 AND 9007199254740991)`
        ),
        index("user_totp_factors_pending_user_expiry_idx")
            .on(table.userId, table.enrollmentExpiresAt, table.id)
            .where(isNull(table.confirmedAt)),
        index("user_totp_factors_confirmed_user_created_idx")
            .on(table.userId, table.createdAt, table.id)
            .where(isNotNull(table.confirmedAt)),
        index("user_totp_factors_pending_expiry_idx")
            .on(table.enrollmentExpiresAt, table.id)
            .where(isNull(table.confirmedAt)),
    ]
);
