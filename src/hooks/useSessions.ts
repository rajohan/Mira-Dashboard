import { useMutation, useQueryClient } from "@tanstack/react-query";

import { deleteSessionFromCollection } from "../collections/sessions";
import { apiDelete, apiPost } from "./useApi";

/** Represents input for a session lifecycle action mutation. */
interface SessionActionMutationInput {
    key: string;
    action: "stop" | "compact" | "reset";
}

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

/** Runs a session lifecycle action mutation. */
function runSessionActionMutation({
    key,
    action,
}: SessionActionMutationInput): Promise<void> {
    return sessionAction(key, action);
}

/** Returns a mutation for stop, compact, and reset session actions. */
export function useSessionAction() {
    return useMutation({
        mutationFn: runSessionActionMutation,
    });
}

/** Deletes a session and clears related local collection/query cache state. */
export function useDeleteSession() {
    const queryClient = useQueryClient();

    /** Removes deleted sessions from local collection and list cache. */
    function handleDeleteSuccess(_data: void, key: string): void {
        const sessionKey = key.trim();
        deleteSessionFromCollection(sessionKey);
        queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    }

    return useMutation({
        mutationFn: deleteSessionRequest,
        onSuccess: handleDeleteSuccess,
    });
}
