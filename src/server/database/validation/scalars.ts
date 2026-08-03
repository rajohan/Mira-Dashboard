import * as v from "valibot";

const UUID_V7_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
}

/** Restricts a Drizzle text identifier to an RFC-compatible UUIDv7. */
export const uuidV7Action = v.regex(UUID_V7_PATTERN, "Expected a UUIDv7 identifier.");

/** Requires a Drizzle text column to contain syntactically valid JSON. */
export const validJsonTextAction = v.check(
    (value: string) => parseJson(value) !== undefined,
    "Expected valid JSON text."
);

/** Requires JSON text whose top-level value is an object rather than an array or scalar. */
export const jsonObjectTextAction = v.check((value: string) => {
    const parsed = parseJson(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
}, "Expected JSON text with an object root.");
