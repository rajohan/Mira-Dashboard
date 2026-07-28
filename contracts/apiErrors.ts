export interface ApiErrorBody {
    code: string;
    details?: unknown;
    message: string;
    requestId: string;
}

export interface ApiErrorResponse {
    error: ApiErrorBody;
}

export interface ParsedApiError {
    code: string;
    details?: unknown;
    message: string;
    requestId: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}

/** Parses the shared error contract at the HTTP trust boundary. */
export function parseApiErrorResponse(value: unknown): ParsedApiError | undefined {
    const payload = record(value);
    if (!payload) return undefined;

    const nestedError = record(payload.error);
    if (!nestedError) return undefined;
    const code = nonEmptyString(nestedError.code);
    const message = nonEmptyString(nestedError.message);
    const requestId = nonEmptyString(nestedError.requestId);
    if (!code || !message || !requestId) return undefined;
    return {
        code,
        ...(Object.hasOwn(nestedError, "details") && {
            details: nestedError.details,
        }),
        message,
        requestId,
    };
}
