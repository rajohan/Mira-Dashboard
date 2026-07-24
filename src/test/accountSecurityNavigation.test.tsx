import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, jest } from "bun:test";
import type { ReactNode } from "react";

import { useRevokeAllSessions, useRevokeSession } from "../hooks/useAccountSecurity";
import { UNAUTHORIZED_EVENT_NAME } from "../lib/authBoundary";
import { authActions, authStore } from "../stores/authStore";

const originalFetch = fetch;

afterEach(() => {
    authActions.clearSession();
    Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: originalFetch,
        writable: true,
    });
});

describe("Account security logout navigation", () => {
    it("routes current-session and all-session revocations through the auth boundary", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";
                if (
                    url === "/api/account/security/sessions/current-session" &&
                    method === "DELETE"
                ) {
                    return Response.json({ isOk: true, loggedOut: true });
                }
                if (
                    url === "/api/account/security/sessions/revoke-all" &&
                    method === "POST"
                ) {
                    return Response.json({ isOk: true, revoked: 2 });
                }
                throw new Error(
                    `Unexpected account-security navigation fetch: ${method} ${url}`
                );
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const unauthorizedEvents: Event[] = [];
        const unauthorizedHandler = (event: Event) => {
            unauthorizedEvents.push(event);
        };
        addEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);

        const queryClient = new QueryClient({
            defaultOptions: {
                mutations: { retry: false },
                queries: { retry: false },
            },
        });
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        );
        const view = renderHook(
            () => ({
                revokeAll: useRevokeAllSessions(),
                revokeCurrent: useRevokeSession(),
            }),
            { wrapper }
        );

        try {
            authActions.setSession({
                authenticated: true,
                isBootstrapRequired: false,
                user: { id: 1, username: "raymond" },
            });
            await act(async () => {
                await view.result.current.revokeCurrent.mutateAsync("current-session");
            });
            expect(authStore.state.isAuthenticated).toBe(false);
            expect(unauthorizedEvents).toHaveLength(1);

            authActions.setSession({
                authenticated: true,
                isBootstrapRequired: false,
                user: { id: 1, username: "raymond" },
            });
            await act(async () => {
                await view.result.current.revokeAll.mutateAsync();
            });
            expect(authStore.state.isAuthenticated).toBe(false);
            expect(unauthorizedEvents).toHaveLength(2);
        } finally {
            view.unmount();
            queryClient.clear();
            removeEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        }
    });
});
