import { describe, expect, jest, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";

import { createDashboardQueryClient } from "./api/queryClient.ts";
import { createDashboardTrpcClient } from "./api/trpcClient.ts";
import { DashboardBrowserApplication } from "./application.tsx";
import { authStatusQueryKey } from "./auth/authQueries.ts";
import { createDashboardBrowserCollections } from "./data/dashboardCollections.ts";
import { notificationLatestQueryKey } from "./notifications/notificationQueries.ts";
import { createDashboardRouter } from "./router.tsx";
import type { DashboardWebAuthnClient } from "./security/webauthn/webauthnClient.ts";
import { noOpDashboardRealtimeClient } from "./test/realtime.ts";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;
const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});

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
        const readinessFetch = jest
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(Response.json({ status: "ready" }));
        const trpcClient = createDashboardTrpcClient({
            mutation(path, input) {
                expect(input).toEqual({});
                if (path === "auth.touch") {
                    touchCalls += 1;
                    return Promise.resolve({ lastSeenAtMs: timestampMs });
                }
                if (path === "auth.logout") {
                    logoutCalls += 1;
                    return Promise.resolve({ isOk: true });
                }
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            },
            query(path, input) {
                if (path === "gateway.connection.get") {
                    expect(input).toEqual({});
                    return Promise.resolve({
                        checkedAtMs: timestampMs,
                        connectedAtMs: timestampMs - 1000,
                        connectionGeneration: 1,
                        freshness: "fresh",
                        lastActivityAtMs: timestampMs,
                        phase: "connected",
                        reconnectAttempt: 0,
                    });
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
                name: "System status: one or more systems need attention. Open details",
            });
            expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
            await userEvent.click(statusButton);
            expect(
                screen.getByRole("heading", { level: 2, name: "System status" })
            ).toBeTruthy();
            expect(screen.getByText("Dashboard backend")).toBeTruthy();
            expect(screen.getByText("Dashboard worker")).toBeTruthy();
            expect(screen.getByText("OpenClaw Gateway")).toBeTruthy();
            const statusValues = [
                ...screen.getAllByText("Online ●"),
                screen.getByText("Needs attention ○"),
            ];
            expect(statusValues).toHaveLength(3);
            for (const statusValue of statusValues) {
                expect(statusValue).toHaveClass("text-xs", "leading-5", "font-medium");
                expect(statusValue).not.toHaveClass("text-sm");
            }
            expect(readinessFetch).toHaveBeenCalledWith(
                "/api/health/ready",
                expect.objectContaining({
                    cache: "no-store",
                    credentials: "same-origin",
                })
            );
            await userEvent.click(screen.getByRole("button", { name: "Log out" }));
            await waitFor(() => expect(logoutCalls).toBe(1));
            await waitFor(() =>
                expect(queryClient.getQueryData(authStatusQueryKey)).toEqual({
                    state: "anonymous",
                })
            );
            await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
            expect(
                await screen.findByRole("heading", { level: 1, name: "Sign in" })
            ).toBeTruthy();
        } finally {
            view.unmount();
            await collections.cleanup();
            queryClient.clear();
            readinessFetch.mockRestore();
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
