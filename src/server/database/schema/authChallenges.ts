import { isNotNull, sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { webAuthnChallengeMaximumLength } from "../../../contracts/webauthn.ts";
import { authPendingLogins } from "./authPendingLogins.ts";
import { authSessions } from "./authSessions.ts";
import {
    boundedCanonicalBase64UrlTextCheck,
    lowercaseHexTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";

export const webAuthnChallengeMinimumLength = 32;
export const webAuthnChallengeLifetimeMaximumMs = 5 * 60 * 1000;

/** Single-use, ceremony-bound WebAuthn challenges deleted when consumed. */
export const authChallenges = sqliteTable(
    "auth_challenges",
    {
        authenticationVersion: integer("authentication_version").notNull(),
        challenge: text("challenge").notNull(),
        configFingerprint: text("config_fingerprint").notNull(),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
        id: text("id").notNull().primaryKey(),
        pendingLoginId: text("pending_login_id").references(() => authPendingLogins.id, {
            onDelete: "cascade",
        }),
        purpose: text("purpose", {
            enum: ["login", "registration", "step-up"],
        }).notNull(),
        sessionId: text("session_id").references(() => authSessions.id, {
            onDelete: "cascade",
        }),
    },
    (table) => [
        check(
            "auth_challenges_authentication_version_check",
            sql`${table.authenticationVersion} BETWEEN 1 AND 9007199254740991`
        ),
        check(
            "auth_challenges_challenge_check",
            boundedCanonicalBase64UrlTextCheck(
                table.challenge,
                webAuthnChallengeMinimumLength,
                webAuthnChallengeMaximumLength
            )
        ),
        check(
            "auth_challenges_config_fingerprint_check",
            lowercaseHexTextCheck(table.configFingerprint, 64)
        ),
        check("auth_challenges_id_check", uuidV7TextCheck(table.id)),
        check(
            "auth_challenges_binding_check",
            sql`(${table.purpose} = 'login' AND ${table.pendingLoginId} IS NOT NULL AND ${table.sessionId} IS NULL) OR (${table.purpose} IN ('registration', 'step-up') AND ${table.sessionId} IS NOT NULL AND ${table.pendingLoginId} IS NULL)`
        ),
        check(
            "auth_challenges_time_check",
            sql`${timestampMillisecondsCheck(table.createdAt)} AND ${timestampMillisecondsCheck(table.expiresAt)} AND ${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + ${sql.raw(String(webAuthnChallengeLifetimeMaximumMs))}`
        ),
        index("auth_challenges_expires_at_idx").on(table.expiresAt, table.id),
        uniqueIndex("auth_challenges_pending_login_purpose_unique")
            .on(table.pendingLoginId, table.purpose)
            .where(isNotNull(table.pendingLoginId)),
        uniqueIndex("auth_challenges_session_purpose_unique")
            .on(table.sessionId, table.purpose)
            .where(isNotNull(table.sessionId)),
    ]
);
