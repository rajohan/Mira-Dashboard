import * as v from "valibot";

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
    | JsonObject
    | readonly JsonValue[]
    | boolean
    | null
    | number
    | string;

const maximumJsonDepth = 12;

function isJsonValue(
    value: unknown,
    depth: number,
    ancestors: Set<object>
): value is JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return true;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
    }
    if (typeof value !== "object" || depth > maximumJsonDepth || ancestors.has(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        return false;
    }

    ancestors.add(value);
    let valid = true;
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            if (!(index in value) || !isJsonValue(value[index], depth + 1, ancestors)) {
                valid = false;
                break;
            }
        }
    } else {
        valid = Object.values(value).every((child) =>
            isJsonValue(child, depth + 1, ancestors)
        );
    }
    ancestors.delete(value);
    return valid;
}

/** Shared JSON object structure with safe-magnitude numbers and bounded plain objects. */
export const jsonObjectSchema = v.custom<JsonObject>(
    (value) =>
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        isJsonValue(value, 0, new Set()),
    "Expected a bounded JSON object."
);

/**
 * Parses JSON text without allowing a syntax failure to escape a validation predicate.
 * @param value Candidate JSON text.
 * @returns Parsed JSON, or undefined when the text is not valid JSON.
 */
export function parseJsonText(value: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
}
