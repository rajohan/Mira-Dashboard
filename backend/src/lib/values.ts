/** Returns an environment variable when it is set, otherwise a fallback. */
export function environmentFallback(name: string, fallback: string): string {
    const value = process.env[name];
    return value ?? fallback;
}

/** Returns an environment variable when it is non-empty, otherwise a fallback. */
export function nonEmptyEnvironmentFallback(name: string, fallback: string): string {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : fallback;
}

/** Converts optional values to strings while preserving empty/null fallback behavior. */
export function stringFallback(value?: unknown, fallback = ""): string {
    return value == null ? fallback : String(value);
}

/** Converts optional values to strings or null for API response fields. */
export function nullableString(value?: unknown): string | null {
    const text = stringFallback(value);
    return text || null;
}

/** Returns a fallback object for nullish values. */
export function objectFallback<T extends object>(value?: T | null): T {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : ({} as T);
}

/** Returns an array value or a fallback for non-array inputs. */
export function arrayFallback<T>(value: unknown, fallback: T[] = []): T[] {
    return Array.isArray(value) ? (value as T[]) : fallback;
}
