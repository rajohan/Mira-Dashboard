const API_BASE = "/api";

export async function apiFetch<T>(
    endpoint: string,
    options?: RequestInit
): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
        headers: { "Content-Type": "application/json" },
        ...options,
    });

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