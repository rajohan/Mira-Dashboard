import * as v from "valibot";

import {
    monitoringJsonObjectMaximumBytes,
    monitoringJsonObjectSchema,
} from "../../../contracts/monitoring.ts";
import { nonnegativeDateAction } from "../../../shared/dateTime.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { lowercaseUuidV7Action } from "../../../shared/validation.ts";

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
}

/** Restricts a Drizzle text identifier to the canonical lowercase UUIDv7 form. */
export const uuidV7Action = lowercaseUuidV7Action();

/**
 * Refines a generated Drizzle text schema to a canonical lowercase UUIDv7.
 * @param schema Generated Drizzle string schema.
 * @returns Refined UUIDv7 schema.
 */
export function uuidV7TextSchema(schema: v.StringSchema<undefined>) {
    return v.pipe(schema, uuidV7Action);
}

/** Requires a Drizzle text column to contain syntactically valid JSON. */
export const validJsonTextAction = v.check(
    (value: string) => parseJson(value) !== undefined,
    "Expected valid JSON text."
);

/** Requires JSON text whose top-level value is an object rather than an array or scalar. */
export const jsonObjectTextAction = v.check((value: string) => {
    if (utf8ByteLength(value) > monitoringJsonObjectMaximumBytes) {
        return false;
    }
    const parsed = parseJson(value);
    return v.safeParse(monitoringJsonObjectSchema, parsed).success;
}, "Expected bounded monitoring JSON text with an object root.");

/**
 * Refines a generated Drizzle text schema to JSON with an object root.
 * @param schema Generated Drizzle string schema.
 * @returns Refined bounded JSON-object text schema.
 */
export function jsonObjectTextSchema(schema: v.StringSchema<undefined>) {
    return v.pipe(schema, jsonObjectTextAction);
}

/**
 * Refines a generated Drizzle Date schema to the system's nonnegative epoch policy.
 * @param schema Generated Drizzle Date schema.
 * @returns Refined nonnegative epoch Date schema.
 */
export function nonnegativeDateSchema(schema: v.DateSchema<undefined>) {
    return v.pipe(schema, nonnegativeDateAction());
}
