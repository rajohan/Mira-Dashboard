import { authActions } from "../stores/authStore";

const API_BASE = "/api";

export class UnauthorizedError extends Error {
    constructor() {
        super("Unauthorized");
        this.name = "UnauthorizedError";
    }
}

// Get token from localStorage or URL params
function getToken(): string | null {
    const stored = localStorage.getItem("openclaw_token");
    if (stored) {
        return stored;
    }

    return new URLSearchParams(window.location.search).get("token");
}

function handleUnauthorized() {
    authActions.logout();
    window.dispatchEvent(new CustomEvent("openclaw:unauthorized"));
}

export async function apiFetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const token = getToken();
    const headers: HeadersInit = {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options?.headers,
    };

    const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers,
    });

    if (response.status === 401) {
        handleUnauthorized();
        throw new UnauthorizedError();
    }

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
}

export function apiPost<T>(endpoint: string, body?: unknown): Promise<T> {
    return apiFetch<T>(endpoint, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
    });
}

export function apiPut<T>(endpoint: string, body: unknown): Promise<T> {
    return apiFetch<T>(endpoint, {
        method: "PUT",
        body: JSON.stringify(body),
    });
}

export function apiDelete<T>(endpoint: string): Promise<T> {
    return apiFetch<T>(endpoint, { method: "DELETE" });
}
