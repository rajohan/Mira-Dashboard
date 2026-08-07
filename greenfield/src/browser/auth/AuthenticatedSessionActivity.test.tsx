import { describe, expect, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { createDashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { createDashboardBrowserCollections } from "../data/dashboardCollections.ts";
import { DashboardCollectionsProvider } from "../data/dashboardCollectionsContext.tsx";
import { AuthenticatedBrowserCacheBoundary } from "./AuthenticatedBrowserCacheBoundary.tsx";
import { AuthenticatedSessionActivity } from "./AuthenticatedSessionActivity.tsx";
import { authStatusQueryKey } from "./authQueries.ts";

const { render, waitFor } = await import("@testing-library/react");

function authenticatedStatus(
    lastSeenAtMs: number,
    sessionId = "a".repeat(32)
): AuthStatus {
    return {
        session: {
            authenticatedAtMs: lastSeenAtMs,
            authMethod: "password",
            createdAtMs: lastSeenAtMs,
            expiresAtMs: lastSeenAtMs + 86_400_000,
            id: sessionId,
            isCurrent: true,
            lastSeenAtMs,
            userAgent: "Dashboard browser test",
        },
        state: "authenticated",
        user: {
            id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
            username: "operator",
        },
    };
}

describe("authenticated browser activity", () => {
    test("uses a fresh post-touch status request and ignores the cancelled pre-touch result", async () => {
        const queryClient = createDashboardQueryClient();
        const staleLastSeenAtMs = Date.now() - 61_000;
        const touchedAtMs = staleLastSeenAtMs + 60_000;
        const staleStatus = authenticatedStatus(staleLastSeenAtMs);
        const currentStatus = authenticatedStatus(Date.now(), "b".repeat(32));
        const preTouchStatus = Promise.withResolvers<unknown>();
        const postTouchStatus = Promise.withResolvers<unknown>();
        queryClient.setQueryData(authStatusQueryKey, staleStatus);
        let mutationCalls = 0;
        let statusQueryCalls = 0;
        const client = createDashboardTrpcClient({
            mutation(path, input) {
                expect(path).toBe("auth.touch");
                expect(input).toEqual({});
                mutationCalls += 1;
                return Promise.resolve({ lastSeenAtMs: touchedAtMs });
            },
            query(path) {
                expect(path).toBe("auth.status");
                statusQueryCalls += 1;
                if (statusQueryCalls === 1) return preTouchStatus.promise;
                if (statusQueryCalls === 2) return postTouchStatus.promise;
                return Promise.reject(
                    new TypeError(`Unexpected auth.status request ${statusQueryCalls}`)
                );
            },
        });
        const collections = createDashboardBrowserCollections(queryClient, client);
        const rendered = render(
            <QueryClientProvider client={queryClient}>
                <DashboardCollectionsProvider collections={collections}>
                    <DashboardTrpcProvider client={client}>
                        <AuthenticatedSessionActivity />
                    </DashboardTrpcProvider>
                </DashboardCollectionsProvider>
            </QueryClientProvider>
        );

        try {
            await waitFor(() => expect(mutationCalls).toBe(1));
            await waitFor(() => expect(statusQueryCalls).toBe(2));
            expect(queryClient.getQueryData(authStatusQueryKey)).toEqual(staleStatus);

            act(() => {
                document.dispatchEvent(new Event("keydown"));
                document.dispatchEvent(new Event("scroll"));
            });
            expect(mutationCalls).toBe(1);

            await act(async () => {
                postTouchStatus.resolve(currentStatus);
                await postTouchStatus.promise;
            });
            await waitFor(() => expect(queryClient.isFetching()).toBe(0));
            expect(queryClient.getQueryData(authStatusQueryKey)).toEqual(currentStatus);

            await act(async () => {
                preTouchStatus.resolve(staleStatus);
                await preTouchStatus.promise;
            });
            expect(queryClient.getQueryData(authStatusQueryKey)).toEqual(currentStatus);
        } finally {
            preTouchStatus.resolve(staleStatus);
            postTouchStatus.resolve(currentStatus);
            rendered.unmount();
            await collections.cleanup();
            queryClient.clear();
        }
    });

    test("reconciles auth.status on window focus and visible document changes", async () => {
        const queryClient = createDashboardQueryClient();
        const currentStatus = authenticatedStatus(Date.now());
        queryClient.setQueryData(authStatusQueryKey, currentStatus);
        let mutationCalls = 0;
        let statusQueryCalls = 0;
        const client = createDashboardTrpcClient({
            mutation(path) {
                mutationCalls += 1;
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            },
            query(path) {
                expect(path).toBe("auth.status");
                statusQueryCalls += 1;
                return Promise.resolve(currentStatus);
            },
        });
        const collections = createDashboardBrowserCollections(queryClient, client);
        const rendered = render(
            <QueryClientProvider client={queryClient}>
                <DashboardCollectionsProvider collections={collections}>
                    <DashboardTrpcProvider client={client}>
                        <AuthenticatedSessionActivity />
                    </DashboardTrpcProvider>
                </DashboardCollectionsProvider>
            </QueryClientProvider>
        );

        try {
            await waitFor(() => expect(statusQueryCalls).toBe(1));
            await waitFor(() => expect(queryClient.isFetching()).toBe(0));

            act(() => {
                globalThis.dispatchEvent(new Event("focus"));
            });
            await waitFor(() => expect(statusQueryCalls).toBe(2));
            await waitFor(() => expect(queryClient.isFetching()).toBe(0));

            expect(document.visibilityState).toBe("visible");
            act(() => {
                document.dispatchEvent(new Event("visibilitychange"));
            });
            await waitFor(() => expect(statusQueryCalls).toBe(3));
            await waitFor(() => expect(queryClient.isFetching()).toBe(0));
            expect(mutationCalls).toBe(0);
        } finally {
            rendered.unmount();
            await collections.cleanup();
            queryClient.clear();
        }
    });

    test("discovers a cross-tab login while the cached status is anonymous", async () => {
        const queryClient = createDashboardQueryClient();
        const anonymousStatus = { state: "anonymous" } satisfies AuthStatus;
        const authenticated = authenticatedStatus(Date.now());
        let currentStatus: AuthStatus = anonymousStatus;
        let statusQueryCalls = 0;
        queryClient.setQueryData(authStatusQueryKey, anonymousStatus);
        const client = createDashboardTrpcClient({
            mutation(path) {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            },
            query(path) {
                expect(path).toBe("auth.status");
                statusQueryCalls += 1;
                return Promise.resolve(currentStatus);
            },
        });
        const collections = createDashboardBrowserCollections(queryClient, client);
        const rendered = render(
            <QueryClientProvider client={queryClient}>
                <DashboardCollectionsProvider collections={collections}>
                    <DashboardTrpcProvider client={client}>
                        <AuthenticatedBrowserCacheBoundary>
                            <AuthenticatedSessionActivity />
                        </AuthenticatedBrowserCacheBoundary>
                    </DashboardTrpcProvider>
                </DashboardCollectionsProvider>
            </QueryClientProvider>
        );

        try {
            await waitFor(() => expect(statusQueryCalls).toBeGreaterThanOrEqual(1));
            await waitFor(() => expect(queryClient.isFetching()).toBe(0));
            const anonymousCollections = collections.agents;
            currentStatus = authenticated;

            act(() => {
                globalThis.dispatchEvent(new Event("focus"));
            });

            await waitFor(() =>
                expect(queryClient.getQueryData(authStatusQueryKey)).toEqual(
                    authenticated
                )
            );
            await waitFor(() =>
                expect(collections.agents).not.toBe(anonymousCollections)
            );
        } finally {
            rendered.unmount();
            await collections.cleanup();
            queryClient.clear();
        }
    });

    test("captures non-bubbling scroll activity from an overflow container", async () => {
        const queryClient = createDashboardQueryClient();
        const currentLastSeenAtMs = Date.now();
        const staleLastSeenAtMs = currentLastSeenAtMs - 61_000;
        const touchedAtMs = currentLastSeenAtMs + 1;
        queryClient.setQueryData(
            authStatusQueryKey,
            authenticatedStatus(currentLastSeenAtMs)
        );
        let mutationCalls = 0;
        const client = createDashboardTrpcClient({
            mutation(path) {
                expect(path).toBe("auth.touch");
                mutationCalls += 1;
                return Promise.resolve({ lastSeenAtMs: touchedAtMs });
            },
            query(path) {
                expect(path).toBe("auth.status");
                return Promise.resolve(authenticatedStatus(currentLastSeenAtMs));
            },
        });
        const collections = createDashboardBrowserCollections(queryClient, client);
        const rendered = render(
            <QueryClientProvider client={queryClient}>
                <DashboardCollectionsProvider collections={collections}>
                    <DashboardTrpcProvider client={client}>
                        <AuthenticatedSessionActivity />
                    </DashboardTrpcProvider>
                </DashboardCollectionsProvider>
            </QueryClientProvider>
        );
        const scrollContainer = document.createElement("div");
        document.body.append(scrollContainer);

        try {
            await waitFor(() => expect(queryClient.isFetching()).toBe(0));
            expect(mutationCalls).toBe(0);
            queryClient.setQueryData(
                authStatusQueryKey,
                authenticatedStatus(staleLastSeenAtMs)
            );

            act(() => {
                scrollContainer.dispatchEvent(new Event("scroll", { bubbles: false }));
            });

            await waitFor(() => expect(mutationCalls).toBe(1));
        } finally {
            scrollContainer.remove();
            rendered.unmount();
            await collections.cleanup();
            queryClient.clear();
        }
    });

    test("clears authenticated state when the server rejects a touch", async () => {
        const queryClient = createDashboardQueryClient();
        const staleStatus = authenticatedStatus(Date.now() - 61_000);
        const statusRefresh = Promise.withResolvers<AuthStatus>();
        const unauthorizedTouchError = Object.assign(new Error("Touch rejected"), {
            data: { code: "UNAUTHORIZED" },
        });
        queryClient.setQueryData(authStatusQueryKey, staleStatus);
        queryClient.setQueryData(["security", "private"], { private: true });
        const client = createDashboardTrpcClient({
            mutation(path) {
                expect(path).toBe("auth.touch");
                return Promise.reject(unauthorizedTouchError);
            },
            query(path) {
                expect(path).toBe("auth.status");
                return statusRefresh.promise;
            },
        });
        const collections = createDashboardBrowserCollections(queryClient, client);
        const rendered = render(
            <QueryClientProvider client={queryClient}>
                <DashboardCollectionsProvider collections={collections}>
                    <DashboardTrpcProvider client={client}>
                        <AuthenticatedBrowserCacheBoundary>
                            <AuthenticatedSessionActivity />
                        </AuthenticatedBrowserCacheBoundary>
                    </DashboardTrpcProvider>
                </DashboardCollectionsProvider>
            </QueryClientProvider>
        );

        try {
            await waitFor(() =>
                expect(queryClient.getQueryData<AuthStatus>(authStatusQueryKey)).toEqual({
                    state: "anonymous",
                })
            );
            expect(queryClient.getQueryData(["security", "private"])).toBeUndefined();

            statusRefresh.resolve(staleStatus);
            await statusRefresh.promise;
            expect(queryClient.getQueryData<AuthStatus>(authStatusQueryKey)).toEqual({
                state: "anonymous",
            });
        } finally {
            statusRefresh.resolve(staleStatus);
            rendered.unmount();
            await collections.cleanup();
            queryClient.clear();
        }
    });
});
