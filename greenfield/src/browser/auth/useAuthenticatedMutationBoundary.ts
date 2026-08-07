import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import {
    authenticatedBrowserCacheGeneration,
    authStatusCacheIdentity,
    authStatusQueryKey,
    registerAuthenticatedMutationController,
} from "./authQueries.ts";

/** Internal cancellation when work outlives the authenticated browser cache owner. */
export class AuthenticatedMutationExpiredError extends Error {
    constructor() {
        super("Authenticated mutation cache owner changed");
        this.name = "AuthenticatedMutationExpiredError";
    }
}

interface AuthenticatedMutationOwner {
    readonly cacheGeneration: number;
    readonly identity: string | undefined;
}

function authenticatedMutationIdentity(queryClient: QueryClient): string | undefined {
    const status = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
    return status === undefined ? undefined : authStatusCacheIdentity(status);
}

/**
 * Binds transport cancellation and callbacks to the current authenticated cache owner.
 * @returns Session-bound mutation runner, cache, and completion guard.
 */
export function useAuthenticatedMutationBoundary() {
    const queryClient = useQueryClient();
    const completedOwner = useRef<AuthenticatedMutationOwner | undefined>(undefined);

    async function run<TResult>(
        operation: (signal: AbortSignal, isActive: () => boolean) => Promise<TResult>
    ): Promise<TResult> {
        const owner: AuthenticatedMutationOwner = {
            cacheGeneration: authenticatedBrowserCacheGeneration(queryClient),
            identity: authenticatedMutationIdentity(queryClient),
        };
        const controller = new AbortController();
        const isActive = () =>
            !controller.signal.aborted &&
            authenticatedBrowserCacheGeneration(queryClient) === owner.cacheGeneration &&
            authenticatedMutationIdentity(queryClient) === owner.identity;
        const unregister = registerAuthenticatedMutationController(
            queryClient,
            controller
        );
        try {
            try {
                const result = await operation(controller.signal, isActive);
                if (!isActive()) throw new AuthenticatedMutationExpiredError();
                completedOwner.current = owner;
                return result;
            } catch (error) {
                if (isActive()) completedOwner.current = owner;
                throw error;
            }
        } finally {
            unregister();
        }
    }

    return {
        completionIsCurrent: () => {
            const owner = completedOwner.current;
            return (
                owner !== undefined &&
                owner.cacheGeneration ===
                    authenticatedBrowserCacheGeneration(queryClient) &&
                owner.identity === authenticatedMutationIdentity(queryClient)
            );
        },
        queryClient,
        run,
    };
}
