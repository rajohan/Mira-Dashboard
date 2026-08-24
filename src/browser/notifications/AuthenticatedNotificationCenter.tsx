import { useState } from "react";

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
    const verificationFailed = authentication?.status === "error";
    const [releasedIdentity, setReleasedIdentity] = useState<string>();

    if (
        releasedIdentity === undefined &&
        verificationSettled &&
        authenticatedIdentity !== undefined
    ) {
        setReleasedIdentity(authenticatedIdentity);
    }

    if (
        verificationFailed ||
        releasedIdentity === undefined ||
        authenticatedIdentity !== releasedIdentity
    ) {
        return null;
    }

    // A route-level background check keeps the previously verified identity current.
    // A failed check or resolved identity change still removes this private subtree.
    return <NotificationCenter />;
}
