import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import {
    nulFreeTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";
import { dashboardPasswordHashCheck } from "./passwordHashCheck.ts";

/** Dashboard operator identities and the version used to invalidate their sessions. */
export const users = sqliteTable(
    "users",
    {
        authenticationVersion: integer("authentication_version").notNull().default(1),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
        id: text("id").notNull().primaryKey(),
        mfaEnabledAt: integer("mfa_enabled_at", { mode: "timestamp_ms" }),
        passwordHash: text("password_hash").notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
        username: text("username").notNull(),
    },
    (table) => [
        check(
            "users_authentication_version_check",
            sql`${table.authenticationVersion} BETWEEN 1 AND 9007199254740991`
        ),
        check(
            "users_created_at_check",
            sql`${timestampMillisecondsCheck(table.createdAt)} AND ${timestampMillisecondsCheck(table.updatedAt)} AND ${table.updatedAt} >= ${table.createdAt}`
        ),
        check(
            "users_disabled_at_check",
            sql`${table.disabledAt} IS NULL OR (${timestampMillisecondsCheck(table.disabledAt)} AND ${table.disabledAt} >= ${table.createdAt} AND ${table.disabledAt} <= ${table.updatedAt})`
        ),
        check("users_id_check", uuidV7TextCheck(table.id)),
        check(
            "users_mfa_enabled_at_check",
            sql`${table.mfaEnabledAt} IS NULL OR (${timestampMillisecondsCheck(table.mfaEnabledAt)} AND ${table.mfaEnabledAt} >= ${table.createdAt} AND ${table.mfaEnabledAt} <= ${table.updatedAt})`
        ),
        check(
            "users_password_hash_check",
            dashboardPasswordHashCheck(table.passwordHash)
        ),
        check(
            "users_username_check",
            sql`length(${table.username}) BETWEEN 3 AND 32 AND ${nulFreeTextCheck(table.username)} AND ${table.username} = lower(${table.username}) AND substr(${table.username}, 1, 1) GLOB '[a-z0-9]' AND ${table.username} NOT GLOB '*[^a-z0-9._-]*'`
        ),
        uniqueIndex("users_username_unique").on(table.username),
    ]
);
