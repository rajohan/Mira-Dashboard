/** Controls serialization of unknown values for user-facing text. */
export interface DisplaySerializationOptions {
    fallback?: string;
    indentation?: number;
}

/**
 * Serializes an unknown value without falling back to Object's `[object Object]`.
 * @param value - Value crossing into a user-facing text boundary.
 * @param options - Optional indentation and failure text.
 * @returns A stable representation suitable for display.
 */
export function serializeForDisplay(
    value: unknown,
    options: DisplaySerializationOptions = {}
): string {
    if (typeof value === "string") {
        return value;
    }
    if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
    ) {
        return String(value);
    }
    if (typeof value === "symbol") {
        return `Symbol(${value.description ?? ""})`;
    }
    if (typeof value === "function") {
        return value.name ? `[Function ${value.name}]` : "[Anonymous function]";
    }
    if (value === undefined) {
        return "undefined";
    }
    if (value === null) {
        return "null";
    }

    try {
        const serialized = JSON.stringify(value, undefined, options.indentation);
        return serialized ?? options.fallback ?? "[Unserializable value]";
    } catch {
        return options.fallback ?? "[Unserializable value]";
    }
}
