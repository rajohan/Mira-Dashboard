import { sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { automationPrincipals } from "./automationPrincipals.ts";
import {
    boundedNonBlankTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";

/** Individually rotatable validators for one automation principal. */
export const automationCredentials = sqliteTable(
    "automation_credentials",
    {
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
        id: text("id").notNull().primaryKey(),
        label: text("label").notNull(),
        lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
        prefix: text("prefix").notNull(),
        principalId: text("principal_id")
            .notNull()
            .references(() => automationPrincipals.id, { onDelete: "cascade" }),
        revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
        validatorHash: text("validator_hash").notNull(),
        validatorVersion: integer("validator_version").notNull().default(1),
    },
    (table) => [
        check("automation_credentials_id_check", uuidV7TextCheck(table.id)),
        check(
            "automation_credentials_label_check",
            boundedNonBlankTextCheck(table.label, 128)
        ),
        check(
            "automation_credentials_prefix_check",
            sql`length(${table.prefix}) = 32 AND ${table.prefix} NOT GLOB '*[^0-9a-f]*'`
        ),
        check(
            "automation_credentials_validator_hash_check",
            sql`length(${table.validatorHash}) = 64 AND ${table.validatorHash} NOT GLOB '*[^0-9a-f]*'`
        ),
        check(
            "automation_credentials_validator_version_check",
            sql`${table.validatorVersion} = 1`
        ),
        check(
            "automation_credentials_time_check",
            sql`${timestampMillisecondsCheck(table.createdAt)} AND (${table.expiresAt} IS NULL OR (${timestampMillisecondsCheck(table.expiresAt)} AND ${table.expiresAt} > ${table.createdAt})) AND (${table.revokedAt} IS NULL OR (${timestampMillisecondsCheck(table.revokedAt)} AND ${table.revokedAt} >= ${table.createdAt})) AND (${table.lastUsedAt} IS NULL OR (${timestampMillisecondsCheck(table.lastUsedAt)} AND ${table.lastUsedAt} >= ${table.createdAt} AND (${table.expiresAt} IS NULL OR ${table.lastUsedAt} < ${table.expiresAt}) AND (${table.revokedAt} IS NULL OR ${table.lastUsedAt} <= ${table.revokedAt})))`
        ),
        index("automation_credentials_principal_created_idx").on(
            table.principalId,
            table.createdAt
        ),
        uniqueIndex("automation_credentials_prefix_unique").on(table.prefix),
        uniqueIndex("automation_credentials_validator_unique").on(
            table.validatorVersion,
            table.validatorHash
        ),
    ]
);
