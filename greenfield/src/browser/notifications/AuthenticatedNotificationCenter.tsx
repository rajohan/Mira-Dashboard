import { Activity, useState } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { useObservedQueryState } from "../api/useObservedQueryState.ts";
import { authStatusCacheIdentity, authStatusQueryKey } from "../auth/authQueries.ts";
import { NotificationCenter } from "./NotificationCenter.tsx";

/**
 * Mounts notification collection, actions, and realtime only after trusted auth state exists.
 * @returns The global notification center for an authenticated session, otherwise nothing.
 */
export function AuthenticatedNotificationCenter() {
    const authentication = useObservedQueryState<AuthStatus>(authStatusQueryKey);
    const authenticatedIdentity =
        authentication?.data?.state === "authenticated"
            ? authStatusCacheIdentity(authentication.data)
            : undefined;
    const verificationSettled =
        authentication?.status === "success" && authentication.fetchStatus === "idle";
    const [releasedIdentity, setReleasedIdentity] = useState<string>();

    if (
        releasedIdentity === undefined &&
        verificationSettled &&
        authenticatedIdentity !== undefined
    ) {
        setReleasedIdentity(authenticatedIdentity);
    }

    if (releasedIdentity === undefined || authenticatedIdentity !== releasedIdentity) {
        return null;
    }
    return (
        <Activity
            mode={verificationSettled ? "visible" : "hidden"}
            name="authenticated-notifications"
        >
            <NotificationCenter />
        </Activity>
    );
}
