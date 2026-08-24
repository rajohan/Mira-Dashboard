import { sql, type SQLWrapper } from "drizzle-orm";

import {
    retiredScheduledActionTerminalCode,
    retiredScheduledActionTerminalMessage,
} from "../../../contracts/jobModel.ts";
import {
    boundedControlSafeTextCheck,
    boundedNonBlankTextCheck,
    nulFreeTextCheck,
    uuidV7TextCheck,
} from "./checks.ts";

/** Maximum executable action identities advertised by one worker process. */
export const workerActionKeyMaximum = 32;
/** Maximum canonical UTF-8 JSON representation retained in one worker row. */
export const workerActionKeysMaximumBytes = 4 * 1024;

const retiredScheduledActionTerminalCodeSql = sql.raw(
    `'${retiredScheduledActionTerminalCode}'`
);
const retiredScheduledActionTerminalMessageSql = sql.raw(
    `'${retiredScheduledActionTerminalMessage}'`
);

/**
 * Exact SQL form of the only failed lifecycle admitted before attempt one.
 * @param columns Durable run columns participating in the canonical predicate.
 * @returns Canonical predicate shared by durable job-row constraints.
 */
export function unstartedRetiredScheduleFailureCheck(columns: {
    readonly attemptCount: SQLWrapper;
    readonly cancellationPolicy: SQLWrapper;
    readonly state: SQLWrapper;
    readonly terminalCode: SQLWrapper;
    readonly terminalMessage: SQLWrapper;
    readonly triggerType: SQLWrapper;
}) {
    return sql`${columns.state} = 'failed' AND ${columns.attemptCount} = 0 AND ${columns.cancellationPolicy} = 'never' AND ${columns.triggerType} = 'schedule' AND ${columns.terminalCode} = ${retiredScheduledActionTerminalCodeSql} AND ${columns.terminalMessage} = ${retiredScheduledActionTerminalMessageSql}`;
}

/**
 * Canonical lowercase identifier used by schedules, actions, and resource leases.
 * @returns SQL predicate for the bounded canonical key.
 */
export function boundedJobKeyCheck(column: SQLWrapper, maximumLength: number) {
    const maximumLengthSql = sql.raw(String(maximumLength));
    return sql`length(${column}) BETWEEN 1 AND ${maximumLengthSql} AND ${nulFreeTextCheck(column)} AND ${column} = lower(${column}) AND substr(${column}, 1, 1) GLOB '[a-z0-9]' AND ${column} NOT GLOB '*[^a-z0-9._-]*'`;
}

/**
 * UTF-8 byte-bounded JSON object stored in canonical text form.
 * @returns SQL predicate for an object-root JSON value within its byte budget.
 */
export function boundedJsonObjectCheck(column: SQLWrapper, maximumBytes: number) {
    const maximumBytesSql = sql.raw(String(maximumBytes));
    return sql`length(CAST(${column} AS BLOB)) <= ${maximumBytesSql} AND CASE WHEN json_valid(${column}) THEN json_type(${column}) = 'object' ELSE 0 END`;
}

/**
 * UTF-8 byte-bounded JSON array stored in canonical text form.
 * @returns SQL predicate for an array-root JSON value within its byte budget.
 */
export function boundedJsonArrayCheck(column: SQLWrapper, maximumBytes: number) {
    const maximumBytesSql = sql.raw(String(maximumBytes));
    return sql`length(CAST(${column} AS BLOB)) <= ${maximumBytesSql} AND CASE WHEN json_valid(${column}) THEN json_type(${column}) = 'array' ELSE 0 END`;
}

/**
 * Actor identity accepted by durable job mutations and lifecycle transitions.
 * @returns SQL predicate for an allowed actor kind and canonical identity.
 */
export function jobActorCheck(
    kind: SQLWrapper,
    id: SQLWrapper,
    options: { readonly allowSystem?: boolean } = {}
) {
    const system =
        options.allowSystem === true
            ? sql` OR (${kind} = 'system' AND ${boundedJobKeyCheck(id, 128)})`
            : sql``;
    return sql`((${kind} = 'user' AND ${uuidV7TextCheck(id)}) OR (${kind} = 'automation' AND ${boundedJobKeyCheck(id, 64)})${system})`;
}

/**
 * Optional bounded human-readable terminal or progress message.
 * @returns SQL predicate for a null or bounded safe message.
 */
export function optionalJobMessageCheck(
    column: SQLWrapper,
    maximumCodePoints: number,
    maximumBytes: number
) {
    const maximumBytesSql = sql.raw(String(maximumBytes));
    return sql`(${column} IS NULL OR (${boundedControlSafeTextCheck(column, maximumCodePoints)} AND length(CAST(${column} AS BLOB)) <= ${maximumBytesSql}))`;
}

/**
 * Optional lowercase terminal code with one slash-delimited namespace.
 * @returns SQL predicate for a null or canonical terminal code.
 */
export function optionalJobTerminalCodeCheck(column: SQLWrapper, maximumLength: number) {
    const maximumLengthSql = sql.raw(String(maximumLength));
    return sql`(${column} IS NULL OR (length(${column}) BETWEEN 1 AND ${maximumLengthSql} AND ${nulFreeTextCheck(column)} AND ${column} = lower(${column}) AND substr(${column}, 1, 1) GLOB '[a-z0-9]' AND ${column} NOT GLOB '*[^a-z0-9._/-]*'))`;
}

/**
 * Optional bounded, nonblank identifier that preserves case.
 * @returns SQL predicate for a null or bounded identifier.
 */
export function optionalBoundedJobTextCheck(column: SQLWrapper, maximumLength: number) {
    return sql`(${column} IS NULL OR (${boundedNonBlankTextCheck(column, maximumLength)}))`;
}
