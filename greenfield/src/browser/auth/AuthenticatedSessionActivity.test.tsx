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
});
