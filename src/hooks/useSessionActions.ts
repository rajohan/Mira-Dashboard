import { useDeleteSession, useSessionAction } from "./useSessions";

export function useSessionActions() {
    const sessionAction = useSessionAction();
    const deleteSessionMutation = useDeleteSession();

    const stop = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "stop" });
    };

    const compact = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "compact" });
    };

    const reset = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "reset" });
    };

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
