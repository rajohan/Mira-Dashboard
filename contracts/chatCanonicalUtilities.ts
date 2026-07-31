function canonicalValue(value: unknown, ancestors: Set<object>): unknown {
    if (value === null) return ["null"];
    if (value === undefined) return ["undefined"];
    if (typeof value === "bigint") return ["bigint", value.toString()];
    if (typeof value === "number") {
        let encoded: number | string = Number.isFinite(value) ? value : String(value);
        if (Object.is(value, -0)) {
            encoded = "-0";
        }
        return ["number", encoded];
    }
    if (typeof value === "string" || typeof value === "boolean") {
        return [typeof value, value];
    }
    if (typeof value === "symbol") return ["symbol", value.description ?? ""];
    if (typeof value === "function") {
        return ["function", value.name || "anonymous"];
    }
    if (typeof value !== "object") return [typeof value];
    if (ancestors.has(value)) return ["circular"];

    const nested = new Set(ancestors).add(value);
    if (Array.isArray(value)) {
        return ["array", value.map((item) => canonicalValue(item, nested))];
    }
    return [
        "object",
        value.constructor?.name || "Object",
        Object.entries(value as Record<string, unknown>)
            .toSorted(([left], [right]) => {
                if (left < right) {
                    return -1;
                }
                if (left > right) {
                    return 1;
                }
                return 0;
            })
            .map(([key, item]) => [key, canonicalValue(item, nested)]),
    ];
}

export const MAX_CANONICAL_CHAT_TEXT_CHARACTERS = 1024 * 1024;
export const MAX_CANONICAL_TOOL_RESULT_CHARACTERS = 256 * 1024;
const MAX_CANONICAL_TOOL_VALUE_NODES = 1000;
const MAX_CANONICAL_TOOL_VALUE_STRING_CHARACTERS = 256 * 1024;
const MAX_CANONICAL_TOOL_VALUE_DEPTH = 8;
const TRUNCATED_CANONICAL_CHAT_SUFFIX = "\n… [truncated by Dashboard]";

interface CanonicalToolValueBudget {
    remainingNodes: number;
    remainingStringCharacters: number;
}

/**
 * Truncates provider text before it enters retained canonical chat state.
 * @param value Provider-controlled text.
 * @param maximumCharacters Maximum retained characters.
 * @returns Bounded text with an explicit truncation marker.
 */
export function truncateCanonicalChatText(
    value: string,
    maximumCharacters = MAX_CANONICAL_CHAT_TEXT_CHARACTERS
): string {
    if (value.length <= maximumCharacters) {
        return value;
    }
    if (maximumCharacters <= TRUNCATED_CANONICAL_CHAT_SUFFIX.length) {
        return TRUNCATED_CANONICAL_CHAT_SUFFIX.slice(0, maximumCharacters);
    }
    const retainedCharacters = Math.max(
        0,
        maximumCharacters - TRUNCATED_CANONICAL_CHAT_SUFFIX.length
    );
    return `${value.slice(0, retainedCharacters)}${TRUNCATED_CANONICAL_CHAT_SUFFIX}`;
}

function boundedCanonicalToolValue(
    value: unknown,
    budget: CanonicalToolValueBudget,
    depth: number,
    ancestors: Set<object>
): unknown {
    if (budget.remainingNodes <= 0) {
        return "[Truncated]";
    }
    budget.remainingNodes -= 1;

    if (typeof value === "string") {
        const maximum = Math.max(0, budget.remainingStringCharacters);
        const bounded = truncateCanonicalChatText(value, maximum);
        budget.remainingStringCharacters = Math.max(
            0,
            budget.remainingStringCharacters - bounded.length
        );
        return bounded;
    }
    if (
        value === null ||
        value === undefined ||
        typeof value === "number" ||
        typeof value === "boolean"
    ) {
        return value;
    }
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (typeof value === "symbol") {
        return `Symbol(${value.description ?? ""})`;
    }
    if (typeof value === "function") {
        return value.name ? `[Function ${value.name}]` : "[Anonymous function]";
    }
    if (depth >= MAX_CANONICAL_TOOL_VALUE_DEPTH) {
        return "[Truncated depth]";
    }
    if (ancestors.has(value)) {
        return "[Circular]";
    }

    const nestedAncestors = new Set(ancestors).add(value);
    if (Array.isArray(value)) {
        const result: unknown[] = [];
        for (const item of value) {
            if (budget.remainingNodes <= 0) {
                result.push("[Truncated items]");
                break;
            }
            result.push(
                boundedCanonicalToolValue(item, budget, depth + 1, nestedAncestors)
            );
        }
        return result;
    }

    let entries: Array<[string, unknown]>;
    try {
        entries = Object.entries(value as Record<string, unknown>);
    } catch {
        return "[Unreadable object]";
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) {
        if (budget.remainingNodes <= 0 || budget.remainingStringCharacters <= 0) {
            result["[truncated]"] = "[Truncated properties]";
            break;
        }
        const boundedKey = truncateCanonicalChatText(
            key,
            Math.min(4096, budget.remainingStringCharacters)
        );
        budget.remainingStringCharacters = Math.max(
            0,
            budget.remainingStringCharacters - boundedKey.length
        );
        try {
            result[boundedKey] = boundedCanonicalToolValue(
                item,
                budget,
                depth + 1,
                nestedAncestors
            );
        } catch {
            result[boundedKey] = "[Unreadable value]";
        }
    }
    return result;
}

/**
 * Bounds arbitrary tool arguments before serialization, identity work, and UI state.
 * @param value Provider-controlled tool value.
 * @returns A display-equivalent bounded value.
 */
export function boundCanonicalChatToolValue(value: unknown): unknown {
    return boundedCanonicalToolValue(
        value,
        {
            remainingNodes: MAX_CANONICAL_TOOL_VALUE_NODES,
            remainingStringCharacters: MAX_CANONICAL_TOOL_VALUE_STRING_CHARACTERS,
        },
        0,
        new Set()
    );
}

/**
 * Serializes JSON-like values independently of object key order.
 * @param value Value to serialize.
 * @returns Stable serialized value.
 */
export function stableCanonicalChatStringify(value: unknown): string {
    return JSON.stringify(canonicalValue(value, new Set())) ?? "undefined";
}

/**
 * Keeps defined chat identities once and in first-seen order.
 * @param values Candidate identities.
 * @returns Unique defined identities.
 */
export function uniqueCanonicalChatIds(values: Array<string | undefined>): string[] {
    return [...new Set(values.filter(Boolean))] as string[];
}

/**
 * Converts a timestamp to an ISO string.
 * @param value Date-like value.
 * @returns ISO timestamp.
 */
export function canonicalIsoString(value: number | string | Date): string {
    return new Date(value).toISOString();
}

/**
 * Serializes an unknown provider value for display without Object coercion.
 * @param value Provider value.
 * @param fallback Text returned when serialization fails.
 * @param indentation JSON indentation.
 * @returns Display-safe text.
 */
export function serializeCanonicalChatValue(
    value: unknown,
    fallback = "[Runtime value could not be serialized]",
    indentation = 2
): string {
    if (typeof value === "string") return value;
    if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
    ) {
        return String(value);
    }
    if (typeof value === "symbol") return `Symbol(${value.description ?? ""})`;
    if (typeof value === "function") {
        return value.name ? `[Function ${value.name}]` : "[Anonymous function]";
    }
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    try {
        return JSON.stringify(value, undefined, indentation) ?? fallback;
    } catch {
        return fallback;
    }
}
