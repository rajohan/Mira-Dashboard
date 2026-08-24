import { expect, jest, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { DatabaseOverview } from "../../contracts/database.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import {
    createDashboardTrpcClient,
    type DashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { DashboardBrowserApplication } from "../application.tsx";
import { createDashboardBrowserCollections } from "../data/dashboardCollections.ts";
import { databaseOverviewQueryKey } from "../database/databaseQueries.ts";
import { normalizeDatabaseSearch } from "../database/databaseRouteSearch.ts";
import { createDashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "../security/webauthn/webauthnClient.ts";
import { emptyNotificationListResult } from "../test/notifications.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";
import { Route as databaseLazyRoute } from "./database.lazy.tsx";

const { render, screen, waitFor, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});

function authenticatedStatus(timestampMs: number): AuthStatus {
    return {
        session: {
            authenticatedAtMs: timestampMs,
            authMethod: "password",
            createdAtMs: timestampMs,
            expiresAtMs: timestampMs + 86_400_000,
            id: "a".repeat(32),
            isCurrent: true,
            lastSeenAtMs: timestampMs,
        },
        state: "authenticated",
        user: {
            id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
            email: "operator@example.com",
            username: "operator",
        },
    };
}

function unavailableDatabaseOverview(timestampMs: number): DatabaseOverview {
    return {
        checkedAtMs: timestampMs,
        postgresql: { state: "unavailable" },
        sqlite: { state: "unavailable" },
    };
}

test("database lazy route verifies the current session before rendering diagnostics", async () => {
    expect(databaseLazyRoute.options.id).toBe("/database");
    const RouteBoundary = databaseLazyRoute.options.component;
    expect(RouteBoundary).toBeFunction();
    if (RouteBoundary === undefined) throw new TypeError("Database route is missing");

    const nowMs = Date.now();
    const overview = {
        checkedAtMs: nowMs,
        postgresql: { state: "unavailable" },
        sqlite: { state: "unavailable" },
    } as const satisfies DatabaseOverview;
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(databaseOverviewQueryKey, overview, { updatedAt: nowMs });
    const statusRequest = Promise.withResolvers<AuthStatus>();
    const query = jest.fn((name: string) => {
        if (name === "auth.status") return statusRequest.promise;
        return Promise.reject(new Error(`Unexpected query: ${name}`));
    });
    const client = {
        mutation: () => Promise.reject(new Error("Unexpected mutation")),
        query,
    } as unknown as DashboardTrpcClient;
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const databaseRoute = createRoute({
        component: RouteBoundary,
        getParentRoute: () => rootRoute,
        path: "/database",
        validateSearch: normalizeDatabaseSearch,
    });
    const router = createRouter({
        history: createMemoryHistory({
            initialEntries: ["/database?source=postgresql"],
        }),
        routeTree: rootRoute.addChildren([databaseRoute]),
    });
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardRealtimeProvider client={noOpDashboardRealtimeClient}>
                <DashboardTrpcProvider client={client}>
                    <RouterProvider router={router} />
                </DashboardTrpcProvider>
            </DashboardRealtimeProvider>
        </QueryClientProvider>
    );

    try {
        expect(await screen.findByLabelText("Authentication status")).toHaveTextContent(
            "Checking your session…"
        );
        expect(screen.queryByRole("heading", { name: "Database" })).toBeNull();

        await act(async () => {
            statusRequest.resolve({
                session: {
                    authenticatedAtMs: nowMs,
                    authMethod: "password",
                    createdAtMs: nowMs,
                    expiresAtMs: nowMs + 86_400_000,
                    id: "a".repeat(32),
                    isCurrent: true,
                    lastSeenAtMs: nowMs,
                },
                state: "authenticated",
                user: {
                    id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
                    email: "operator@example.com",
                    username: "operator",
                },
            });
            await statusRequest.promise;
        });

        expect(
            await screen.findByRole("heading", { level: 1, name: "Database" })
        ).toBeVisible();
        expect(
            screen.getByRole("tab", { name: "PostgreSQL & PgBouncer" })
        ).toHaveAttribute("aria-selected", "true");
        expect(query).toHaveBeenCalledWith(
            "auth.status",
            {},
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
        await userEvent.click(screen.getByRole("tab", { name: "Dashboard SQLite" }));
        expect(router.state.location.search).toEqual({ source: "sqlite" });
    } finally {
        view.unmount();
        queryClient.clear();
    }
});

test("full Dashboard router owns normalized database source history and shell state", async () => {
    const nowMs = Date.now();
    const overview = unavailableDatabaseOverview(nowMs);
    const transport: DashboardTrpcTransport = {
        mutation: (path) => Promise.reject(new TypeError(`Unexpected mutation: ${path}`)),
        query: (path) => {
            switch (path) {
                case "auth.status": {
                    return Promise.resolve(authenticatedStatus(nowMs));
                }
                case "database.overview": {
                    return Promise.resolve(overview);
                }
                case "notifications.list": {
                    return Promise.resolve(emptyNotificationListResult);
                }
                default: {
                    return Promise.reject(new TypeError(`Unexpected query: ${path}`));
                }
            }
        },
    };
    const queryClient = createDashboardQueryClient();
    queryClient.setDefaultOptions({
        ...queryClient.getDefaultOptions(),
        queries: {
            ...queryClient.getDefaultOptions().queries,
            retry: false,
        },
    });
    const trpcClient = createDashboardTrpcClient(transport);
    const collections = createDashboardBrowserCollections(queryClient, trpcClient);
    const router = createDashboardRouter(
        createMemoryHistory({
            initialEntries: ["/database?ignored=true&source=invalid"],
        })
    );
    await router.load();
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
        expect(
            await screen.findByRole("heading", { level: 1, name: "Database" })
        ).toBeVisible();
        expect(router.state.location.search.source).toBe("sqlite");
        expect(screen.getByRole("tab", { name: "Dashboard SQLite" })).toHaveAttribute(
            "aria-selected",
            "true"
        );
        const navigation = screen.getByRole("navigation", {
            name: "Main navigation",
        });
        expect(
            within(navigation).getByRole("link", { name: "Database" })
        ).toHaveAttribute("aria-current", "page");
        expect(screen.getByText("Database", { selector: "header p" })).toBeVisible();

        await userEvent.click(
            screen.getByRole("tab", { name: "PostgreSQL & PgBouncer" })
        );
        await waitFor(() =>
            expect(router.state.location.search).toEqual({ source: "postgresql" })
        );
        expect(router.history.location.href).toBe("/database?source=postgresql");
        expect(
            screen.getByRole("tab", { name: "PostgreSQL & PgBouncer" })
        ).toHaveAttribute("aria-selected", "true");

        act(() => router.history.back());
        await waitFor(() =>
            expect(screen.getByRole("tab", { name: "Dashboard SQLite" })).toHaveAttribute(
                "aria-selected",
                "true"
            )
        );
        expect(router.state.location.search.source).toBe("sqlite");

        act(() => router.history.forward());
        await waitFor(() =>
            expect(
                screen.getByRole("tab", { name: "PostgreSQL & PgBouncer" })
            ).toHaveAttribute("aria-selected", "true")
        );
        expect(router.state.location.search).toEqual({ source: "postgresql" });
    } finally {
        await act(async () => {
            view.unmount();
            await collections.cleanup();
            queryClient.clear();
        });
    }
});
