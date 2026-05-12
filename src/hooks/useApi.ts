import { authActions } from "../stores/authStore";

const API_BASE = "/api";

/** Implements unauthorized error. */
export class UnauthorizedError extends Error {
    constructor() {
        super("Unauthorized");
        this.name = "UnauthorizedError";
    }
}

/** Handles unauthorized interactions. */
function handleUnauthorized() {
    authActions.clearSession();
    window.dispatchEvent(new CustomEvent("openclaw:unauthorized"));
}

/** Performs API fetch. */
export async function apiFetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const headers: HeadersInit = {
        "Content-Type": "application/json",
        ...options?.headers,
    };

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
        const error = await response.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json() as Promise<T>;
}

/** Performs API post. */
export function apiPost<T>(endpoint: string, body?: unknown): Promise<T> {
    return apiFetch<T>(endpoint, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
    });
}

/** Performs API put. */
export function apiPut<T>(endpoint: string, body: unknown): Promise<T> {
    return apiFetch<T>(endpoint, {
        method: "PUT",
        body: JSON.stringify(body),
    });
}

/** Performs API delete. */
export function apiDelete<T>(endpoint: string): Promise<T> {
    return apiFetch<T>(endpoint, { method: "DELETE" });
}
