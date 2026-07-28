import type { ApiErrorBody, ApiErrorResponse } from "../../contracts/apiErrors.ts";
import { ContractValidationError } from "../../contracts/runtime.ts";
import { HttpError, json } from "./http.ts";
import { errorMessage, httpStatusCode } from "./lib/errors.ts";
import { logError } from "./lib/structuredLogger.ts";
import { requestIdFor } from "./requestSecurity.ts";

interface ApiRouteErrorOptions {
    details?: unknown;
    retryAfterSeconds?: number;
}

const DEFAULT_ERROR_CODES = new Map<number, string>([
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [405, "method_not_allowed"],
    [409, "conflict"],
    [413, "payload_too_large"],
    [429, "rate_limited"],
    [500, "internal_error"],
    [503, "service_unavailable"],
    [504, "gateway_timeout"],
]);

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

function defaultErrorCode(status: number): string {
    return DEFAULT_ERROR_CODES.get(status) ?? "request_failed";
}

export interface MappedApiError {
    code: string;
    details?: unknown;
    message: string;
    retryAfterSeconds?: number;
    status: number;
}

/** Carries a stable public error code without exposing implementation details. */
export class ApiRouteError extends HttpError {
    readonly code: string;
    readonly details?: unknown;
    readonly retryAfterSeconds?: number;

    constructor(
        code: string,
        message: string,
        statusCode: number,
        options: ApiRouteErrorOptions = {}
    ) {
        super(message, statusCode);
        this.name = "ApiRouteError";
        this.code = code;
        this.details = options.details;
        this.retryAfterSeconds = options.retryAfterSeconds;
    }
}

/** Maps a caught route error to a bounded public contract. */
export function mapApiError(
    error: unknown,
    fallback: Pick<MappedApiError, "message"> & { code?: string }
): MappedApiError {
    if (error instanceof ApiRouteError) {
        return {
            code: error.code,
            ...(error.details !== undefined && { details: error.details }),
            message: error.message,
            ...(error.retryAfterSeconds !== undefined && {
                retryAfterSeconds: error.retryAfterSeconds,
            }),
            status: error.statusCode,
        };
    }

    if (error instanceof ContractValidationError) {
        return {
            code: "invalid_request",
            details: { issues: error.issues },
            message: error.message,
            status: 400,
        };
    }

    if (error instanceof SyntaxError) {
        return {
            code: "invalid_json",
            message: "Invalid JSON",
            status: 400,
        };
    }

    const status = httpStatusCode(error);
    if (status !== 500) {
        return {
            code:
                error instanceof HttpError &&
                error.statusCode === 400 &&
                error.message === "Invalid JSON"
                    ? "invalid_json"
                    : (fallback.code ?? defaultErrorCode(status)),
            message: errorMessage(error, fallback.message),
            status,
        };
    }

    return {
        code: fallback.code ?? defaultErrorCode(status),
        message: fallback.message,
        status,
    };
}

/**
 * Emits the shared error body, correlation header, and optional retry metadata.
 * Internal logs deliberately exclude request bodies, error details, and messages.
 */
export function apiErrorResponse(
    request: Request,
    error: MappedApiError,
    context: string
): Response {
    const requestId = requestIdFor(request);
    const headers = new Headers({ "X-Request-ID": requestId });
    if (error.retryAfterSeconds !== undefined) {
        headers.set("Retry-After", String(error.retryAfterSeconds));
    }
    if (error.status >= 500) {
        logError("api.error", {
            code: error.code,
            context,
            method: request.method.toUpperCase(),
            path: new URL(request.url).pathname,
            requestId,
            status: error.status,
        });
    }

    const body: ApiErrorBody = {
        code: error.code,
        ...(error.details !== undefined && { details: error.details }),
        message: error.message,
        requestId,
    };
    return json({ error: body } satisfies ApiErrorResponse, {
        headers,
        status: error.status,
    });
}

/**
 * Converts every failed JSON API response to the single public error contract.
 * Route implementations can migrate to ApiRouteError incrementally without
 * exposing multiple wire formats.
 */
export async function normalizeApiErrorResponse(
    request: Request,
    response: Response
): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (
        path === "/api/health/ready" ||
        response.status < 400 ||
        !path.startsWith("/api/")
    ) {
        return response;
    }

    let payload: Record<string, unknown> | undefined;
    try {
        payload = record(await response.clone().json());
    } catch {
        payload = undefined;
    }
    const nestedError = record(payload?.error);
    const code =
        nonEmptyString(nestedError?.code) ??
        nonEmptyString(payload?.code) ??
        defaultErrorCode(response.status);
    const message =
        (nonEmptyString(nestedError?.message) ??
            nonEmptyString(payload?.error) ??
            nonEmptyString(payload?.message) ??
            response.statusText.trim()) ||
        "Request failed";
    const details = Object.hasOwn(nestedError ?? {}, "details")
        ? nestedError?.details
        : payload && Object.hasOwn(payload, "details")
          ? payload.details
          : undefined;
    const requestId = requestIdFor(request);
    const error: ApiErrorBody = {
        code,
        ...(details !== undefined && { details }),
        message,
        requestId,
    };
    const headers = new Headers(response.headers);
    headers.set("X-Request-ID", requestId);
    return json({ error } satisfies ApiErrorResponse, {
        headers,
        status: response.status,
        statusText: response.statusText,
    });
}
