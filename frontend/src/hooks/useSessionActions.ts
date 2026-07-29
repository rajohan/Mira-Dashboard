import { useDeleteSession, useSessionAction } from "./useSessions";

/**
 * Provides session actions.
 * @returns The session actions.
 */
export function useSessionActions() {
    const sessionAction = useSessionAction();
    const deleteSessionMutation = useDeleteSession();

    /**
     * Performs stop.
     * @param sessionKey Session key value.
     */
    const stop = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "stop" });
    };

    /**
     * Performs compact.
     * @param sessionKey Session key value.
     */
    const compact = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "compact" });
    };

    /**
     * Performs reset.
     * @param sessionKey Session key value.
     */
    const reset = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "reset" });
    };

    /**
     * Performs remove.
     * @param sessionKey Session key value.
     */
    const remove = async (sessionKey: string) => {
        await deleteSessionMutation.mutateAsync(sessionKey);
    };

    return {
        stop,
        compact,
        reset,
        remove,
        isDeleting: deleteSessionMutation.isPending,
    };
}
