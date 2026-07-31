/**
 * Returns an environment variable when it is set, otherwise a fallback.
 * @param name Name value.
 * @param fallback Fallback value.
 * @returns an environment variable when it is set, otherwise a fallback.
 */
export function environmentFallback(name: string, fallback: string): string {
    const value = process.env[name];
    return value ?? fallback;
}

/**
 * Returns an environment variable when it is non-empty, otherwise a fallback.
 * @param name Name value.
 * @param fallback Fallback value.
 * @returns an environment variable when it is non-empty, otherwise a fallback.
 */
export function nonEmptyEnvironmentFallback(name: string, fallback: string): string {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : fallback;
}

/**
 * Returns the validated effective Dashboard listen port.
 * @param value Value to process.
 * @returns the validated effective Dashboard listen port.
 */
export function resolveDashboardPort(value = process.env.PORT): number {
    const trimmed = value?.trim() ?? "";
    if (!/^\d+$/u.test(trimmed)) {
        return 3100;
    }
    const port = Number(trimmed);
    return port > 0 && port <= 65_535 ? port : 3100;
}

/**
 * Returns the explicit Dashboard bind host or the production-compatible default.
 * @param value Value to process.
 * @param environment Environment value.
 * @returns the explicit Dashboard bind host or the production-compatible default.
 */
export function resolveDashboardHost(value = process.env.MIRA_DASHBOARD_HOST): string {
    const host = value?.trim();
    if (!host) {
        return "0.0.0.0";
    }
    if (host.length > 253) {
        throw new TypeError("MIRA_DASHBOARD_HOST must be a valid bind host");
    }
    for (const character of host) {
        const codePoint = character.codePointAt(0);
        if (
            character === "/" ||
            character === "\\" ||
            codePoint === undefined ||
            codePoint <= 0x20
        ) {
            throw new TypeError("MIRA_DASHBOARD_HOST must be a valid bind host");
        }
    }
    return host;
}

/**
 * Converts primitive values to strings without permitting object coercion.
 *
 * @param value - Candidate primitive value.
 * @param fallback - Value returned for nullish or non-primitive input.
 * @returns The normalized string.
 */
export function stringFallback(value?: unknown, fallback = ""): string {
    if (value === undefined || value === null) {
        return fallback;
    }
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
    return fallback;
}

/**
 * Converts optional values to strings or undefined for API response fields.
 * @param value Value to process.
 * @returns Converted optional values to strings or undefined for API response fields.
 */
export function nullableString(value?: unknown): string | undefined {
    const text = stringFallback(value);
    return text || undefined;
}

/**
 * Returns whether a value contains a line break or null byte.
 * @param value Value to process.
 * @returns Whether a value contains a line break or null byte.
 */
export function hasLineBreakOrNullByte(value: string): boolean {
    return /[\r\n]/u.test(value) || value.includes("\0");
}

/**
 * Returns a fallback object for nullish values.
 * @param value Value to process.
 * @returns a fallback object for nullish values.
 */
export function objectFallback<T extends object>(value?: T | null): T {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : ({} as T);
}

/**
 * Returns an array value or a fallback for non-array inputs.
 * @param value Value to process.
 * @param fallback Fallback value.
 * @returns an array value or a fallback for non-array inputs.
 */
export function arrayFallback<T>(value: unknown, fallback: T[] = []): T[] {
    return Array.isArray(value) ? (value as T[]) : fallback;
}

/**
 * Narrows an unknown array without allowing `Array.isArray`'s `any[]` type to escape.
 *
 * @param value - Candidate array value.
 * @returns The array as unknown elements, or an empty array for other values.
 */
export function unknownArray(value: unknown): unknown[] {
    return Array.isArray(value) ? (value as unknown[]) : [];
}
