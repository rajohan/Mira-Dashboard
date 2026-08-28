import { queryOptions, type QueryClient } from "@tanstack/react-query";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import type { DashboardBrowserCollections } from "../data/dashboardCollections.ts";
import { clearTrackedOperations } from "../operations/operationTrackerStorage.ts";

export const authStatusQueryKey = ["auth", "status"] as const;
const authenticatedBrowserCacheGenerations = new WeakMap<QueryClient, number>();
const authenticatedMutationControllers = new WeakMap<QueryClient, Set<AbortController>>();
interface AuthenticationStatusHoldState {
    dirty: boolean;
    holdCount: number;
}

const authenticationStatusHolds = new WeakMap<
    QueryClient,
    AuthenticationStatusHoldState
>();
interface AuthenticationStatusTransition {
    readonly completion: Promise<unknown>;
}

const authenticationStatusTransitions = new WeakMap<
    QueryClient,
    AuthenticationStatusTransition
>();

async function runAuthenticationStatusTransition<TResult>(
    queryClient: QueryClient,
    operation: () => Promise<TResult>
): Promise<TResult> {
    const previousTransition = authenticationStatusTransitions.get(queryClient);
    const completion = (async () => {
        try {
            await previousTransition?.completion;
        } catch {
            // A later resolved identity must still be publishable after a failed transition.
        }
        return operation();
    })();
    const transition: AuthenticationStatusTransition = { completion };
    authenticationStatusTransitions.set(queryClient, transition);
    try {
        return await completion;
    } finally {
        if (authenticationStatusTransitions.get(queryClient) === transition) {
            authenticationStatusTransitions.delete(queryClient);
        }
    }
}

/** @returns Stable auth-boundary identity without volatile session activity metadata. */
export function authStatusCacheIdentity(status: AuthStatus): string {
    switch (status.state) {
        case "authenticated": {
            return `authenticated:${status.user.id}:${status.session.id}`;
        }
        case "pending-mfa": {
            return `pending-mfa:${status.pendingLogin.username}:${status.pendingLogin.expiresAtMs}`;
        }
        default: {
            return status.state;
        }
    }
}

/** @returns Monotonic generation changed before every authenticated cache reset. */
export function authenticatedBrowserCacheGeneration(queryClient: QueryClient): number {
    return authenticatedBrowserCacheGenerations.get(queryClient) ?? 0;
}

/**
 * Registers transport cancellation under the current authenticated cache owner.
 * @returns Cleanup for the exact registered controller.
 */
export function registerAuthenticatedMutationController(
    queryClient: QueryClient,
    controller: AbortController
): () => void {
    const controllers =
        authenticatedMutationControllers.get(queryClient) ?? new Set<AbortController>();
    controllers.add(controller);
    authenticatedMutationControllers.set(queryClient, controllers);
    return () => {
        controllers.delete(controller);
        if (
            controllers.size === 0 &&
            authenticatedMutationControllers.get(queryClient) === controllers
        ) {
            authenticatedMutationControllers.delete(queryClient);
        }
    };
}

function abortAuthenticatedMutations(queryClient: QueryClient): void {
    const controllers = authenticatedMutationControllers.get(queryClient);
    if (controllers === undefined) return;
    authenticatedMutationControllers.delete(queryClient);
    for (const controller of controllers) controller.abort();
}

/**
 * Publishes a resolved authentication identity for the root cache boundary after
 * cancelling any older auth.status request that could overwrite it.
 */
export async function publishAuthenticationStatus(
    queryClient: QueryClient,
    status: AuthStatus
): Promise<void> {
    await runAuthenticationStatusTransition(queryClient, async () => {
        await queryClient.cancelQueries({
            exact: true,
            queryKey: authStatusQueryKey,
        });
        queryClient.setQueryData(authStatusQueryKey, status);
    });
}

/**
 * Publishes an authentication identity only while the captured cache owner remains
 * current at the serialized write point.
 * @returns Whether the guarded status was published.
 */
interface AuthenticationStatusPublicationOptions {
    readonly bypassPublicationHold?: boolean;
}

export async function publishAuthenticationStatusIfCurrent(
    queryClient: QueryClient,
    status: AuthStatus,
    isCurrent: () => boolean,
    options: AuthenticationStatusPublicationOptions = {}
): Promise<boolean> {
    const { bypassPublicationHold = false } = options;
    return runAuthenticationStatusTransition(queryClient, async () => {
        if (!isCurrent()) return false;
        const hold = authenticationStatusHolds.get(queryClient);
        if (!bypassPublicationHold && hold !== undefined) {
            hold.dirty = true;
            return true;
        }
        await queryClient.cancelQueries({
            exact: true,
            queryKey: authStatusQueryKey,
        });
        if (!isCurrent()) return false;
        queryClient.setQueryData(authStatusQueryKey, status);
        return true;
    });
}

/**
 * Defers background auth-status publication while a proof rotates the session and
 * the exact protected operation is replayed against the new cookie.
 * @returns An idempotent release function for the acquired hold.
 */
export function holdAuthenticationStatusPublication(
    queryClient: QueryClient
): (reconciled?: boolean) => Promise<void> {
    const state = authenticationStatusHolds.get(queryClient) ?? {
        dirty: false,
        holdCount: 0,
    };
    state.holdCount += 1;
    authenticationStatusHolds.set(queryClient, state);
    let active = true;
    return async (reconciled = false) => {
        if (!active) return;
        active = false;
        state.holdCount -= 1;
        if (state.holdCount > 0) return;
        if (authenticationStatusHolds.get(queryClient) === state) {
            authenticationStatusHolds.delete(queryClient);
        }
        if (state.dirty && !reconciled) {
            await queryClient.invalidateQueries({
                exact: true,
                queryKey: authStatusQueryKey,
            });
        }
    };
}

/**
 * Invalidates auth.status immediately unless a security-verification replay owns a
 * publication hold. Held invalidations are reconciled from the server afterward.
 */
export async function invalidateAuthenticationStatusWhenAllowed(
    queryClient: QueryClient
): Promise<void> {
    const hold = authenticationStatusHolds.get(queryClient);
    if (hold !== undefined) {
        hold.dirty = true;
        return;
    }
    await queryClient.invalidateQueries({
        exact: true,
        queryKey: authStatusQueryKey,
    });
}

function beginAuthenticatedBrowserCacheReset(queryClient: QueryClient): void {
    clearTrackedOperations();
    authenticatedBrowserCacheGenerations.set(
        queryClient,
        authenticatedBrowserCacheGeneration(queryClient) + 1
    );
    abortAuthenticatedMutations(queryClient);
    queryClient.getMutationCache().clear();
}

function finishAuthenticatedBrowserCacheReset(queryClient: QueryClient): void {
    authenticatedBrowserCacheGenerations.set(
        queryClient,
        authenticatedBrowserCacheGeneration(queryClient) + 1
    );
    abortAuthenticatedMutations(queryClient);
    queryClient.getMutationCache().clear();
}

function isAuthenticationStatusQuery(queryKey: readonly unknown[]): boolean {
    return (
        queryKey.length === authStatusQueryKey.length &&
        queryKey.every((value, index) => value === authStatusQueryKey[index])
    );
}

async function clearAuthenticatedBrowserData(
    queryClient: QueryClient,
    collections: DashboardBrowserCollections
): Promise<void> {
    beginAuthenticatedBrowserCacheReset(queryClient);
    try {
        await queryClient.cancelQueries({
            predicate: (query) => !isAuthenticationStatusQuery(query.queryKey),
        });
    } finally {
        try {
            await collections.reset();
        } finally {
            try {
                for (const query of queryClient.getQueryCache().getAll()) {
                    if (isAuthenticationStatusQuery(query.queryKey)) continue;
                    queryClient.removeQueries({
                        exact: true,
                        queryKey: query.queryKey,
                    });
                }
            } finally {
                finishAuthenticatedBrowserCacheReset(queryClient);
            }
        }
    }
}

/**
 * Clears private browser state while retaining whichever auth.status value is current
 * when the serialized reset completes.
 */
export async function resetAuthenticatedBrowserDataPreservingAuth(
    queryClient: QueryClient,
    collections: DashboardBrowserCollections
): Promise<void> {
    await clearAuthenticatedBrowserData(queryClient, collections);
}

/**
 * Defines the sole cache entry for non-secret browser authentication state.
 * @param client Browser contract client.
 * @returns TanStack Query options with request cancellation propagation.
 */
export function authStatusQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("auth.status", {}, { signal }),
        queryKey: authStatusQueryKey,
        retry: false,
        staleTime: 0,
    });
}

/**
 * Replaces all cached browser data after an authentication boundary changes.
 * @param queryClient Browser-owned query cache.
 * @param collections Browser-owned normalized collection registry.
 * @param status Optional known state to seed after clearing.
 */
export async function resetAuthenticatedBrowserCache(
    queryClient: QueryClient,
    collections: DashboardBrowserCollections,
    status?: AuthStatus
): Promise<void> {
    const authenticationQueryAtStart = queryClient.getQueryCache().find({
        exact: true,
        queryKey: authStatusQueryKey,
    });
    const authenticationUpdateCountAtStart =
        authenticationQueryAtStart?.state.dataUpdateCount;
    try {
        await clearAuthenticatedBrowserData(queryClient, collections);
    } finally {
        const currentAuthenticationQuery = queryClient.getQueryCache().find({
            exact: true,
            queryKey: authStatusQueryKey,
        });
        const authenticationIsUnchanged =
            currentAuthenticationQuery === authenticationQueryAtStart &&
            currentAuthenticationQuery?.state.dataUpdateCount ===
                authenticationUpdateCountAtStart;
        if (authenticationIsUnchanged) {
            if (status === undefined) {
                queryClient.clear();
            } else {
                await publishAuthenticationStatus(queryClient, status);
            }
        }
    }
}
