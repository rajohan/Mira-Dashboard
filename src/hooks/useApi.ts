import { recoverOrHandleUnauthorizedSession } from "../lib/authBoundary";
import {
    dispatchSecurityVerificationRequired,
    isSecurityVerificationCode,
    waitForSecurityVerification,
} from "../lib/securityVerification";
import { hasRecentUserActivity } from "../lib/userActivity";

const API_BASE = "/api";

/** Extends fetch options with independent auth-recovery replay controls. */
export interface ApiRequestOptions extends RequestInit {
    canRetryAfterUnauthorizedRecovery?: boolean;
    canRetryAfterSecurityVerification?: boolean;
}

type ApiMethodOptions = Omit<ApiRequestOptions, "body" | "method">;

/** Represents a structured non-success API response. */
export class ApiError extends Error {
    readonly status: number;
    readonly code?: string;

    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
    }
}

/** Implements unauthorized error. */
export class UnauthorizedError extends ApiError {
    constructor() {
        super("Unauthorized", 401, "unauthorized");
        this.name = "UnauthorizedError";
    }
}

/** Performs API fetch. */
export async function apiFetch<T>(
    endpoint: string,
    options?: ApiRequestOptions
): Promise<T | undefined> {
    const {
        canRetryAfterSecurityVerification = true,
        canRetryAfterUnauthorizedRecovery = true,
        ...requestOptions
    } = options ?? {};
    const hasReplayableBody =
        requestOptions.body === undefined || typeof requestOptions.body === "string";
    let canRetryAfterVerification =
        canRetryAfterSecurityVerification && hasReplayableBody;
    let canRetryAfterUnauthorized =
        canRetryAfterUnauthorizedRecovery && hasReplayableBody;
    while (true) {
        const headers = new Headers(requestOptions.headers);
        headers.set("Content-Type", "application/json");
        if (hasRecentUserActivity()) {
            headers.set("X-Mira-User-Activity", "1");
        }

        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...requestOptions,
            headers,
            credentials: "include",
        });

        if (response.status === 401) {
            const recovered = await recoverOrHandleUnauthorizedSession();
            if (recovered && canRetryAfterUnauthorized) {
                canRetryAfterUnauthorized = false;
                continue;
            }
            throw new UnauthorizedError();
        }

        if (!response.ok) {
            let error: { code?: string; error?: string };
            try {
                error = (await response.json()) as {
                    code?: string;
                    error?: string;
                };
            } catch {
                error = { error: "Unknown error" };
            }
            if (isSecurityVerificationCode(error.code)) {
                if (
                    canRetryAfterVerification &&
                    (await waitForSecurityVerification(error.code))
                ) {
                    canRetryAfterVerification = false;
                    continue;
                }
                if (!canRetryAfterVerification) {
                    dispatchSecurityVerificationRequired(error.code);
                }
            }
            throw new ApiError(
                error.error || `HTTP ${response.status}`,
                response.status,
                error.code
            );
        }

        if (response.status === 204) {
            return undefined;
        }

        if (typeof response.text !== "function") {
            return response.json() as Promise<T>;
        }

        const text = await response.text();
        if (!text.trim()) {
            return undefined;
        }

        return JSON.parse(text) as T;
    }
}

/** Ensures API calls that require a JSON body fail clearly on empty responses. */
export function requireApiResponse<T>(value: T | undefined): T {
    if (value === undefined) {
        throw new Error("API response body was empty");
    }

    return value;
}

/** Fetches an API response that must include a JSON body. */
export async function apiFetchRequired<T>(
    endpoint: string,
    options?: ApiRequestOptions
): Promise<T> {
    return requireApiResponse(await apiFetch<T>(endpoint, options));
}

/** Posts to an API endpoint that must include a JSON body response. */
export async function apiPostRequired<T>(
    endpoint: string,
    body?: unknown,
    options?: ApiMethodOptions
): Promise<T> {
    return requireApiResponse(await apiPost<T>(endpoint, body, options));
}

/** Sends a PUT request to an API endpoint that must include a JSON body response. */
export async function apiPutRequired<T>(
    endpoint: string,
    body: unknown,
    options?: ApiMethodOptions
): Promise<T> {
    return requireApiResponse(await apiPut<T>(endpoint, body, options));
}

/** Sends a PATCH request to an API endpoint that must include a JSON body response. */
export async function apiPatchRequired<T>(
    endpoint: string,
    body: unknown,
    options?: ApiMethodOptions
): Promise<T> {
    return requireApiResponse(await apiPatch<T>(endpoint, body, options));
}

/** Sends a DELETE request to an API endpoint that must include a JSON body response. */
export async function apiDeleteRequired<T>(
    endpoint: string,
    options?: ApiMethodOptions
): Promise<T> {
    return requireApiResponse(await apiDelete<T>(endpoint, options));
}

/** Performs API post. */
export function apiPost<T>(
    endpoint: string,
    body?: unknown,
    options?: ApiMethodOptions
): Promise<T | undefined> {
    return apiFetch<T>(endpoint, {
        ...options,
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

/** Performs API put. */
export function apiPut<T>(
    endpoint: string,
    body: unknown,
    options?: ApiMethodOptions
): Promise<T | undefined> {
    return apiFetch<T>(endpoint, {
        ...options,
        method: "PUT",
        body: JSON.stringify(body),
    });
}

/** Performs API patch. */
export function apiPatch<T>(
    endpoint: string,
    body: unknown,
    options?: ApiMethodOptions
): Promise<T | undefined> {
    return apiFetch<T>(endpoint, {
        ...options,
        method: "PATCH",
        body: JSON.stringify(body),
    });
}

/** Performs API delete. */
export function apiDelete<T>(
    endpoint: string,
    options?: ApiMethodOptions
): Promise<T | undefined> {
    return apiFetch<T>(endpoint, { ...options, method: "DELETE" });
}
