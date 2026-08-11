import { describe, expect, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";

import type { AuthStatus } from "../contracts/auth.ts";
import { deriveGatewaySessionStats } from "../contracts/gatewaySessions.ts";
import type { SystemHealthDiagnostics } from "../contracts/system.ts";
import { createDashboardQueryClient } from "./api/queryClient.ts";
import { createDashboardTrpcClient } from "./api/trpcClient.ts";
import { DashboardBrowserApplication } from "./application.tsx";
import { authStatusQueryKey } from "./auth/authQueries.ts";
import { createDashboardBrowserCollections } from "./data/dashboardCollections.ts";
import { dashboardHealthDiagnosticsQueryKey } from "./layout/dashboardSystemStatus.ts";
import { notificationLatestQueryKey } from "./notifications/notificationQueries.ts";
import { createDashboardRouter } from "./router.tsx";
import type { DashboardWebAuthnClient } from "./security/webauthn/webauthnClient.ts";
import { noOpDashboardRealtimeClient } from "./test/realtime.ts";

const { act, render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;
const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});

function healthDiagnostics(
    timestampMs: number,
    options: {
        readonly claimingPaused?: boolean;
        readonly workerReady?: boolean;
    } = {}
): SystemHealthDiagnostics {
    const workerReady = options.workerReady ?? true;
    return {
        checkedAtMs: timestampMs,
        checks: {
            application: { status: "ready" },
            database: { status: "ready" },
            frontend: { status: "ready" },
            release: { status: "verified" },
            worker: { status: workerReady ? "ready" : "not-ready" },
        },
        dependencies: {
            gateway: {
                freshness: "fresh",
                phase: "connected",
                status: "observed",
            },
            sessions: {
                count: 0,
                observedAtMs: timestampMs,
                state: "fresh",
                truncated: false,
            },
        },
        queue: {
            claimingPaused: options.claimingPaused ?? false,
            runs: { queued: 0, running: 0 },
            status: "observed",
            workers: {
                capacity: workerReady ? 1 : 0,
                drainingCount: 0,
                freshCount: workerReady ? 1 : 0,
                onlineCount: workerReady ? 1 : 0,
            },
        },
        status: workerReady ? "ready" : "not-ready",
    };
}

describe("Dashboard browser application", () => {
    test("renders the overview cache foundation and owns authenticated activity", async () => {
        const timestampMs = Date.now();
        const queryClient = createDashboardQueryClient();
        const router = createDashboardRouter(
            createMemoryHistory({ initialEntries: ["/"] })
        );
        let touchCalls = 0;
        let logoutCalls = 0;
        let notificationCalls = 0;
        let cacheStatusCalls = 0;
        let healthUnavailable = false;
        let healthStatusCalls = 0;
        let settleLogout: ((result: { readonly isOk: true }) => void) | undefined;
        const trpcClient = createDashboardTrpcClient({
            mutation(path, input) {
                expect(input).toEqual({});
                if (path === "auth.touch") {
                    touchCalls += 1;
                    return Promise.resolve({ lastSeenAtMs: timestampMs });
                }
                if (path === "auth.logout") {
                    logoutCalls += 1;
                    return new Promise((resolve) => {
                        settleLogout = resolve;
                    });
                }
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            },
            query(path, input) {
                if (path === "system.healthDiagnostics") {
                    expect(input).toEqual({});
                    healthStatusCalls += 1;
                    return healthUnavailable
                        ? Promise.reject(new Error("Health refresh unavailable"))
                        : Promise.resolve(healthDiagnostics(timestampMs));
                }
                if (path === "jobs.listRuns") {
                    expect(input).toEqual({ limit: 1 });
                    return Promise.resolve({
                        runs: [],
                        summary: {
                            activeResourceClasses: [],
                            control: {
                                claimingPaused: true,
                                updatedAtMs: timestampMs,
                                version: 1,
                            },
                            stateCounts: {
                                cancelled: 0,
                                failed: 0,
                                queued: 0,
                                running: 0,
                                succeeded: 0,
                                "timed-out": 0,
                            },
                            workers: [
                                {
                                    activeRunCount: 0,
                                    capacity: 1,
                                    heartbeatAtMs: timestampMs,
                                    id: "019fe300-0000-7000-8000-000000000001",
                                    releaseId: "a".repeat(40),
                                    startedAtMs: timestampMs - 60_000,
                                    state: "online",
                                },
                            ],
                        },
                    });
                }
                if (path === "cache.getStatus") {
                    expect(input).toEqual({});
                    cacheStatusCalls += 1;
                    return Promise.resolve({
                        entries: [],
                        generatedAtMs: timestampMs,
                        totalCount: 0,
                        truncated: false,
                    });
                }
                if (path === "notifications.list") {
                    expect(input).toEqual({ limit: 100 });
                    notificationCalls += 1;
                    return Promise.resolve({
                        notifications: [],
                        readCount: 0,
                        unreadCount: 0,
                    });
                }
                if (path !== "auth.status") {
                    return Promise.reject(new TypeError(`Unexpected query: ${path}`));
                }
                if (logoutCalls > 0) {
                    return Promise.resolve({ state: "anonymous" });
                }
                return Promise.resolve({
                    session: {
                        authenticatedAtMs: timestampMs,
                        authMethod: "password",
                        createdAtMs: timestampMs,
                        expiresAtMs: timestampMs + 86_400_000,
                        id: "a".repeat(32),
                        isCurrent: true,
                        lastSeenAtMs:
                            touchCalls === 0 ? timestampMs - 61_000 : timestampMs,
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
                screen
                    .getByText("Dashboard", { selector: "header > p" })
                    .closest("header")
            ).toHaveClass("bg-primary-950", "h-16", "shrink-0", "border-b");
            expect(screen.getByRole("complementary").firstElementChild).toHaveClass(
                "h-16",
                "shrink-0",
                "border-b"
            );
            expect(
                screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")
            ).toBe("#dashboard-content");
            expect(
                screen.getByRole("heading", {
                    level: 2,
                    name: "Saved system data",
                })
            ).toBeTruthy();
            expect(
                screen.getByRole("heading", { level: 3, name: "No saved data yet" })
            ).toBeTruthy();
            expect(screen.queryByText("Select a data source")).toBeNull();
            await waitFor(() => expect(touchCalls).toBe(1));
            await waitFor(() => expect(notificationCalls).toBe(1));
            await waitFor(() => expect(cacheStatusCalls).toBe(1));
            expect(queryClient.getQueryData(authStatusQueryKey)).toMatchObject({
                session: { lastSeenAtMs: timestampMs },
                state: "authenticated",
                user: { username: "operator" },
            });
            expect(queryClient.getQueryData(notificationLatestQueryKey)).toEqual({
                notifications: [],
                readCount: 0,
                unreadCount: 0,
            });
            expect(
                screen.getByRole("button", { name: "Notifications, none unread" })
            ).toBeTruthy();
            const statusButton = await screen.findByRole("button", {
                name: "System status: all systems online. Open details",
            });
            expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
            await userEvent.click(statusButton);
            expect(
                screen.getByRole("heading", { level: 2, name: "System status" })
            ).toBeTruthy();
            expect(screen.getByText("Dashboard backend")).toBeTruthy();
            expect(screen.getByText("Dashboard worker")).toBeTruthy();
            expect(screen.getByText("OpenClaw Gateway")).toBeTruthy();
            const statusValues = screen.getAllByText("Online ●");
            expect(statusValues).toHaveLength(3);
            for (const statusValue of statusValues) {
                expect(statusValue).toHaveClass("text-xs", "leading-5", "font-medium");
                expect(statusValue).not.toHaveClass("text-sm");
            }
            expect(healthStatusCalls).toBe(1);
            await act(async () => {
                healthUnavailable = true;
                await queryClient.refetchQueries({
                    queryKey: dashboardHealthDiagnosticsQueryKey,
                });
            });
            await waitFor(() =>
                expect(statusButton).toHaveAttribute(
                    "aria-label",
                    "System status: last known status is stale. Open details"
                )
            );
            expect(screen.getAllByText("Stale ○")).toHaveLength(3);
            await userEvent.click(screen.getByRole("button", { name: "Log out" }));
            expect(logoutCalls).toBe(1);
            expect(settleLogout).toBeDefined();
            await act(async () => {
                settleLogout?.({ isOk: true });
                for (let attempt = 0; attempt < 100; attempt += 1) {
                    if (router.state.location.pathname === "/login") break;
                    await new Promise<void>((resolve) => setTimeout(resolve, 0));
                }
            });
            expect(queryClient.getQueryData(authStatusQueryKey)).toEqual({
                state: "anonymous",
            });
            expect(router.state.location.pathname).toBe("/login");
            expect(
                await screen.findByRole("heading", { level: 1, name: "Sign in" })
            ).toBeTruthy();
        } finally {
            view.unmount();
            await collections.cleanup();
            queryClient.clear();
        }
    });

    test("keeps authenticated header controls mounted across route verification", async () => {
        const timestampMs = Date.now();
        const authentication: Extract<AuthStatus, { state: "authenticated" }> = {
            session: {
                authenticatedAtMs: timestampMs,
                authMethod: "password",
                createdAtMs: timestampMs,
                expiresAtMs: timestampMs + 86_400_000,
                id: "a".repeat(32),
                isCurrent: true,
                lastSeenAtMs: timestampMs,
                userAgent: "Dashboard navigation test",
            },
            state: "authenticated",
            user: {
                id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
                username: "operator",
            },
        };
        const secondAuthenticationCheck = Promise.withResolvers<AuthStatus>();
        let authenticationCalls = 0;
        let deferAuthenticationChecks = false;
        let healthStatusCalls = 0;
        let notificationCalls = 0;
        const queryClient = createDashboardQueryClient();
        const router = createDashboardRouter(
            createMemoryHistory({ initialEntries: ["/agents"] })
        );
        const trpcClient = createDashboardTrpcClient({
            mutation(path) {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            },
            query(path) {
                switch (path) {
                    case "auth.status": {
                        authenticationCalls += 1;
                        return deferAuthenticationChecks
                            ? secondAuthenticationCheck.promise
                            : Promise.resolve(authentication);
                    }
                    case "agents.getConfiguration": {
                        return Promise.resolve({ agents: [] });
                    }
                    case "agents.listStatuses": {
                        return Promise.resolve({ statuses: [] });
                    }
                    case "agents.listTaskHistory": {
                        return Promise.resolve({ runs: [] });
                    }
                    case "system.healthDiagnostics": {
                        healthStatusCalls += 1;
                        return Promise.resolve(
                            healthDiagnostics(timestampMs, { workerReady: false })
                        );
                    }
                    case "gatewaySessions.list": {
                        return Promise.resolve({
                            filter: "ALL" as const,
                            projectionTruncated: false,
                            sessions: [],
                            source: {
                                checkedAtMs: timestampMs,
                                connection: "connected" as const,
                                freshness: "fresh" as const,
                                observedAtMs: timestampMs,
                            },
                            stats: deriveGatewaySessionStats([], timestampMs),
                        });
                    }
                    case "notifications.list": {
                        notificationCalls += 1;
                        return Promise.resolve({
                            notifications: [],
                            readCount: 0,
                            unreadCount: 0,
                        });
                    }
                    default: {
                        return Promise.reject(new TypeError(`Unexpected query: ${path}`));
                    }
                }
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
            expect(
                await screen.findByRole("heading", { level: 1, name: "Agents" })
            ).toBeVisible();
            const logoutButton = screen.getByRole("button", { name: "Log out" });
            const statusButton = screen.getByRole("button", {
                name: /^System status:/u,
            });
            const notificationButton = await screen.findByRole("button", {
                name: "Notifications, none unread",
            });
            await userEvent.click(notificationButton);
            const notificationHeading = await screen.findByRole("heading", {
                level: 2,
                name: "Notifications",
            });
            const authenticationCallsBeforeNavigation = authenticationCalls;
            const healthStatusCallsBeforeNavigation = healthStatusCalls;
            const notificationCallsBeforeNavigation = notificationCalls;
            deferAuthenticationChecks = true;

            await act(async () => {
                await router.navigate({ to: "/sessions" });
            });
            await waitFor(() =>
                expect(authenticationCalls).toBeGreaterThan(
                    authenticationCallsBeforeNavigation
                )
            );

            expect(router.state.location.pathname).toBe("/sessions");
            expect(screen.getByRole("button", { name: "Log out" })).toBe(logoutButton);
            expect(screen.getByRole("button", { name: /^System status:/u })).toBe(
                statusButton
            );
            expect(
                screen.getByRole("button", { name: "Notifications, none unread" })
            ).toBe(notificationButton);
            expect(notificationButton).toBeVisible();
            expect(notificationButton).toHaveAttribute("aria-expanded", "true");
            expect(notificationHeading).toBeVisible();
            expect(healthStatusCalls).toBe(healthStatusCallsBeforeNavigation);
            expect(notificationCalls).toBe(notificationCallsBeforeNavigation);

            await act(async () => {
                secondAuthenticationCheck.resolve(authentication);
                await secondAuthenticationCheck.promise;
            });
            expect(
                await screen.findByRole("heading", { level: 1, name: "Sessions" })
            ).toBeVisible();
            expect(screen.getByRole("button", { name: "Log out" })).toBe(logoutButton);
            expect(screen.getByRole("button", { name: /^System status:/u })).toBe(
                statusButton
            );
            expect(
                screen.getByRole("button", { name: "Notifications, none unread" })
            ).toBe(notificationButton);
            expect(notificationButton).toHaveAttribute("aria-expanded", "true");
            expect(notificationHeading).toBeVisible();
            expect(healthStatusCalls).toBe(healthStatusCallsBeforeNavigation);
            expect(notificationCalls).toBe(notificationCallsBeforeNavigation);

            act(() => {
                queryClient.setQueryData(
                    dashboardHealthDiagnosticsQueryKey,
                    healthDiagnostics(timestampMs)
                );
                queryClient.setQueryData(notificationLatestQueryKey, {
                    notifications: [],
                    readCount: 4,
                    unreadCount: 2,
                });
            });
            await waitFor(() => {
                expect(statusButton).toHaveAttribute(
                    "aria-label",
                    "System status: all systems online. Open details"
                );
                expect(notificationButton).toHaveAttribute(
                    "aria-label",
                    "Notifications, 2 unread"
                );
                expect(notificationHeading.nextElementSibling).toHaveTextContent(
                    "2 unread · 4 read"
                );
            });
            expect(screen.getByRole("button", { name: "Log out" })).toBe(logoutButton);
            expect(
                screen.getByRole("button", {
                    name: "System status: all systems online. Open details",
                })
            ).toBe(statusButton);
            expect(screen.getByRole("button", { name: "Notifications, 2 unread" })).toBe(
                notificationButton
            );
        } finally {
            secondAuthenticationCheck.resolve(authentication);
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
