import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { useObservedQueryData } from "../api/useObservedQueryState.ts";
import { useDashboardBrowserCollections } from "../data/dashboardCollectionsContextValue.ts";
import { PageState } from "../ui/PageState.tsx";
import {
    authStatusCacheIdentity,
    authStatusQueryKey,
    resetAuthenticatedBrowserDataPreservingAuth,
} from "./authQueries.ts";

interface AuthenticatedBrowserCacheBoundaryProps {
    readonly children: ReactNode;
    readonly onCacheReset?: (queryClient: QueryClient) => void;
}

interface CacheTransitionState {
    readonly failedIdentity?: string;
    readonly observedIdentity?: string;
    readonly pendingIdentity?: string;
    readonly releasedIdentity?: string;
    readonly requestVersion: number;
}

const unresolvedAuthenticationIdentity = "unresolved-auth-status";

/**
 * Gates the application while every resolved auth-identity transition replaces all
 * private browser collections, queries, and mutations.
 * @returns Children only after the current identity owns a freshly reset cache.
 */
export function AuthenticatedBrowserCacheBoundary({
    children,
    onCacheReset,
}: AuthenticatedBrowserCacheBoundaryProps) {
    const queryClient = useQueryClient();
    const collections = useDashboardBrowserCollections();
    const authentication = useObservedQueryData<AuthStatus>(authStatusQueryKey);
    const identity =
        authentication === undefined
            ? unresolvedAuthenticationIdentity
            : authStatusCacheIdentity(authentication);
    const [transition, setTransition] = useState<CacheTransitionState>({
        observedIdentity: unresolvedAuthenticationIdentity,
        releasedIdentity: unresolvedAuthenticationIdentity,
        requestVersion: 0,
    });
    const startedVersion = useRef(0);

    if (identity !== transition.observedIdentity) {
        setTransition((current) => ({
            ...current,
            failedIdentity: undefined,
            observedIdentity: identity,
            pendingIdentity: identity,
            requestVersion: current.requestVersion + 1,
        }));
    }

    useEffect(() => {
        const pendingIdentity = transition.pendingIdentity;
        if (
            pendingIdentity === undefined ||
            transition.failedIdentity === pendingIdentity ||
            startedVersion.current === transition.requestVersion
        ) {
            return;
        }
        const requestVersion = transition.requestVersion;
        startedVersion.current = requestVersion;
        void resetAuthenticatedBrowserDataPreservingAuth(queryClient, collections)
            .then(() => {
                onCacheReset?.(queryClient);
                const currentStatus =
                    queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
                const currentIdentity =
                    currentStatus === undefined
                        ? unresolvedAuthenticationIdentity
                        : authStatusCacheIdentity(currentStatus);
                setTransition((current) => {
                    if (
                        current.requestVersion !== requestVersion ||
                        current.pendingIdentity !== pendingIdentity ||
                        currentIdentity !== pendingIdentity
                    ) {
                        return current;
                    }
                    return {
                        ...current,
                        pendingIdentity: undefined,
                        releasedIdentity: pendingIdentity,
                    };
                });
                return true;
            })
            .catch(() => {
                setTransition((current) =>
                    current.requestVersion === requestVersion
                        ? { ...current, failedIdentity: pendingIdentity }
                        : current
                );
            });
    }, [collections, onCacheReset, queryClient, transition]);

    const resetRequired =
        transition.pendingIdentity !== undefined ||
        identity !== transition.releasedIdentity;
    if (!resetRequired) return children;
    if (transition.failedIdentity === identity) {
        return (
            <PageState
                message="Private browser data could not be refreshed safely."
                onRetry={() =>
                    setTransition((current) => ({
                        ...current,
                        failedIdentity: undefined,
                        pendingIdentity: identity,
                        requestVersion: current.requestVersion + 1,
                    }))
                }
                status="error"
                title="Session data unavailable"
            />
        );
    }
    return <PageState label="Preparing secure session data…" status="loading" />;
}
