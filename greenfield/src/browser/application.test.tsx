import { describe, expect, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";

import { createDashboardQueryClient } from "./api/queryClient.ts";
import { createDashboardTrpcClient } from "./api/trpcClient.ts";
import { DashboardBrowserApplication } from "./application.tsx";
import { authStatusQueryKey } from "./auth/authQueries.ts";
import { createDashboardBrowserCollections } from "./data/dashboardCollections.ts";
import { createDashboardRouter } from "./router.tsx";
import type { DashboardWebAuthnClient } from "./security/webauthn/webauthnClient.ts";
import { noOpDashboardRealtimeClient } from "./test/realtime.ts";

const { render, screen, waitFor } = await import("@testing-library/react");
const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});

describe("Dashboard browser application", () => {
    test("renders the overview and owns throttled authenticated activity", async () => {
        const timestampMs = Date.now();
        const queryClient = createDashboardQueryClient();
        const router = createDashboardRouter(
            createMemoryHistory({ initialEntries: ["/"] })
        );
        let touchCalls = 0;
        const trpcClient = createDashboardTrpcClient({
            mutation(path, input) {
                expect(path).toBe("auth.touch");
                expect(input).toEqual({});
                touchCalls += 1;
                return Promise.resolve({ lastSeenAtMs: timestampMs });
            },
            query(path) {
                if (path !== "auth.status") {
                    return Promise.reject(new TypeError("Unexpected query"));
                }
                return Promise.resolve({
                    session: {
                        authenticatedAtMs: timestampMs,
                        authMethod: "password",
                        createdAtMs: timestampMs,
                        expiresAtMs: timestampMs + 86_400_000,
                        id: "a".repeat(32),
                        isCurrent: true,
                        lastSeenAtMs: timestampMs - 61_000,
                        userAgent: "Dashboard browser test",
                    },
                    state: "authenticated",
                    user: {
                        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
                        username: "operator",
                    },
                });
            },
        });
        const collections = createDashboardBrowserCollections(queryClient, trpcClient);

        const view = render(
            <DashboardBrowserApplication
                collections={collections}
                queryClient={queryClient}
                realtimeClient={noOpDashboardRealtimeClient}
                router={router}
                trpcClient={trpcClient}
                webAuthnClient={unexpectedWebAuthnClient}
            />
        );

        try {
            const heading = await screen.findByRole("heading", {
                level: 1,
                name: "Mira Dashboard",
            });
            expect(heading.textContent).toBe("Mira Dashboard");
            expect(
                screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")
            ).toBe("#dashboard-content");
            expect(
                screen.getByRole("status", { name: "Application status" }).textContent
            ).toContain("Application shell ready");
            expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
            await waitFor(() => expect(touchCalls).toBe(1));
            expect(queryClient.getQueryData(authStatusQueryKey)).toMatchObject({
                session: { lastSeenAtMs: timestampMs },
                state: "authenticated",
                user: { username: "operator" },
            });
        } finally {
            view.unmount();
            await collections.cleanup();
            queryClient.clear();
        }
    });

    test("creates isolated query caches with the reviewed browser defaults", () => {
        const first = createDashboardQueryClient();
        const second = createDashboardQueryClient();

        expect(first).not.toBe(second);
        expect(first.getDefaultOptions()).toMatchObject({
            mutations: { retry: false },
            queries: {
                gcTime: 300_000,
                refetchOnWindowFocus: false,
                retry: 2,
                staleTime: 30_000,
            },
        });
        first.clear();
        second.clear();
    });
});
