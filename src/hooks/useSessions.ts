import { useInfiniteQuery, useMutation } from "@tanstack/react-query";

import { sessionsCollection } from "../collections/sessions";
import { apiFetch, apiPost } from "./useApi";

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
    return apiFetch<SessionHistoryResponse>(
        `/sessions/${encodeURIComponent(key)}/history?offset=${offset}&limit=${limit}`
    );
}

async function sessionAction(
    key: string,
    action: "stop" | "compact" | "reset"
): Promise<void> {
    await apiPost(`/sessions/${encodeURIComponent(key)}/action`, { action });
}

async function deleteSessionRequest(key: string): Promise<void> {
    await apiPost("/sessions/delete", {
        key,
        deleteTranscript: true,
        emitLifecycleHooks: false,
    });
}

export function useSessionHistory(key: string | null, limit = 50) {
    return useInfiniteQuery({
        queryKey: ["sessions", "history", key],
        queryFn: ({ pageParam = 0 }) => fetchSessionHistory(key!, pageParam, limit),
        initialPageParam: 0,
        getNextPageParam: (lastPage) =>
            lastPage.hasMore ? (lastPage.nextOffset ?? undefined) : undefined,
        enabled: !!key,
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
            sessionsCollection.utils.writeDelete(key);
        },
    });
}
