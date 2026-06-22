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

/** Converts optional values to strings while preserving empty/undefined fallback behavior. */
export function stringFallback(value?: unknown, fallback = ""): string {
    return String(value ?? fallback);
}

/** Converts optional values to strings or undefined for API response fields. */
export function nullableString(value?: unknown): string | undefined {
    const text = stringFallback(value);
    return text || undefined;
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
