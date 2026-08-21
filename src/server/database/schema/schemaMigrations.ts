import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { lowercaseHexTextCheck, timestampMillisecondsCheck } from "./checks.ts";

/** Immutable migration history verified by Dashboard's migration runner. */
export const schemaMigrations = sqliteTable(
    "schema_migrations",
    {
        appliedAt: integer("applied_at", { mode: "timestamp_ms" }).notNull(),
        checksum: text("checksum").notNull(),
        id: text("id").notNull().primaryKey(),
        releaseId: text("release_id").notNull(),
    },
    (table) => [
        check(
            "schema_migrations_applied_at_check",
            timestampMillisecondsCheck(table.appliedAt)
        ),
        check(
            "schema_migrations_checksum_check",
            lowercaseHexTextCheck(table.checksum, 64)
        ),
        check(
            "schema_migrations_id_check",
            sql`length(${table.id}) BETWEEN 16 AND 128 AND instr(${table.id}, char(0)) = 0 AND substr(${table.id}, 1, 14) NOT GLOB '*[^0-9]*' AND substr(${table.id}, 15, 1) = '_' AND substr(${table.id}, 16, 1) GLOB '[a-z0-9]' AND substr(${table.id}, 16) NOT GLOB '*[^a-z0-9_-]*'`
        ),
        check(
            "schema_migrations_release_id_check",
            sql`length(${table.releaseId}) = 40 AND instr(${table.releaseId}, char(0)) = 0 AND ${table.releaseId} NOT GLOB '*[^0-9a-f]*'`
        ),
    ]
);
