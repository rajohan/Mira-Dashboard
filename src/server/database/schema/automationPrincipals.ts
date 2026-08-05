import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { boundedNonBlankTextCheck, timestampMillisecondsCheck } from "./checks.ts";

/** Named non-browser callers whose privileges are granted independently of credentials. */
export const automationPrincipals = sqliteTable(
    "automation_principals",
    {
        authorizationVersion: integer("authorization_version").notNull().default(1),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
        id: text("id").notNull().primaryKey(),
        label: text("label").notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    },
    (table) => [
        check(
            "automation_principals_authorization_version_check",
            sql`${table.authorizationVersion} BETWEEN 1 AND 9007199254740991`
        ),
        check(
            "automation_principals_id_check",
            sql`length(${table.id}) BETWEEN 1 AND 64 AND ${table.id} = lower(${table.id}) AND substr(${table.id}, 1, 1) GLOB '[a-z0-9]' AND ${table.id} NOT GLOB '*[^a-z0-9._-]*'`
        ),
        check(
            "automation_principals_label_check",
            boundedNonBlankTextCheck(table.label, 128)
        ),
        check(
            "automation_principals_time_check",
            sql`${timestampMillisecondsCheck(table.createdAt)} AND ${timestampMillisecondsCheck(table.updatedAt)} AND ${table.updatedAt} >= ${table.createdAt} AND (${table.disabledAt} IS NULL OR (${timestampMillisecondsCheck(table.disabledAt)} AND ${table.disabledAt} >= ${table.createdAt} AND ${table.disabledAt} <= ${table.updatedAt}))`
        ),
    ]
);
