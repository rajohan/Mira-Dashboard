import { maxTime } from "date-fns/constants";
import { sql, type SQLWrapper } from "drizzle-orm";

const sqliteWhitespace = sql`char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)`;

/**
 * Builds a SQLite check matching a bounded, nonblank, NUL-free text boundary.
 * @param column SQLite text column to validate.
 * @param maximumLength Maximum accepted Unicode code-point length.
 * @returns Drizzle SQL expression for the storage constraint.
 */
export function boundedNonBlankTextCheck(column: SQLWrapper, maximumLength: number) {
    const maximumLengthSql = sql.raw(String(maximumLength));
    return sql`length(${column}) BETWEEN 1 AND ${maximumLengthSql} AND instr(${column}, char(0)) = 0 AND length(trim(${column}, ${sqliteWhitespace})) > 0`;
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
    return sql`length(${column}) = 36 AND instr(${column}, char(0)) = 0 AND length(replace(${column}, '-', '')) = 32 AND replace(${column}, '-', '') NOT GLOB '*[^0-9a-f]*' AND substr(${column}, 9, 1) = '-' AND substr(${column}, 14, 1) = '-' AND substr(${column}, 15, 1) = '7' AND substr(${column}, 19, 1) = '-' AND substr(${column}, 20, 1) GLOB '[89ab]' AND substr(${column}, 24, 1) = '-'`;
}
