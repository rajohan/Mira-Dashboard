import { sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

import {
    lowercaseHexTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";
import { dashboardPasswordHashCheck } from "./passwordHashCheck.ts";
import { users } from "./users.ts";

/** One selector-addressed, one-time recovery proof with an Argon2id validator. */
export const userRecoveryCodes = sqliteTable(
    "user_recovery_codes",
    {
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        id: text("id").notNull().primaryKey(),
        selector: text("selector").notNull(),
        usedAt: integer("used_at", { mode: "timestamp_ms" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        validatorHash: text("validator_hash").notNull(),
    },
    (table) => [
        check("user_recovery_codes_id_check", uuidV7TextCheck(table.id)),
        check(
            "user_recovery_codes_selector_check",
            lowercaseHexTextCheck(table.selector, 32)
        ),
        check(
            "user_recovery_codes_time_check",
            sql`${timestampMillisecondsCheck(table.createdAt)} AND (${table.usedAt} IS NULL OR (${timestampMillisecondsCheck(table.usedAt)} AND ${table.usedAt} >= ${table.createdAt}))`
        ),
        check(
            "user_recovery_codes_validator_hash_check",
            dashboardPasswordHashCheck(table.validatorHash)
        ),
        uniqueIndex("user_recovery_codes_user_selector_unique").on(
            table.userId,
            table.selector
        ),
        index("user_recovery_codes_user_used_created_idx").on(
            table.userId,
            table.usedAt,
            table.createdAt,
            table.id
        ),
    ]
);
