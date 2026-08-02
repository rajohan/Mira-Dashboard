const FACTOR_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const MAX_FACTOR_LABEL_LENGTH = 64;

/**
 * Validates and normalizes a user-visible factor label.
 * @param value Value to process.
 * @param fallback Fallback value.
 * @returns Validation result for and normalizes a user-visible factor label.
 */
export function normalizeFactorLabel(value: unknown, fallback: string): string {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== "string") {
        throw new TypeError("Factor label must be a string");
    }
    const normalized = value.replaceAll("\0", "").trim();
    if (!normalized || normalized.length > MAX_FACTOR_LABEL_LENGTH) {
        throw new TypeError(
            `Factor label must be 1-${MAX_FACTOR_LABEL_LENGTH} characters`
        );
    }
    return normalized;
}

/**
 * Validates an opaque factor identifier before using it in a query.
 * @param value Value to process.
 * @returns Validation result for an opaque factor identifier before using it in a query.
 */
export function normalizeFactorId(value: unknown): string {
    if (typeof value !== "string" || !FACTOR_ID_PATTERN.test(value)) {
        throw new TypeError("Invalid factor identifier");
    }
    return value;
}
