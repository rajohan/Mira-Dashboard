import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import {
    dashboardPasswordHashBase64CharacterClass,
    dashboardPasswordHashCanonicalTailCharacters,
    dashboardPasswordHashEncodedValueLength,
    dashboardPasswordHashLength,
    dashboardPasswordHashPrefix,
} from "../../shared/passwordHash.ts";
import {
    nulFreeTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";

function sqliteStringLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

const passwordHashPrefixLength = dashboardPasswordHashPrefix.length;
const passwordHashSaltStart = passwordHashPrefixLength + 1;
const passwordHashSeparatorPosition =
    passwordHashSaltStart + dashboardPasswordHashEncodedValueLength;
const passwordHashDigestStart = passwordHashSeparatorPosition + 1;
const passwordHashInvalidBase64Glob = `*[^${dashboardPasswordHashBase64CharacterClass}]*`;
const passwordHashCanonicalTailGlob = `[${dashboardPasswordHashCanonicalTailCharacters}]`;
const passwordHashSql = Object.freeze({
    canonicalTailGlob: sql.raw(sqliteStringLiteral(passwordHashCanonicalTailGlob)),
    digestStart: sql.raw(String(passwordHashDigestStart)),
    encodedValueLength: sql.raw(String(dashboardPasswordHashEncodedValueLength)),
    invalidBase64Glob: sql.raw(sqliteStringLiteral(passwordHashInvalidBase64Glob)),
    length: sql.raw(String(dashboardPasswordHashLength)),
    prefix: sql.raw(sqliteStringLiteral(dashboardPasswordHashPrefix)),
    prefixLength: sql.raw(String(passwordHashPrefixLength)),
    saltStart: sql.raw(String(passwordHashSaltStart)),
    saltTailPosition: sql.raw(String(passwordHashSeparatorPosition - 1)),
    separatorPosition: sql.raw(String(passwordHashSeparatorPosition)),
});

/** Dashboard operator identities and the version used to invalidate their sessions. */
export const users = sqliteTable(
    "users",
    {
        authenticationVersion: integer("authentication_version").notNull().default(1),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
        id: text("id").notNull().primaryKey(),
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
            "users_password_hash_check",
            sql`length(${table.passwordHash}) = ${passwordHashSql.length} AND ${nulFreeTextCheck(table.passwordHash)} AND substr(${table.passwordHash}, 1, ${passwordHashSql.prefixLength}) = ${passwordHashSql.prefix} AND substr(${table.passwordHash}, ${passwordHashSql.separatorPosition}, 1) = '$' AND substr(${table.passwordHash}, ${passwordHashSql.saltStart}, ${passwordHashSql.encodedValueLength}) NOT GLOB ${passwordHashSql.invalidBase64Glob} AND substr(${table.passwordHash}, ${passwordHashSql.digestStart}, ${passwordHashSql.encodedValueLength}) NOT GLOB ${passwordHashSql.invalidBase64Glob} AND substr(${table.passwordHash}, ${passwordHashSql.saltTailPosition}, 1) GLOB ${passwordHashSql.canonicalTailGlob} AND substr(${table.passwordHash}, ${passwordHashSql.length}, 1) GLOB ${passwordHashSql.canonicalTailGlob}`
        ),
        check(
            "users_username_check",
            sql`length(${table.username}) BETWEEN 3 AND 32 AND ${nulFreeTextCheck(table.username)} AND ${table.username} = lower(${table.username}) AND substr(${table.username}, 1, 1) GLOB '[a-z0-9]' AND ${table.username} NOT GLOB '*[^a-z0-9._-]*'`
        ),
        uniqueIndex("users_username_unique").on(table.username),
    ]
);
