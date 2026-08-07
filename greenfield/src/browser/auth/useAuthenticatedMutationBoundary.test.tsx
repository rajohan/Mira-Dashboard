import { describe, expect, test } from "bun:test";

import { QueryClientProvider, useMutation } from "@tanstack/react-query";
import { act, type ReactNode } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { createDashboardTrpcClient } from "../api/trpcClient.ts";
import {
    createDashboardBrowserCollections,
    type DashboardBrowserCollections,
} from "../data/dashboardCollections.ts";
import {
    authenticatedBrowserCacheGeneration,
    authStatusQueryKey,
    resetAuthenticatedBrowserDataPreservingAuth,
    resetAuthenticatedBrowserCache,
} from "./authQueries.ts";
import {
    AuthenticatedMutationExpiredError,
    useAuthenticatedMutationBoundary,
} from "./useAuthenticatedMutationBoundary.ts";

const { renderHook, waitFor } = await import("@testing-library/react");

const sessionOwnedQueryKey = ["private", "mutation-owner"] as const;

describe("authenticated mutation boundary", () => {
    test("expires generation A without allowing its success callback to mutate generation B", async () => {
        const queryClient = createDashboardQueryClient();
        const client = createDashboardTrpcClient({
            mutation(path) {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            },
            query(path) {
                return Promise.reject(new TypeError(`Unexpected query: ${path}`));
            },
        });
        const collections = createDashboardBrowserCollections(queryClient, client);
        const pendingResult = Promise.withResolvers<string>();
        const statusB = { state: "anonymous" } satisfies AuthStatus;
        let operationSignal: AbortSignal | undefined;
        let operationIsActive: (() => boolean) | undefined;
        let successCalls = 0;
        queryClient.setQueryData(sessionOwnedQueryKey, "generation-a");
        const generationA = authenticatedBrowserCacheGeneration(queryClient);
        const rendered = renderHook(
            () => {
                const boundary = useAuthenticatedMutationBoundary();
                return useMutation<string, Error, void>({
                    mutationFn: () =>
                        boundary.run((signal, isActive) => {
                            operationSignal = signal;
                            operationIsActive = isActive;
                            return pendingResult.promise;
                        }),
                    onSuccess: (result) => {
                        if (!boundary.completionIsCurrent()) return;
                        successCalls += 1;
                        boundary.queryClient.setQueryData(sessionOwnedQueryKey, result);
                    },
                });
            },
            {
                wrapper: ({ children }: { readonly children: ReactNode }) => (
                    <QueryClientProvider client={queryClient}>
                        {children}
                    </QueryClientProvider>
                ),
            }
        );
        let mutationPromise: Promise<string> | undefined;

        try {
            act(() => {
                mutationPromise = rendered.result.current.mutateAsync();
            });
            await waitFor(() => expect(operationSignal).toBeInstanceOf(AbortSignal));
            expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

            await act(async () => {
                await resetAuthenticatedBrowserCache(queryClient, collections, statusB);
                queryClient.setQueryData(sessionOwnedQueryKey, "generation-b");
            });

            if (operationSignal === undefined || operationIsActive === undefined) {
                throw new TypeError("Generation A mutation did not start");
            }
            expect(authenticatedBrowserCacheGeneration(queryClient)).toBe(
                generationA + 2
            );
            expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
            expect(operationSignal.aborted).toBeTrue();
            expect(operationIsActive()).toBeFalse();

            rendered.unmount();
            expect(operationSignal.aborted).toBeTrue();
            if (mutationPromise === undefined) {
                throw new TypeError("Generation A mutation promise is missing");
            }
            const generationAMutation = mutationPromise;

            let failure: unknown;
            await act(async () => {
                pendingResult.resolve("generation-a-result");
                failure = await generationAMutation.catch((error: unknown) => error);
            });

            expect(failure).toBeInstanceOf(AuthenticatedMutationExpiredError);
            expect(successCalls).toBe(0);
            expect(queryClient.getQueryData<string>(sessionOwnedQueryKey)).toBe(
                "generation-b"
            );
            expect(queryClient.getQueryData(authStatusQueryKey)).toEqual(statusB);
        } finally {
            pendingResult.resolve("generation-a-result");
            rendered.unmount();
            await collections.cleanup();
            queryClient.clear();
        }
    });

    test("expires work that starts while an authenticated reset is pending", async () => {
        const queryClient = createDashboardQueryClient();
        const client = createDashboardTrpcClient({
            mutation(path) {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            },
            query(path) {
                return Promise.reject(new TypeError(`Unexpected query: ${path}`));
            },
        });
        const collections = createDashboardBrowserCollections(queryClient, client);
        const resetGate = Promise.withResolvers<void>();
        let resetStarted = false;
        const deferredCollections: DashboardBrowserCollections = Object.freeze({
            get agents() {
                return collections.agents;
            },
            get notifications() {
                return collections.notifications;
            },
            cleanup: () => collections.cleanup(),
            async reset() {
                resetStarted = true;
                await resetGate.promise;
                await collections.reset();
            },
        });
        const pendingResult = Promise.withResolvers<string>();
        let operationSignal: AbortSignal | undefined;
        let operationIsActive: (() => boolean) | undefined;
        let successCalls = 0;
        const rendered = renderHook(
            () => {
                const boundary = useAuthenticatedMutationBoundary();
                return useMutation<string, Error, void>({
                    mutationFn: () =>
                        boundary.run((signal, isActive) => {
                            operationSignal = signal;
                            operationIsActive = isActive;
                            return pendingResult.promise;
                        }),
                    onSuccess: (result) => {
                        if (!boundary.completionIsCurrent()) return;
                        successCalls += 1;
                        boundary.queryClient.setQueryData(sessionOwnedQueryKey, result);
                    },
                });
            },
            {
                wrapper: ({ children }: { readonly children: ReactNode }) => (
                    <QueryClientProvider client={queryClient}>
                        {children}
                    </QueryClientProvider>
                ),
            }
        );
        const generationBeforeReset = authenticatedBrowserCacheGeneration(queryClient);
        const reset = resetAuthenticatedBrowserDataPreservingAuth(
            queryClient,
            deferredCollections
        );
        let mutationPromise: Promise<string> | undefined;

        try {
            await waitFor(() => expect(resetStarted).toBeTrue());
            expect(authenticatedBrowserCacheGeneration(queryClient)).toBe(
                generationBeforeReset + 1
            );

            act(() => {
                mutationPromise = rendered.result.current.mutateAsync();
            });
            await waitFor(() => expect(operationSignal).toBeInstanceOf(AbortSignal));

            await act(async () => {
                resetGate.resolve();
                await reset;
                queryClient.setQueryData(sessionOwnedQueryKey, "next-generation");
            });
            expect(authenticatedBrowserCacheGeneration(queryClient)).toBe(
                generationBeforeReset + 2
            );
            expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
            if (operationSignal === undefined || operationIsActive === undefined) {
                throw new TypeError("Mid-reset mutation did not start");
            }
            expect(operationSignal.aborted).toBeTrue();
            expect(operationIsActive()).toBeFalse();

            if (mutationPromise === undefined) {
                throw new TypeError("Mid-reset mutation promise is missing");
            }
            let failure: unknown;
            await act(async () => {
                pendingResult.resolve("stale-result");
                failure = await mutationPromise?.catch((error: unknown) => error);
            });
            expect(failure).toBeInstanceOf(AuthenticatedMutationExpiredError);
            expect(successCalls).toBe(0);
            expect(queryClient.getQueryData<string>(sessionOwnedQueryKey)).toBe(
                "next-generation"
            );
        } finally {
            resetGate.resolve();
            pendingResult.resolve("stale-result");
            await reset.catch(() => {});
            rendered.unmount();
            await collections.cleanup();
            queryClient.clear();
        }
    });

    test("keeps newer mutation controllers registered after an older operation settles", async () => {
        const queryClient = createDashboardQueryClient();
        const client = createDashboardTrpcClient({
            mutation(path) {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            },
            query(path) {
                return Promise.reject(new TypeError(`Unexpected query: ${path}`));
            },
        });
        const collections = createDashboardBrowserCollections(queryClient, client);
        const pendingA = Promise.withResolvers<string>();
        const pendingB = Promise.withResolvers<string>();
        let signalA: AbortSignal | undefined;
        let signalB: AbortSignal | undefined;
        let isActiveB: (() => boolean) | undefined;
        const rendered = renderHook(() => useAuthenticatedMutationBoundary(), {
            wrapper: ({ children }: { readonly children: ReactNode }) => (
                <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
            ),
        });
        const operationA = rendered.result.current
            .run((signal) => {
                signalA = signal;
                return pendingA.promise;
            })
            .catch((error: unknown) => error);

        try {
            await waitFor(() => expect(signalA).toBeInstanceOf(AbortSignal));
            await resetAuthenticatedBrowserDataPreservingAuth(queryClient, collections);
            expect(signalA?.aborted).toBeTrue();

            const operationB = rendered.result.current
                .run((signal, isActive) => {
                    signalB = signal;
                    isActiveB = isActive;
                    return pendingB.promise;
                })
                .catch((error: unknown) => error);
            await waitFor(() => expect(signalB).toBeInstanceOf(AbortSignal));

            pendingA.resolve("stale-a");
            expect(await operationA).toBeInstanceOf(AuthenticatedMutationExpiredError);
            expect(signalB?.aborted).toBeFalse();

            await resetAuthenticatedBrowserDataPreservingAuth(queryClient, collections);
            expect(signalB?.aborted).toBeTrue();
            expect(isActiveB?.()).toBeFalse();
            pendingB.resolve("stale-b");
            expect(await operationB).toBeInstanceOf(AuthenticatedMutationExpiredError);
        } finally {
            pendingA.resolve("stale-a");
            pendingB.resolve("stale-b");
            rendered.unmount();
            await collections.cleanup();
            queryClient.clear();
        }
    });
});
