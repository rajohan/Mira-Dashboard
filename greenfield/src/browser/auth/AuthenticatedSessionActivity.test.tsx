import { describe, expect, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { createDashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { AuthenticatedSessionActivity } from "./AuthenticatedSessionActivity.tsx";
import { authStatusQueryKey } from "./authQueries.ts";

const { render, waitFor } = await import("@testing-library/react");

function authenticatedStatus(lastSeenAtMs: number): AuthStatus {
    return {
        session: {
            authenticatedAtMs: lastSeenAtMs,
            authMethod: "password",
            createdAtMs: lastSeenAtMs,
            expiresAtMs: lastSeenAtMs + 86_400_000,
            id: "a".repeat(32),
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
    test("touches stale activity once, refreshes the cache, and removes listeners", async () => {
        const queryClient = createDashboardQueryClient();
        const staleLastSeenAtMs = Date.now() - 61_000;
        const touchedAtMs = staleLastSeenAtMs + 60_000;
        const staleStatus = authenticatedStatus(staleLastSeenAtMs);
        const statusRefresh = Promise.withResolvers<unknown>();
        queryClient.setQueryData(authStatusQueryKey, staleStatus);
        let mutationCalls = 0;
        const client = createDashboardTrpcClient({
            mutation(path, input) {
                expect(path).toBe("auth.touch");
                expect(input).toEqual({});
                mutationCalls += 1;
                return Promise.resolve({ lastSeenAtMs: touchedAtMs });
            },
            query(path) {
                expect(path).toBe("auth.status");
                return statusRefresh.promise;
            },
        });
        const rendered = render(
            <QueryClientProvider client={queryClient}>
                <DashboardTrpcProvider client={client}>
                    <AuthenticatedSessionActivity />
                </DashboardTrpcProvider>
            </QueryClientProvider>
        );
        let unmounted = false;

        try {
            act(() => {
                document.dispatchEvent(new Event("pointerdown"));
            });
            await waitFor(() => expect(mutationCalls).toBe(1));
            expect(
                queryClient.getQueryData<AuthStatus>(authStatusQueryKey)
            ).toMatchObject({
                session: { lastSeenAtMs: touchedAtMs },
                state: "authenticated",
            });

            act(() => {
                document.dispatchEvent(new Event("keydown"));
                document.dispatchEvent(new Event("scroll"));
            });
            expect(mutationCalls).toBe(1);

            await act(async () => {
                statusRefresh.resolve(authenticatedStatus(touchedAtMs));
                await statusRefresh.promise;
            });
            await waitFor(() => expect(queryClient.isFetching()).toBe(0));

            rendered.unmount();
            unmounted = true;
            queryClient.setQueryData(
                authStatusQueryKey,
                authenticatedStatus(staleLastSeenAtMs)
            );
            document.dispatchEvent(new Event("pointerdown"));
            expect(mutationCalls).toBe(1);
        } finally {
            statusRefresh.resolve(authenticatedStatus(touchedAtMs));
            if (!unmounted) rendered.unmount();
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
        const rendered = render(
            <QueryClientProvider client={queryClient}>
                <DashboardTrpcProvider client={client}>
                    <AuthenticatedSessionActivity />
                </DashboardTrpcProvider>
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
        const rendered = render(
            <QueryClientProvider client={queryClient}>
                <DashboardTrpcProvider client={client}>
                    <AuthenticatedSessionActivity />
                </DashboardTrpcProvider>
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
            queryClient.clear();
        }
    });
});
