import { parseApiErrorResponse } from "../../contracts/apiErrors";

const DEFAULT_API_ERROR_METADATA: ApiErrorMetadata = {
    code: "request_failed",
    requestId: "unavailable",
};
const DEFAULT_UNAUTHORIZED_ERROR_METADATA: Omit<ApiErrorMetadata, "code"> = {
    requestId: "unavailable",
};

export interface ApiErrorMetadata {
    code: string;
    details?: unknown;
    requestId: string;
    /** Retry delay from the HTTP Retry-After header, normalized to seconds. */
    retryAfter?: number;
}

/** Represents a structured non-success API response. */
export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly details?: unknown;
    readonly requestId: string;
    readonly retryAfter?: number;

    constructor(
        message: string,
        status: number,
        metadata: ApiErrorMetadata = DEFAULT_API_ERROR_METADATA
    ) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = metadata.code;
        this.details = metadata.details;
        this.requestId = metadata.requestId;
        this.retryAfter = metadata.retryAfter;
    }
}

/** Represents an API response rejected by the authentication boundary. */
export class UnauthorizedError extends ApiError {
    constructor(
        metadata: Omit<ApiErrorMetadata, "code"> = DEFAULT_UNAUTHORIZED_ERROR_METADATA
    ) {
        super("Unauthorized", 401, { code: "unauthorized", ...metadata });
        this.name = "UnauthorizedError";
    }
}

function responseRequestId(response: Response): string | undefined {
    return response.headers.get("X-Request-ID")?.trim() || undefined;
}

function retryAfterSeconds(response: Response): number | undefined {
    const value = response.headers.get("Retry-After")?.trim();
    if (!value) return undefined;
    if (/^\d+$/u.test(value)) return Number(value);
    const retryAt = Date.parse(value);
    return Number.isFinite(retryAt)
        ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
        : undefined;
}

/**
 * Consumes a non-success response and maps its strict error envelope plus
 * relevant headers to the frontend error model.
 */
export async function apiErrorFromResponse(
    response: Response,
    fallbackMessage = `HTTP ${response.status}`
): Promise<ApiError> {
    let parsed;
    try {
        parsed = parseApiErrorResponse(await response.json());
    } catch {
        parsed = undefined;
    }
    return new ApiError(parsed?.message || fallbackMessage, response.status, {
        code: parsed?.code ?? "invalid_error_response",
        details: parsed?.details,
        requestId: responseRequestId(response) ?? parsed?.requestId ?? "unavailable",
        retryAfter: retryAfterSeconds(response),
    });
}
