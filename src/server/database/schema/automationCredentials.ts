import { sql } from "drizzle-orm";
import {
    type AnySQLiteColumn,
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { automationPrincipals } from "./automationPrincipals.ts";
import {
    boundedControlSafeTextCheck,
    lowercaseHexTextCheck,
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
        prefix: text("prefix").notNull(),
        principalId: text("principal_id")
            .notNull()
            .references(() => automationPrincipals.id, { onDelete: "cascade" }),
        // The reviewed baseline adds triggers that enforce this predecessor belongs
        // to the same principal on insert and on either side of relationship updates.
        replacesCredentialId: text("replaces_credential_id").references(
            (): AnySQLiteColumn => automationCredentials.id,
            { onDelete: "set null" }
        ),
        revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
        validatorHash: text("validator_hash").notNull(),
        validatorVersion: integer("validator_version").notNull().default(1),
    },
    (table) => [
        check("automation_credentials_id_check", uuidV7TextCheck(table.id)),
        check(
            "automation_credentials_label_check",
            boundedControlSafeTextCheck(table.label, 128)
        ),
        check(
            "automation_credentials_prefix_check",
            lowercaseHexTextCheck(table.prefix, 32)
        ),
        check(
            "automation_credentials_validator_hash_check",
            lowercaseHexTextCheck(table.validatorHash, 64)
        ),
        check(
            "automation_credentials_validator_version_check",
            sql`${table.validatorVersion} = 1`
        ),
        check(
            "automation_credentials_replacement_check",
            sql`${table.replacesCredentialId} IS NULL OR (${uuidV7TextCheck(table.replacesCredentialId)} AND ${table.replacesCredentialId} <> ${table.id})`
        ),
        check(
            "automation_credentials_time_check",
            sql`${timestampMillisecondsCheck(table.createdAt)} AND (${table.expiresAt} IS NULL OR (${timestampMillisecondsCheck(table.expiresAt)} AND ${table.expiresAt} > ${table.createdAt})) AND (${table.revokedAt} IS NULL OR (${timestampMillisecondsCheck(table.revokedAt)} AND ${table.revokedAt} >= ${table.createdAt}))`
        ),
        index("automation_credentials_principal_created_idx").on(
            table.principalId,
            table.createdAt,
            table.id
        ),
        index("automation_credentials_active_principal_created_idx")
            .on(table.principalId, table.createdAt, table.id)
            .where(sql`${table.revokedAt} IS NULL`),
        index("automation_credentials_replacement_idx").on(table.replacesCredentialId),
        uniqueIndex("automation_credentials_active_replacement_unique")
            .on(table.replacesCredentialId)
            .where(
                sql`${table.replacesCredentialId} IS NOT NULL AND ${table.revokedAt} IS NULL`
            ),
        uniqueIndex("automation_credentials_prefix_unique").on(table.prefix),
        uniqueIndex("automation_credentials_validator_unique").on(
            table.validatorVersion,
            table.validatorHash
        ),
    ]
);
