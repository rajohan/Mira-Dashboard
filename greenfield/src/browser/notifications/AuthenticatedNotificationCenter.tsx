import type { AuthStatus } from "../../contracts/auth.ts";
import { useObservedQueryState } from "../api/useObservedQueryState.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import { NotificationCenter } from "./NotificationCenter.tsx";

/**
 * Mounts notification collection, actions, and realtime only after trusted auth state exists.
 * @returns The global notification center for an authenticated session, otherwise nothing.
 */
export function AuthenticatedNotificationCenter() {
    const authentication = useObservedQueryState<AuthStatus>(authStatusQueryKey);
    if (
        authentication?.status !== "success" ||
        authentication.fetchStatus !== "idle" ||
        authentication.data?.state !== "authenticated"
    ) {
        return null;
    }
    return <NotificationCenter />;
}
