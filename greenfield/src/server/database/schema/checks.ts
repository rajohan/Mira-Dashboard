import { maxTime } from "date-fns/constants";
import { sql, type SQLWrapper } from "drizzle-orm";

const sqliteWhitespace = sql`char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)`;

const controlOrFormatGlob = sql`('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(173) || char(1536) || '-' || char(1541) || char(1564) || char(1757) || char(1807) || char(2192) || '-' || char(2193) || char(2274) || char(6158) || char(8203) || '-' || char(8207) || char(8234) || '-' || char(8238) || char(8288) || '-' || char(8292) || char(8294) || '-' || char(8303) || char(65279) || char(65529) || '-' || char(65531) || char(69821) || char(69837) || char(78896) || '-' || char(78911) || char(113824) || '-' || char(113827) || char(119155) || '-' || char(119162) || char(917505) || char(917536) || '-' || char(917631) || ']*')`;

/**
 * Builds a SQLite check that rejects embedded NUL characters.
 * @param column SQLite text column to validate.
 * @returns Drizzle SQL expression for the storage constraint.
 */
export function nulFreeTextCheck(column: SQLWrapper) {
    return sql`instr(${column}, char(0)) = 0`;
}

/**
 * Builds a SQLite check matching a fixed-length lowercase hexadecimal boundary.
 * @param column SQLite text column to validate.
 * @param exactLength Required hexadecimal character count.
 * @returns Drizzle SQL expression for the storage constraint.
 */
export function lowercaseHexTextCheck(column: SQLWrapper, exactLength: 32 | 64) {
    const exactLengthSql = sql.raw(String(exactLength));
    return sql`length(${column}) = ${exactLengthSql} AND ${nulFreeTextCheck(column)} AND ${column} NOT GLOB '*[^0-9a-f]*'`;
}

/**
 * Builds a SQLite check matching canonical unpadded base64url text.
 * The terminal-character rules reject encodings with non-zero unused bits, so
 * every accepted value has exactly one textual representation.
 * @param column SQLite text column to validate.
 * @param minimumLength Minimum accepted ASCII character count.
 * @param maximumLength Maximum accepted ASCII character count.
 * @returns Drizzle SQL expression for the storage constraint.
 */
export function boundedCanonicalBase64UrlTextCheck(
    column: SQLWrapper,
    minimumLength: number,
    maximumLength: number
) {
    const minimumLengthSql = sql.raw(String(minimumLength));
    const maximumLengthSql = sql.raw(String(maximumLength));
    return sql`length(${column}) BETWEEN ${minimumLengthSql} AND ${maximumLengthSql} AND ${nulFreeTextCheck(column)} AND ${column} NOT GLOB '*[^A-Za-z0-9_-]*' AND (length(${column}) % 4 = 0 OR (length(${column}) % 4 = 2 AND substr(${column}, -1, 1) GLOB '[AQgw]') OR (length(${column}) % 4 = 3 AND substr(${column}, -1, 1) GLOB '[AEIMQUYcgkosw048]'))`;
}

/**
 * Builds a SQLite check matching a bounded, nonblank, NUL-free text boundary.
 * @param column SQLite text column to validate.
 * @param maximumLength Maximum accepted Unicode code-point length.
 * @returns Drizzle SQL expression for the storage constraint.
 */
export function boundedNonBlankTextCheck(column: SQLWrapper, maximumLength: number) {
    const maximumLengthSql = sql.raw(String(maximumLength));
    return sql`length(${column}) BETWEEN 1 AND ${maximumLengthSql} AND ${nulFreeTextCheck(column)} AND length(trim(${column}, ${sqliteWhitespace})) > 0`;
}

/**
 * Builds a SQLite check for bounded human text without Unicode controls or formats.
 * NUL is checked separately because SQLite string functions stop at embedded NUL bytes.
 * @param column SQLite text column to validate.
 * @param maximumLength Maximum accepted Unicode code-point length.
 * @returns Drizzle SQL expression for the storage constraint.
 */
export function boundedControlSafeTextCheck(column: SQLWrapper, maximumLength: number) {
    return sql`${boundedNonBlankTextCheck(column, maximumLength)} AND ${column} NOT GLOB ${controlOrFormatGlob}`;
}

/**
 * Builds a SQLite check for epoch milliseconds representable by JavaScript Date.
 * @param column SQLite integer timestamp column to validate.
 * @returns Drizzle SQL expression for the storage constraint.
 */
export function timestampMillisecondsCheck(column: SQLWrapper) {
    const maximumTimestampSql = sql.raw(String(maxTime));
    return sql`${column} BETWEEN 0 AND ${maximumTimestampSql}`;
}

/**
 * Builds a SQLite check matching the canonical lowercase UUIDv7 boundary.
 * @param column SQLite text column to validate.
 * @returns Drizzle SQL expression for the storage constraint.
 */
export function uuidV7TextCheck(column: SQLWrapper) {
    return sql`length(${column}) = 36 AND ${nulFreeTextCheck(column)} AND length(replace(${column}, '-', '')) = 32 AND replace(${column}, '-', '') NOT GLOB '*[^0-9a-f]*' AND substr(${column}, 9, 1) = '-' AND substr(${column}, 14, 1) = '-' AND substr(${column}, 15, 1) = '7' AND substr(${column}, 19, 1) = '-' AND substr(${column}, 20, 1) GLOB '[89ab]' AND substr(${column}, 24, 1) = '-'`;
}
