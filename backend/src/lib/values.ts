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

/** Returns the validated effective Dashboard listen port. */
export function resolveDashboardPort(value = process.env.PORT): number {
    const trimmed = value?.trim() ?? "";
    if (!/^\d+$/u.test(trimmed)) {
        return 3100;
    }
    const port = Number(trimmed);
    return port > 0 && port <= 65_535 ? port : 3100;
}

/** Returns the explicit Dashboard bind host or the production-compatible default. */
export function resolveDashboardHost(
    value = process.env.MIRA_DASHBOARD_HOST,
    environment: Record<string, string | undefined> = process.env
): string {
    const host = environment.NODE_ENV === "production" ? undefined : value?.trim();
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
