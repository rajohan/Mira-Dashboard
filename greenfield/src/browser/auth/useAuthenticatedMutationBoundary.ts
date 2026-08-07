import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import {
    authenticatedBrowserCacheGeneration,
    registerAuthenticatedMutationController,
} from "./authQueries.ts";

/** Internal cancellation when work outlives the authenticated browser cache owner. */
export class AuthenticatedMutationExpiredError extends Error {
    constructor() {
        super("Authenticated mutation cache owner changed");
        this.name = "AuthenticatedMutationExpiredError";
    }
}

/**
 * Binds transport cancellation and callbacks to the current authenticated cache generation.
 * @returns Session-bound mutation runner, cache, and completion guard.
 */
export function useAuthenticatedMutationBoundary() {
    const queryClient = useQueryClient();
    const completedGeneration = useRef<number | undefined>(undefined);

    async function run<TResult>(
        operation: (signal: AbortSignal, isActive: () => boolean) => Promise<TResult>
    ): Promise<TResult> {
        const generation = authenticatedBrowserCacheGeneration(queryClient);
        const controller = new AbortController();
        const isActive = () =>
            !controller.signal.aborted &&
            authenticatedBrowserCacheGeneration(queryClient) === generation;
        const unregister = registerAuthenticatedMutationController(
            queryClient,
            controller
        );
        try {
            try {
                const result = await operation(controller.signal, isActive);
                if (!isActive()) throw new AuthenticatedMutationExpiredError();
                completedGeneration.current = generation;
                return result;
            } catch (error) {
                if (isActive()) completedGeneration.current = generation;
                throw error;
            }
        } finally {
            unregister();
        }
    }

    return {
        completionIsCurrent: () =>
            completedGeneration.current ===
            authenticatedBrowserCacheGeneration(queryClient),
        queryClient,
        run,
    };
}
