import { sql, type SQLWrapper } from "drizzle-orm";

import {
    dashboardPasswordHashBase64CharacterClass,
    dashboardPasswordHashCanonicalTailCharacters,
    dashboardPasswordHashEncodedValueLength,
    dashboardPasswordHashLength,
    dashboardPasswordHashPrefix,
} from "../../shared/passwordHash.ts";
import { nulFreeTextCheck } from "./checks.ts";

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

/**
 * Builds the exact Bun Argon2id PHC boundary shared by operator and recovery hashes.
 * @param column SQLite text column containing a canonical hash.
 * @returns Drizzle SQL expression for the reviewed Argon2id representation.
 */
export function dashboardPasswordHashCheck(column: SQLWrapper) {
    return sql`length(${column}) = ${passwordHashSql.length} AND ${nulFreeTextCheck(column)} AND substr(${column}, 1, ${passwordHashSql.prefixLength}) = ${passwordHashSql.prefix} AND substr(${column}, ${passwordHashSql.separatorPosition}, 1) = '$' AND substr(${column}, ${passwordHashSql.saltStart}, ${passwordHashSql.encodedValueLength}) NOT GLOB ${passwordHashSql.invalidBase64Glob} AND substr(${column}, ${passwordHashSql.digestStart}, ${passwordHashSql.encodedValueLength}) NOT GLOB ${passwordHashSql.invalidBase64Glob} AND substr(${column}, ${passwordHashSql.saltTailPosition}, 1) GLOB ${passwordHashSql.canonicalTailGlob} AND substr(${column}, ${passwordHashSql.length}, 1) GLOB ${passwordHashSql.canonicalTailGlob}`;
}
