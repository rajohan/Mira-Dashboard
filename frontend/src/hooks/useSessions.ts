import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
    type SessionAction,
    type SessionActionRequest,
    parseSessionActionResponse,
    parseSessionDeleteResponse,
} from "../../../contracts/sessions";
import { deleteSessionFromCollection } from "../collections/sessions";
import { apiDeleteParsed, apiPostParsed } from "./useApi";

/** Represents input for a session lifecycle action mutation. */
interface SessionActionMutationInput {
    key: string;
    action: SessionAction;
}

// Query keys
/** Defines React Query keys for session lists and per-session history. */
export const sessionKeys = {
    all: ["sessions"] as const,
};

/**
 * Sends a lifecycle action request for a session.
 * @param key Lookup key.
 * @param action Action value.
 */
async function sessionAction(key: string, action: SessionAction): Promise<void> {
    await apiPostParsed(
        `/sessions/${encodeURIComponent(key)}/action`,
        parseSessionActionResponse,
        { action } satisfies SessionActionRequest
    );
}

/**
 * Deletes a session through the dashboard API.
 * @param key Lookup key.
 */
async function deleteSessionRequest(key: string): Promise<void> {
    await apiDeleteParsed(
        `/sessions/${encodeURIComponent(key)}`,
        parseSessionDeleteResponse
    );
}

/**
 * Runs a session lifecycle action mutation.
 * @returns Run session action mutation result.
 */
function runSessionActionMutation({
    key,
    action,
}: SessionActionMutationInput): Promise<void> {
    return sessionAction(key, action);
}

/**
 * Returns a mutation for stop, compact, and reset session actions.
 * @returns a mutation for stop, compact, and reset session actions.
 */
export function useSessionAction() {
    return useMutation({
        mutationFn: runSessionActionMutation,
    });
}

/**
 * Deletes a session and clears related local collection/query cache state.
 * @returns Delete session state and actions.
 */
export function useDeleteSession() {
    const queryClient = useQueryClient();

    /**
     * Removes deleted sessions from local collection and list cache.
     * @param _data Data value.
     * @param key Lookup key.
     */
    async function handleDeleteSuccess(_data: void, key: string): Promise<void> {
        const sessionKey = key.trim();
        deleteSessionFromCollection(sessionKey);
        await queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    }

    return useMutation({
        mutationFn: deleteSessionRequest,
        onSuccess: handleDeleteSuccess,
    });
}
