import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch, apiPost } from "./useApi";

import type { Session } from "./useOpenClaw";

// Types
interface SessionsResponse {
    sessions: Session[];
}

interface SessionHistoryResponse {
    messages: Array<{ role: string; content: string; timestamp?: string }>;
    total?: number;
}

// Query keys
export const sessionKeys = {
    all: ["sessions"] as const,
    list: (): ["sessions", "list"] => ["sessions", "list"],
    history: (key: string): ["sessions", "history", string] => ["sessions", "history", key],
};

// Fetchers
async function fetchSessions(): Promise<Session[]> {
    const data = await apiFetch<SessionsResponse>("/sessions/list");
    return data.sessions || [];
}

async function fetchSessionHistory(key: string): Promise<SessionHistoryResponse> {
    return apiFetch<SessionHistoryResponse>(`/sessions/${encodeURIComponent(key)}/history`);
}

async function sessionAction(key: string, action: "stop" | "compact" | "reset"): Promise<void> {
    await apiPost(`/sessions/${encodeURIComponent(key)}/action`, { action });
}

async function deleteSessionRequest(key: string): Promise<void> {
    await apiPost("/sessions/delete", {
        key,
        deleteTranscript: true,
        emitLifecycleHooks: false,
    });
}

// Hooks
export function useSessions() {
    return useQuery({
        queryKey: sessionKeys.list(),
        queryFn: fetchSessions,
        staleTime: 10_000, // 10 seconds
    });
}

export function useSessionHistory(key: string | null) {
    return useQuery({
        queryKey: sessionKeys.history(key || ""),
        queryFn: () => fetchSessionHistory(key!),
        enabled: !!key,
        staleTime: 30_000, // 30 seconds
    });
}

export function useSessionAction() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ key, action }: { key: string; action: "stop" | "compact" | "reset" }) =>
            sessionAction(key, action),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
        },
    });
}

export function useDeleteSession() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: deleteSessionRequest,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
        },
    });
}