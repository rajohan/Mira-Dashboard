import { useInfiniteQuery, useMutation } from "@tanstack/react-query";

import { deleteSessionFromCollection } from "../collections/sessions";
import { apiDelete, apiFetch, apiPost } from "./useApi";

// Types
interface SessionHistoryResponse {
    messages: Array<{ role: string; content: string; timestamp?: string }>;
    total?: number;
    hasMore?: boolean;
    nextOffset?: number;
}

// Query keys
export const sessionKeys = {
    all: ["sessions"] as const,
    history: (key: string): ["sessions", "history", string] => [
        "sessions",
        "history",
        key,
    ],
};

async function fetchSessionHistory(
    key: string,
    offset = 0,
    limit = 50
): Promise<SessionHistoryResponse> {
    const data = await apiFetch<SessionHistoryResponse>(
        `/sessions/${encodeURIComponent(key)}/history?offset=${offset}&limit=${limit}`
    );

    return {
        ...data,
        messages: Array.isArray(data.messages) ? data.messages : [],
    };
}

async function sessionAction(
    key: string,
    action: "stop" | "compact" | "reset"
): Promise<void> {
    await apiPost(`/sessions/${encodeURIComponent(key)}/action`, { action });
}

async function deleteSessionRequest(key: string): Promise<void> {
    await apiDelete(`/sessions/${encodeURIComponent(key)}`);
}

export function useSessionHistory(key: string | null | undefined, limit = 50) {
    const sessionKey = typeof key === "string" ? key.trim() : "";

    return useInfiniteQuery({
        queryKey: ["sessions", "history", sessionKey],
        queryFn: ({ pageParam = 0 }) => fetchSessionHistory(sessionKey, pageParam, limit),
        initialPageParam: 0,
        getNextPageParam: (lastPage) =>
            lastPage?.hasMore ? (lastPage.nextOffset ?? undefined) : undefined,
        enabled: sessionKey.length > 0,
        staleTime: 30_000,
    });
}

export function useSessionAction() {
    return useMutation({
        mutationFn: ({
            key,
            action,
        }: {
            key: string;
            action: "stop" | "compact" | "reset";
        }) => sessionAction(key, action),
    });
}

export function useDeleteSession() {
    return useMutation({
        mutationFn: deleteSessionRequest,
        onSuccess: (_, key) => {
            deleteSessionFromCollection(key);
        },
    });
}
