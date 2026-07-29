function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function usableMessage(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const message = value.trim();
    return message && !/^\[object\s[^\]]+\]$/iu.test(message) ? message : undefined;
}

/**
 * Extracts a user-facing message from unknown failures without coercing objects
 * to `[object Object]`.
 * @param error Error to inspect.
 * @param fallback Fallback value.
 * @returns Message from error result.
 */
export function messageFromError(error: unknown, fallback: string): string {
    if (error instanceof Error) {
        return usableMessage(error.message) ?? fallback;
    }
    const directMessage = usableMessage(error);
    if (directMessage) return directMessage;

    const input = record(error);
    if (!input) return fallback;
    const message = usableMessage(input.message);
    if (message) return message;

    const nestedError = record(input.error);
    return usableMessage(input.error) ?? usableMessage(nestedError?.message) ?? fallback;
}
