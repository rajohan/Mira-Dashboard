import { useMutation, useQuery } from "@tanstack/react-query";

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

export function useSessionHistory(key: string | null | undefined, limit = 200) {
    const sessionKey = typeof key === "string" ? key.trim() : "";

    const query = useQuery({
        queryKey: ["sessions", "history", "single", sessionKey, limit],
        queryFn: () => fetchSessionHistory(sessionKey, 0, limit),
        enabled: sessionKey.length > 0,
        staleTime: 30_000,
    });

    return {
        ...query,
        data: query.data ? { pages: [query.data], pageParams: [0] } : undefined,
        fetchNextPage: query.refetch,
        hasNextPage: false,
        isFetchingNextPage: false,
    };
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
