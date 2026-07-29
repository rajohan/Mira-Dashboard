import type { ContractParser } from "../../../contracts/runtime";
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

/**
 * Performs API fetch.
 * @param endpoint Endpoint value.
 * @param options Operation options.
 * @returns API fetch result.
 */
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
            const isRecovered = await recoverOrHandleUnauthorizedSession();
            if (isRecovered && canRetryAfterUnauthorized) {
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

/**
 * Ensures API calls that require a JSON body fail clearly on empty responses.
 * @param value Value to process.
 * @returns Require api response result.
 */
export function requireApiResponse<T>(value: T | undefined): T {
    if (value === undefined) {
        throw new Error("API response body was empty");
    }

    return value;
}

/**
 * Fetches and validates a required success response at the browser trust boundary.
 * @param endpoint Endpoint value.
 * @param parser Runtime value parser.
 * @param options Operation options.
 * @returns Promise resolving to the api fetch parsed result.
 */
export async function apiFetchParsed<T>(
    endpoint: string,
    parser: ContractParser<T>,
    options?: ApiRequestOptions
): Promise<T> {
    return parser(requireApiResponse(await apiFetch<unknown>(endpoint, options)));
}

/**
 * Posts and validates a required success response at the browser trust boundary.
 * @param endpoint Endpoint value.
 * @param parser Runtime value parser.
 * @param body Request or document body.
 * @param options Operation options.
 * @returns Promise resolving to the api post parsed result.
 */
export async function apiPostParsed<T>(
    endpoint: string,
    parser: ContractParser<T>,
    body?: unknown,
    options?: ApiMethodOptions
): Promise<T> {
    return parser(requireApiResponse(await apiPost<unknown>(endpoint, body, options)));
}

/**
 * Puts and validates a required success response at the browser trust boundary.
 * @param endpoint Endpoint value.
 * @param parser Runtime value parser.
 * @param body Request or document body.
 * @param options Operation options.
 * @returns Promise resolving to the api put parsed result.
 */
export async function apiPutParsed<T>(
    endpoint: string,
    parser: ContractParser<T>,
    body: unknown,
    options?: ApiMethodOptions
): Promise<T> {
    return parser(requireApiResponse(await apiPut<unknown>(endpoint, body, options)));
}

/**
 * Patches and validates a required success response at the browser trust boundary.
 * @param endpoint Endpoint value.
 * @param parser Runtime value parser.
 * @param body Request or document body.
 * @param options Operation options.
 * @returns Promise resolving to the api patch parsed result.
 */
export async function apiPatchParsed<T>(
    endpoint: string,
    parser: ContractParser<T>,
    body: unknown,
    options?: ApiMethodOptions
): Promise<T> {
    return parser(requireApiResponse(await apiPatch<unknown>(endpoint, body, options)));
}

/**
 * Deletes and validates a required success response at the browser trust boundary.
 * @param endpoint Endpoint value.
 * @param parser Runtime value parser.
 * @param options Operation options.
 * @returns Promise resolving to the api delete parsed result.
 */
export async function apiDeleteParsed<T>(
    endpoint: string,
    parser: ContractParser<T>,
    options?: ApiMethodOptions
): Promise<T> {
    return parser(requireApiResponse(await apiDelete<unknown>(endpoint, options)));
}

/**
 * Performs API post.
 * @param endpoint Endpoint value.
 * @param body Request or document body.
 * @param options Operation options.
 * @returns API post result.
 */
function apiPost<T>(
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

/**
 * Performs API put.
 * @param endpoint Endpoint value.
 * @param body Request or document body.
 * @param options Operation options.
 * @returns API put result.
 */
function apiPut<T>(
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

/**
 * Performs API patch.
 * @param endpoint Endpoint value.
 * @param body Request or document body.
 * @param options Operation options.
 * @returns API patch result.
 */
function apiPatch<T>(
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

/**
 * Performs API delete.
 * @param endpoint Endpoint value.
 * @param options Operation options.
 * @returns API delete result.
 */
function apiDelete<T>(
    endpoint: string,
    options?: ApiMethodOptions
): Promise<T | undefined> {
    return apiFetch<T>(endpoint, { ...options, method: "DELETE" });
}
