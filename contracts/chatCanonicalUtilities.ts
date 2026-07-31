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
