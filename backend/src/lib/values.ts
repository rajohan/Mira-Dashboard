/** Returns an environment variable when it is set, otherwise a fallback. */
export function envFallback(name: string, fallback: string): string {
    const value = process.env[name];
    return value ?? fallback;
}

/** Returns an environment variable when it is non-empty, otherwise a fallback. */
export function nonEmptyEnvFallback(name: string, fallback: string): string {
    return process.env[name] || fallback;
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
    return value || ({} as T);
}

/** Returns an array value or a fallback for non-array inputs. */
export function arrayFallback<T>(value: unknown, fallback: T[] = []): T[] {
    return Array.isArray(value) ? (value as T[]) : fallback;
}
