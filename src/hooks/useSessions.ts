import { useMutation, useQueryClient } from "@tanstack/react-query";

import { deleteSessionFromCollection } from "../collections/sessions";
import { apiDelete, apiPost } from "./useApi";

// Query keys
/** Defines React Query keys for session lists and per-session history. */
export const sessionKeys = {
    all: ["sessions"] as const,
};

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
            const sessionKey = key.trim();
            deleteSessionFromCollection(sessionKey);
            queryClient.invalidateQueries({ queryKey: sessionKeys.all });
        },
    });
}
