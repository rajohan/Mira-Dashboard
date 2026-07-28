import type { ContractParser } from "../../contracts/runtime";
import { apiErrorFromResponse, UnauthorizedError } from "../lib/apiError";
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
            const unauthorizedError = await apiErrorFromResponse(
                response,
                "Unauthorized"
            );
            throw new UnauthorizedError({
                requestId: unauthorizedError.requestId,
                retryAfter: unauthorizedError.retryAfter,
            });
        }

        if (!response.ok) {
            const error = await apiErrorFromResponse(response);
            const errorCode = error.code;
            if (isSecurityVerificationCode(errorCode)) {
                if (
                    canRetryAfterVerification &&
                    (await waitForSecurityVerification(errorCode))
                ) {
                    canRetryAfterVerification = false;
                    continue;
                }
                if (!canRetryAfterVerification) {
                    dispatchSecurityVerificationRequired(errorCode);
                }
            }
            throw error;
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

/** Fetches and validates a required success response at the browser trust boundary. */
export async function apiFetchParsed<T>(
    endpoint: string,
    parser: ContractParser<T>,
    options?: ApiRequestOptions
): Promise<T> {
    return parser(requireApiResponse(await apiFetch<unknown>(endpoint, options)));
}

/** Posts and validates a required success response at the browser trust boundary. */
export async function apiPostParsed<T>(
    endpoint: string,
    parser: ContractParser<T>,
    body?: unknown,
    options?: ApiMethodOptions
): Promise<T> {
    return parser(requireApiResponse(await apiPost<unknown>(endpoint, body, options)));
}

/** Patches and validates a required success response at the browser trust boundary. */
export async function apiPatchParsed<T>(
    endpoint: string,
    parser: ContractParser<T>,
    body: unknown,
    options?: ApiMethodOptions
): Promise<T> {
    return parser(requireApiResponse(await apiPatch<unknown>(endpoint, body, options)));
}

/** Deletes and validates a required success response at the browser trust boundary. */
export async function apiDeleteParsed<T>(
    endpoint: string,
    parser: ContractParser<T>,
    options?: ApiMethodOptions
): Promise<T> {
    return parser(requireApiResponse(await apiDelete<unknown>(endpoint, options)));
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
