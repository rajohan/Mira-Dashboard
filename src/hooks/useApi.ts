import { isSecurityVerificationCode } from "../lib/securityVerification";
import { hasRecentUserActivity } from "../lib/userActivity";
import { authActions } from "../stores/authStore";

const API_BASE = "/api";

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

/** Responds to unauthorized events. */
function handleUnauthorized() {
    authActions.clearSession();
    dispatchEvent(new CustomEvent("openclaw:unauthorized"));
}

/** Performs API fetch. */
export async function apiFetch<T>(
    endpoint: string,
    options?: RequestInit
): Promise<T | undefined> {
    const headers = new Headers(options?.headers);
    headers.set("Content-Type", "application/json");
    if (hasRecentUserActivity()) {
        headers.set("X-Mira-User-Activity", "1");
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers,
        credentials: "include",
    });

    if (response.status === 401) {
        handleUnauthorized();
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
            dispatchEvent(
                new CustomEvent("mira:security-verification-required", {
                    detail: { code: error.code },
                })
            );
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
    options?: RequestInit
): Promise<T> {
    return requireApiResponse(await apiFetch<T>(endpoint, options));
}

/** Posts to an API endpoint that must include a JSON body response. */
export async function apiPostRequired<T>(endpoint: string, body?: unknown): Promise<T> {
    return requireApiResponse(await apiPost<T>(endpoint, body));
}

/** Sends a PUT request to an API endpoint that must include a JSON body response. */
export async function apiPutRequired<T>(endpoint: string, body: unknown): Promise<T> {
    return requireApiResponse(await apiPut<T>(endpoint, body));
}

/** Sends a PATCH request to an API endpoint that must include a JSON body response. */
export async function apiPatchRequired<T>(endpoint: string, body: unknown): Promise<T> {
    return requireApiResponse(await apiPatch<T>(endpoint, body));
}

/** Sends a DELETE request to an API endpoint that must include a JSON body response. */
export async function apiDeleteRequired<T>(endpoint: string): Promise<T> {
    return requireApiResponse(await apiDelete<T>(endpoint));
}

/** Performs API post. */
export function apiPost<T>(endpoint: string, body?: unknown): Promise<T | undefined> {
    return apiFetch<T>(endpoint, {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

/** Performs API put. */
export function apiPut<T>(endpoint: string, body: unknown): Promise<T | undefined> {
    return apiFetch<T>(endpoint, {
        method: "PUT",
        body: JSON.stringify(body),
    });
}

/** Performs API patch. */
export function apiPatch<T>(endpoint: string, body: unknown): Promise<T | undefined> {
    return apiFetch<T>(endpoint, {
        method: "PATCH",
        body: JSON.stringify(body),
    });
}

/** Performs API delete. */
export function apiDelete<T>(endpoint: string): Promise<T | undefined> {
    return apiFetch<T>(endpoint, { method: "DELETE" });
}
