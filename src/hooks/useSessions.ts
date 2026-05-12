import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { deleteSessionFromCollection } from "../collections/sessions";
import { apiDelete, apiFetch, apiPost } from "./useApi";

// Types
/** Represents a paged session-history response returned by the dashboard API. */
interface SessionHistoryResponse {
    messages: Array<{ role: string; content: string; timestamp?: string }>;
    total?: number;
    hasMore?: boolean;
    nextOffset?: number;
}

/** Checks whether cached history data has TanStack infinite-query page metadata. */
function isValidInfiniteHistoryData(data: unknown): boolean {
    if (data == null) return true;
    if (typeof data !== "object") return false;

    const value = data as { pages?: unknown; pageParams?: unknown };
    return Array.isArray(value.pages) && Array.isArray(value.pageParams);
}

// Query keys
/** Defines React Query keys for session lists and per-session history. */
export const sessionKeys = {
    all: ["sessions"] as const,
    history: (key: string): ["sessions", "history", string] => [
        "sessions",
        "history",
        key,
    ],
};

/** Fetches one page of normalized session history messages. */
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

/** Sends a lifecycle action request for a session. */
async function sessionAction(
    key: string,
    action: "stop" | "compact" | "reset"
): Promise<void> {
    await apiPost(`/sessions/${encodeURIComponent(key)}/action`, { action });
}

/** Deletes a session through the dashboard API. */
async function deleteSessionRequest(key: string): Promise<void> {
    await apiDelete(`/sessions/${encodeURIComponent(key)}`);
}

/** Provides paginated session history while repairing stale non-infinite cache entries. */
export function useSessionHistory(key: string | null | undefined, limit = 50) {
    const queryClient = useQueryClient();
    const sessionKey = typeof key === "string" ? key.trim() : "";
    const queryKey = sessionKeys.history(sessionKey);

    // Older modal builds could leave a non-infinite value under this key. TanStack's
    // infinite observer assumes cached data has pages/pageParams and crashes before
    // render if it finds a plain page response instead.
    if (!isValidInfiniteHistoryData(queryClient.getQueryData(queryKey))) {
        queryClient.removeQueries({ queryKey, exact: true });
    }

    return useInfiniteQuery({
        queryKey,
        queryFn: ({ pageParam = 0 }) => fetchSessionHistory(sessionKey, pageParam, limit),
        initialPageParam: 0,
        getNextPageParam: (lastPage) =>
            lastPage?.hasMore ? (lastPage.nextOffset ?? undefined) : undefined,
        enabled: sessionKey.length > 0,
        staleTime: 30_000,
    });
}

/** Returns a mutation for stop, compact, and reset session actions. */
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

/** Deletes a session and clears related local collection/query cache state. */
export function useDeleteSession() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: deleteSessionRequest,
        onSuccess: (_, key) => {
            deleteSessionFromCollection(key);
            queryClient.removeQueries({
                queryKey: sessionKeys.history(key),
                exact: true,
            });
            queryClient.invalidateQueries({ queryKey: sessionKeys.all });
        },
    });
}
