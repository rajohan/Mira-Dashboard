import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";

import { createDashboardQueryClient } from "./api/queryClient.ts";
import { createDashboardTrpcClient } from "./api/trpcClient.ts";
import { DashboardBrowserApplication } from "./application.tsx";
import { authStatusQueryKey } from "./auth/authQueries.ts";
import { createDashboardRouter } from "./router.tsx";
import type { DashboardWebAuthnClient } from "./security/webauthn/webauthnClient.ts";
import { acquireBrowserTestEnvironment } from "./testSupport/browserTestEnvironment.ts";

const browserEnvironment = await acquireBrowserTestEnvironment();
const { cleanup, render, screen } = await import("@testing-library/react");
const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});

afterEach(() => {
    cleanup();
});

afterAll(async () => {
    await browserEnvironment.release();
});

describe("Dashboard browser application", () => {
    test("renders the accessible overview through the real providers and router", async () => {
        const queryClient = createDashboardQueryClient();
        const router = createDashboardRouter(
            createMemoryHistory({ initialEntries: ["/"] })
        );
        const trpcClient = createDashboardTrpcClient({
            mutation() {
                return Promise.reject(new TypeError("Unexpected mutation"));
            },
            query(path) {
                if (path !== "auth.status") {
                    return Promise.reject(new TypeError("Unexpected query"));
                }
                return Promise.resolve({
                    session: {
                        authenticatedAtMs: 1_800_000_000_000,
                        authMethod: "password",
                        createdAtMs: 1_800_000_000_000,
                        expiresAtMs: 1_800_086_400_000,
                        id: "a".repeat(32),
                        isCurrent: true,
                        lastSeenAtMs: 1_800_000_000_000,
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

        try {
            render(
                <DashboardBrowserApplication
                    queryClient={queryClient}
                    router={router}
                    trpcClient={trpcClient}
                    webAuthnClient={unexpectedWebAuthnClient}
                />
            );

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
            expect(queryClient.getQueryData(authStatusQueryKey)).toMatchObject({
                state: "authenticated",
                user: { username: "operator" },
            });
        } finally {
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
