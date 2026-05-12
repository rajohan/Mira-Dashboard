import { useDeleteSession, useSessionAction } from "./useSessions";

/** Provides session actions. */
export function useSessionActions() {
    const sessionAction = useSessionAction();
    const deleteSessionMutation = useDeleteSession();

    /** Performs stop. */
    const stop = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "stop" });
    };

    /** Performs compact. */
    const compact = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "compact" });
    };

    /** Performs reset. */
    const reset = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "reset" });
    };

    /** Performs remove. */
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
