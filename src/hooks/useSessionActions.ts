import { useDeleteSession, useSessionAction } from "./useSessions";

/** Handles use session actions. */
export function useSessionActions() {
    const sessionAction = useSessionAction();
    const deleteSessionMutation = useDeleteSession();

    /** Handles stop. */
    const stop = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "stop" });
    };

    /** Handles compact. */
    const compact = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "compact" });
    };

    /** Handles reset. */
    const reset = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "reset" });
    };

    /** Handles remove. */
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
