import { describe, expect, spyOn, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import type { TRPCRequestOptions } from "@trpc/client";
import { act, type ReactNode } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import type { NotificationRecord } from "../../contracts/monitoring.ts";
import { monitoringRealtimeTopics } from "../../contracts/monitoringRealtime.ts";
import type {
    ListNotificationsInput,
    ListNotificationsResult,
} from "../../contracts/notifications.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import { createDashboardBrowserCollections } from "../data/dashboardCollections.ts";
import { DashboardCollectionsProvider } from "../data/dashboardCollectionsContext.tsx";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { AuthenticatedNotificationCenter } from "./AuthenticatedNotificationCenter.tsx";
import {
    notificationHistoryQueryKey,
    notificationLatestQueryKey,
} from "./notificationQueries.ts";
import { notificationRealtimeRefreshDelayMs } from "./useNotificationRealtimeInvalidation.ts";

const { render, screen, waitFor, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;
const ids = Object.freeze([
    "019fdd00-0000-7000-8000-000000000006",
    "019fdc00-0000-7000-8000-000000000005",
    "019fdb00-0000-7000-8000-000000000004",
    "019fda00-0000-7000-8000-000000000003",
    "019fd900-0000-7000-8000-000000000002",
    "019fd800-0000-7000-8000-000000000001",
]);

function authenticatedStatus(): AuthStatus {
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
            username: "operator",
        },
    };
}

function notification(
    id: string,
    occurredAtMs: number,
    overrides: Partial<NotificationRecord> = {}
): NotificationRecord {
    return {
        id,
        kind: "heartbeat",
        message: "A monitor changed state.",
        occurredAtMs,
        severity: "warning",
        title: `Notification ${id.at(-1)}`,
        ...overrides,
    };
}

interface TransportCall {
    readonly input: unknown;
    readonly path: string;
}

class NotificationCenterTransport implements DashboardTrpcTransport {
    readonly history = new Map<string, ListNotificationsResult>();
    readonly historyResponders = new Map<
        string,
        () => Promise<ListNotificationsResult>
    >();
    readonly mutationCalls: TransportCall[] = [];
    readonly queryCalls: TransportCall[] = [];
    latest: ListNotificationsResult;
    latestResponder: (() => Promise<ListNotificationsResult>) | undefined;
    mutationResponder: ((path: string, input: unknown) => Promise<unknown>) | undefined;

    constructor(latest: ListNotificationsResult) {
        this.latest = latest;
    }

    mutation(path: string, input?: unknown): Promise<unknown> {
        this.mutationCalls.push({ input, path });
        return (
            this.mutationResponder?.(path, input) ??
            Promise.reject(new TypeError(`Unexpected mutation: ${path}`))
        );
    }

    query(
        path: string,
        input?: unknown,
        _options?: TRPCRequestOptions
    ): Promise<unknown> {
        this.queryCalls.push({ input, path });
        if (path !== "notifications.list") {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        const cursor = (input as ListNotificationsInput | undefined)?.cursor;
        if (cursor === undefined) {
            return this.latestResponder?.() ?? Promise.resolve(this.latest);
        }
        const responder = this.historyResponders.get(cursor.id);
        if (responder !== undefined) return responder();
        const result = this.history.get(cursor.id);
        return result === undefined
            ? Promise.reject(new TypeError(`Unexpected history cursor: ${cursor.id}`))
            : Promise.resolve(result);
    }
}

interface CenterHarness {
    readonly cleanup: () => Promise<void>;
    readonly queryClient: ReturnType<typeof createDashboardQueryClient>;
    readonly realtimeClient: ControlledDashboardRealtimeClient;
}

function CenterProviders({
    children,
    collections,
    queryClient,
    realtimeClient,
    trpcClient,
}: {
    readonly children: ReactNode;
    readonly collections: ReturnType<typeof createDashboardBrowserCollections>;
    readonly queryClient: ReturnType<typeof createDashboardQueryClient>;
    readonly realtimeClient: ControlledDashboardRealtimeClient;
    readonly trpcClient: ReturnType<typeof createDashboardTrpcClient>;
}) {
    return (
        <QueryClientProvider client={queryClient}>
            <DashboardCollectionsProvider collections={collections}>
                <DashboardRealtimeProvider client={realtimeClient}>
                    <DashboardTrpcProvider client={trpcClient}>
                        {children}
                    </DashboardTrpcProvider>
                </DashboardRealtimeProvider>
            </DashboardCollectionsProvider>
        </QueryClientProvider>
    );
}

function renderCenter(
    transport: NotificationCenterTransport,
    status: AuthStatus = authenticatedStatus()
): CenterHarness {
    const queryClient = createDashboardQueryClient();
    queryClient.setDefaultOptions({
        ...queryClient.getDefaultOptions(),
        queries: {
            ...queryClient.getDefaultOptions().queries,
            retry: false,
        },
    });
    queryClient.setQueryData(authStatusQueryKey, status);
    const trpcClient = createDashboardTrpcClient(transport);
    const collections = createDashboardBrowserCollections(queryClient, trpcClient);
    const realtimeClient = new ControlledDashboardRealtimeClient();
    const view = render(
        <CenterProviders
            collections={collections}
            queryClient={queryClient}
            realtimeClient={realtimeClient}
            trpcClient={trpcClient}
        >
            <AuthenticatedNotificationCenter />
        </CenterProviders>
    );
    return {
        async cleanup() {
            view.unmount();
            await collections.cleanup();
            queryClient.clear();
        },
        queryClient,
        realtimeClient,
    };
}

async function openNotificationCenter() {
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", { name: /Notifications,/u });
    await user.click(trigger);
    await screen.findByRole("heading", { level: 2, name: "Notifications" });
    return { trigger, user };
}

describe("Notification center", () => {
    test("gates collection loading and realtime on trusted authentication state", async () => {
        const transport = new NotificationCenterTransport({
            notifications: [],
            readCount: 0,
            unreadCount: 0,
        });
        const harness = renderCenter(transport, { state: "anonymous" });

        try {
            expect(screen.queryByRole("button", { name: /Notifications,/u })).toBeNull();
            expect(transport.queryCalls).toHaveLength(0);
            expect(harness.realtimeClient.activeSubscriptionCount).toBe(0);

            act(() => {
                harness.queryClient.setQueryData(
                    authStatusQueryKey,
                    authenticatedStatus()
                );
            });
            expect(
                await screen.findByRole("button", {
                    name: "Notifications, none unread",
                })
            ).toBeTruthy();
            await waitFor(() => expect(transport.queryCalls).toHaveLength(1));
            expect(harness.realtimeClient.activeSubscriptionCount).toBe(1);

            act(() => {
                harness.queryClient.setQueryData(authStatusQueryKey, {
                    state: "anonymous",
                });
            });
            await waitFor(() => {
                expect(
                    screen.queryByRole("button", { name: /Notifications,/u })
                ).toBeNull();
                expect(harness.realtimeClient.activeSubscriptionCount).toBe(0);
            });
        } finally {
            await harness.cleanup();
        }
    });

    test("announces loading and failure while the unread count is unknown", async () => {
        const pendingLatest = Promise.withResolvers<ListNotificationsResult>();
        const transport = new NotificationCenterTransport({
            notifications: [],
            readCount: 0,
            unreadCount: 0,
        });
        transport.latestResponder = () => pendingLatest.promise;
        const consoleError = spyOn(console, "error").mockImplementation(() => {});
        const harness = renderCenter(transport);

        try {
            expect(
                await screen.findByRole("button", {
                    name: "Notifications, unread count loading",
                })
            ).toBeTruthy();
            expect(screen.queryByRole("status")).toBeNull();

            await act(async () => {
                pendingLatest.reject(new TypeError("notification query failed"));
                await Promise.resolve();
            });
            expect(
                await screen.findByRole("button", {
                    name: "Notifications, unread count unavailable",
                })
            ).toBeTruthy();
            expect(screen.queryByRole("status")).toBeNull();
            expect(consoleError).toHaveBeenCalled();
        } finally {
            pendingLatest.resolve({
                notifications: [],
                readCount: 0,
                unreadCount: 0,
            });
            await harness.cleanup();
            consoleError.mockRestore();
        }
    });

    test("publishes authoritative unread changes through one polite live region", async () => {
        const transport = new NotificationCenterTransport({
            notifications: [],
            readCount: 3,
            unreadCount: 2,
        });
        const harness = renderCenter(transport);

        try {
            const status = await screen.findByRole("status");
            expect(status).toHaveAttribute("aria-atomic", "true");
            expect(status).toHaveAttribute("aria-live", "polite");
            expect(status).toHaveTextContent("Notification status: 2 unread.");

            act(() => {
                harness.queryClient.setQueryData<ListNotificationsResult>(
                    notificationLatestQueryKey,
                    {
                        notifications: [],
                        readCount: 4,
                        unreadCount: 1,
                    }
                );
            });
            await waitFor(() =>
                expect(status).toHaveTextContent("Notification status: 1 unread.")
            );
            expect(screen.getAllByRole("status")).toHaveLength(1);
        } finally {
            await harness.cleanup();
        }
    });

    test("uses global counts, renders inert text, and follows destination priority", async () => {
        const longToken = "x".repeat(800);
        const rows = [
            notification(ids[0]!, timestampMs, {
                incidentGeneration: 2,
                incidentId: ids[4],
                linkUrl: "/custom?source=notification",
                message: "<script>unsafe()</script>",
                reportId: ids[5],
                title: "<strong>not markup</strong>",
            }),
            notification(ids[1]!, timestampMs - 1000, {
                incidentGeneration: 1,
                incidentId: ids[4],
                reportId: ids[5],
                title: "Report destination",
            }),
            notification(ids[2]!, timestampMs - 2000, {
                incidentGeneration: 3,
                incidentId: ids[4],
                title: "Incident destination",
            }),
            notification(ids[3]!, timestampMs - 3000, {
                message: longToken,
                title: "No destination",
            }),
        ];
        const transport = new NotificationCenterTransport({
            notifications: rows,
            readCount: 4,
            unreadCount: 123,
        });
        const harness = renderCenter(transport);

        try {
            const trigger = await screen.findByRole("button", {
                name: "Notifications, 123 unread",
            });
            expect(trigger.textContent).toContain("99+");
            await openNotificationCenter();

            expect(screen.getByText("123 unread · 4 read")).toBeTruthy();
            expect(screen.getByText("<strong>not markup</strong>")).toBeTruthy();
            expect(screen.getByText("<script>unsafe()</script>")).toBeTruthy();
            expect(document.querySelector("script")).toBeNull();
            expect(screen.getByText(longToken)).toHaveClass("wrap-anywhere");
            expect(
                screen
                    .getByRole("link", {
                        name: /^Open notification for <strong>not markup<\/strong>/u,
                    })
                    .getAttribute("href")
            ).toBe("/custom?source=notification");
            expect(
                screen
                    .getByRole("link", {
                        name: /^Open report for Report destination/u,
                    })
                    .getAttribute("href")
            ).toBe(`/reports?reportId=${ids[5]}`);
            expect(
                screen
                    .getByRole("link", {
                        name: /^Open incident for Incident destination/u,
                    })
                    .getAttribute("href")
            ).toBe(`/incidents?incidentId=${ids[4]}`);
            expect(
                screen.getByRole("button", { name: /^Mark No destination read/u })
            ).toBeTruthy();
            expect(
                screen.getByRole("button", {
                    name: /^Delete notification: No destination/u,
                })
            ).toBeTruthy();
            expect(screen.getAllByRole("link")).toHaveLength(3);
        } finally {
            await harness.cleanup();
        }
    });

    test("distinguishes actions for notifications with repeated titles", async () => {
        const transport = new NotificationCenterTransport({
            notifications: [
                notification(ids[0]!, timestampMs, {
                    incidentGeneration: 1,
                    incidentId: ids[4],
                    title: "Repeated incident",
                }),
                notification(ids[1]!, timestampMs, {
                    incidentGeneration: 1,
                    incidentId: ids[4],
                    title: "Repeated incident",
                }),
            ],
            readCount: 0,
            unreadCount: 2,
        });
        const harness = renderCenter(transport);

        try {
            await openNotificationCenter();
            const markLabels = screen
                .getAllByRole("button", {
                    name: /^Mark Repeated incident read/u,
                })
                .map((button) => button.getAttribute("aria-label"));
            const deleteLabels = screen
                .getAllByRole("button", {
                    name: /^Delete notification: Repeated incident/u,
                })
                .map((button) => button.getAttribute("aria-label"));

            expect(new Set(markLabels).size).toBe(2);
            expect(new Set(deleteLabels).size).toBe(2);
        } finally {
            await harness.cleanup();
        }
    });

    test("shows one deep history page at a time and resets paging when filters change", async () => {
        const newest = notification(ids[0]!, timestampMs, {
            title: "Newest warning",
        });
        const firstPageRow = notification(ids[1]!, timestampMs - 1000, {
            title: "First history page",
        });
        const secondPageRow = notification(ids[2]!, timestampMs - 2000, {
            title: "Second history page",
        });
        const terminalPageRow = notification(ids[3]!, timestampMs - 3000, {
            title: "Terminal history page",
        });
        const transport = new NotificationCenterTransport({
            nextCursor: { id: newest.id, occurredAtMs: newest.occurredAtMs },
            notifications: [newest],
            readCount: 0,
            unreadCount: 4,
        });
        transport.history.set(newest.id, {
            nextCursor: {
                id: firstPageRow.id,
                occurredAtMs: firstPageRow.occurredAtMs,
            },
            notifications: [newest, firstPageRow],
            readCount: 0,
            unreadCount: 4,
        });
        transport.history.set(firstPageRow.id, {
            nextCursor: {
                id: secondPageRow.id,
                occurredAtMs: secondPageRow.occurredAtMs,
            },
            notifications: [secondPageRow],
            readCount: 0,
            unreadCount: 4,
        });
        transport.history.set(secondPageRow.id, {
            notifications: [terminalPageRow],
            readCount: 0,
            unreadCount: 4,
        });
        const harness = renderCenter(transport);

        try {
            const { user } = await openNotificationCenter();
            expect(await screen.findByText("Newest warning")).toBeTruthy();
            expect(
                transport.queryCalls.filter(
                    ({ input }) =>
                        (input as ListNotificationsInput | undefined)?.cursor !==
                        undefined
                )
            ).toHaveLength(0);

            await user.click(
                screen.getByRole("button", { name: "Load older notifications" })
            );
            expect(await screen.findByText("First history page")).toBeTruthy();
            expect(
                screen.getAllByRole("heading", { level: 3, name: "Newest warning" })
            ).toHaveLength(1);

            await user.click(
                screen.getByRole("button", { name: "Load next older page" })
            );
            expect(await screen.findByText("Second history page")).toBeTruthy();
            expect(screen.queryByText("First history page")).toBeNull();

            await user.click(
                screen.getByRole("button", { name: "Load next older page" })
            );
            expect(await screen.findByText("Terminal history page")).toBeTruthy();
            expect(screen.queryByText("Second history page")).toBeNull();

            await user.click(
                screen.getByRole("button", {
                    name: "Filter notifications by severity",
                })
            );
            await user.click(screen.getByRole("option", { name: "Error" }));
            expect(screen.queryByText("Terminal history page")).toBeNull();
            expect(
                screen.getByRole("button", { name: "Load older notifications" })
            ).toBeTruthy();

            await user.click(
                screen.getByRole("button", { name: "Load older notifications" })
            );
            await waitFor(() =>
                expect(
                    transport.queryCalls.filter(
                        ({ input }) =>
                            (input as ListNotificationsInput | undefined)?.cursor !==
                            undefined
                    )
                ).toHaveLength(4)
            );
            expect(transport.queryCalls.at(-1)).toEqual({
                input: {
                    cursor: { id: newest.id, occurredAtMs: newest.occurredAtMs },
                    filters: { readState: "all", severities: ["error"] },
                    limit: 100,
                },
                path: "notifications.list",
            });
        } finally {
            await harness.cleanup();
        }
    });

    test("resets a stale history path when the newest continuation cursor shifts", async () => {
        const originalNewest = notification(ids[0]!, timestampMs, {
            title: "Original newest",
        });
        const originalHistory = notification(ids[1]!, timestampMs - 1000, {
            title: "Original history",
        });
        const shiftedNewest = notification(ids[4]!, timestampMs + 1000, {
            title: "Shifted newest",
        });
        const shiftedHistory = notification(ids[5]!, timestampMs - 2000, {
            title: "Shifted history",
        });
        const transport = new NotificationCenterTransport({
            nextCursor: {
                id: originalNewest.id,
                occurredAtMs: originalNewest.occurredAtMs,
            },
            notifications: [originalNewest],
            readCount: 0,
            unreadCount: 2,
        });
        transport.history.set(originalNewest.id, {
            notifications: [originalHistory],
            readCount: 0,
            unreadCount: 2,
        });
        transport.history.set(shiftedNewest.id, {
            notifications: [shiftedHistory],
            readCount: 0,
            unreadCount: 2,
        });
        const harness = renderCenter(transport);

        try {
            const { user } = await openNotificationCenter();
            const historyControl = screen.getByRole<HTMLButtonElement>("button", {
                name: "Load older notifications",
            });
            await user.click(historyControl);
            expect(await screen.findByText("Original history")).toBeTruthy();
            const backControl = screen.getByRole("button", {
                name: "Back to newest notifications",
            });
            act(() => backControl.focus());
            expect(backControl).toHaveFocus();

            transport.latest = {
                nextCursor: {
                    id: shiftedNewest.id,
                    occurredAtMs: shiftedNewest.occurredAtMs,
                },
                notifications: [shiftedNewest],
                readCount: 0,
                unreadCount: 2,
            };
            await act(async () => {
                await harness.queryClient.refetchQueries({
                    exact: true,
                    queryKey: notificationLatestQueryKey,
                });
            });

            expect(await screen.findByText("Shifted newest")).toBeTruthy();
            await waitFor(() =>
                expect(screen.queryByText("Original history")).toBeNull()
            );
            expect(screen.getByRole("button", { name: "Load older notifications" })).toBe(
                historyControl
            );
            await waitFor(() => expect(historyControl).toHaveFocus());

            await user.click(historyControl);
            expect(await screen.findByText("Shifted history")).toBeTruthy();
            expect(transport.queryCalls.at(-1)).toEqual({
                input: {
                    cursor: {
                        id: shiftedNewest.id,
                        occurredAtMs: shiftedNewest.occurredAtMs,
                    },
                    filters: { readState: "all" },
                    limit: 100,
                },
                path: "notifications.list",
            });
        } finally {
            await harness.cleanup();
        }
    });

    test("restores heading focus when realtime removes the history cursor", async () => {
        for (const focusedControl of ["forward", "back"] as const) {
            const newest = notification(ids[0]!, timestampMs, {
                title: `Newest ${focusedControl}`,
            });
            const historyRow = notification(ids[1]!, timestampMs - 1000, {
                title: `History ${focusedControl}`,
            });
            const transport = new NotificationCenterTransport({
                nextCursor: {
                    id: newest.id,
                    occurredAtMs: newest.occurredAtMs,
                },
                notifications: [newest],
                readCount: 0,
                unreadCount: 2,
            });
            transport.history.set(newest.id, {
                notifications: [historyRow],
                readCount: 0,
                unreadCount: 2,
            });
            const harness = renderCenter(transport);

            try {
                const { user } = await openNotificationCenter();
                await user.click(
                    screen.getByRole("button", {
                        name: "Load older notifications",
                    })
                );
                expect(await screen.findByText(`History ${focusedControl}`)).toBeTruthy();
                const control =
                    focusedControl === "forward"
                        ? screen.getByRole("button", {
                              name: "All available notifications loaded",
                          })
                        : screen.getByRole("button", {
                              name: "Back to newest notifications",
                          });
                act(() => control.focus());
                expect(control).toHaveFocus();

                transport.latest = {
                    notifications: [newest],
                    readCount: 0,
                    unreadCount: 1,
                };
                await act(async () => {
                    await harness.queryClient.refetchQueries({
                        exact: true,
                        queryKey: notificationLatestQueryKey,
                    });
                });

                await waitFor(() =>
                    expect(screen.queryByText(`History ${focusedControl}`)).toBeNull()
                );
                await waitFor(() =>
                    expect(
                        screen.getByRole("heading", {
                            level: 2,
                            name: "Notifications",
                        })
                    ).toHaveFocus()
                );
                expect(
                    screen.queryByRole("button", {
                        name: "Load older notifications",
                    })
                ).toBeNull();
            } finally {
                await harness.cleanup();
            }
        }
    });

    test("keeps one history control focused through forward, terminal, and back paging", async () => {
        const newest = notification(ids[0]!, timestampMs, { title: "Newest row" });
        const firstHistory = notification(ids[1]!, timestampMs - 1000, {
            title: "First history row",
        });
        const terminalHistory = notification(ids[2]!, timestampMs - 2000, {
            title: "Terminal history row",
        });
        const transport = new NotificationCenterTransport({
            nextCursor: { id: newest.id, occurredAtMs: newest.occurredAtMs },
            notifications: [newest],
            readCount: 0,
            unreadCount: 3,
        });
        transport.history.set(newest.id, {
            nextCursor: {
                id: firstHistory.id,
                occurredAtMs: firstHistory.occurredAtMs,
            },
            notifications: [firstHistory],
            readCount: 0,
            unreadCount: 3,
        });
        transport.history.set(firstHistory.id, {
            notifications: [terminalHistory],
            readCount: 0,
            unreadCount: 3,
        });
        const harness = renderCenter(transport);

        try {
            const { user } = await openNotificationCenter();
            const historyControl = screen.getByRole("button", {
                name: "Load older notifications",
            });

            await user.click(historyControl);
            expect(await screen.findByText("First history row")).toBeTruthy();
            expect(screen.getByRole("button", { name: "Load next older page" })).toBe(
                historyControl
            );

            await user.click(historyControl);
            expect(await screen.findByText("Terminal history row")).toBeTruthy();
            const terminalControl = screen.getByRole("button", {
                name: "All available notifications loaded",
            });
            expect(terminalControl).toBe(historyControl);
            expect(terminalControl).toHaveAttribute("aria-disabled", "true");
            expect(terminalControl).toHaveFocus();

            await user.click(screen.getByRole("button", { name: "Load newer page" }));
            expect(await screen.findByText("First history row")).toBeTruthy();
            await waitFor(() => expect(historyControl).toHaveFocus());

            await user.click(
                screen.getByRole("button", { name: "Back to newest notifications" })
            );
            await waitFor(() =>
                expect(screen.queryByText("First history row")).toBeNull()
            );
            expect(screen.getByRole("button", { name: "Load older notifications" })).toBe(
                historyControl
            );
            await waitFor(() => expect(historyControl).toHaveFocus());
        } finally {
            await harness.cleanup();
        }
    });

    test("keeps history focus during delayed forward and cache-miss back requests", async () => {
        const newest = notification(ids[0]!, timestampMs, { title: "Newest row" });
        const firstHistory = notification(ids[1]!, timestampMs - 1000, {
            title: "Delayed first history row",
        });
        const terminalHistory = notification(ids[2]!, timestampMs - 2000, {
            title: "Delayed terminal history row",
        });
        const firstCursor = {
            id: newest.id,
            occurredAtMs: newest.occurredAtMs,
        };
        const firstPage = {
            nextCursor: {
                id: firstHistory.id,
                occurredAtMs: firstHistory.occurredAtMs,
            },
            notifications: [firstHistory],
            readCount: 0,
            unreadCount: 3,
        } satisfies ListNotificationsResult;
        const firstLoad = Promise.withResolvers<ListNotificationsResult>();
        const backLoad = Promise.withResolvers<ListNotificationsResult>();
        let firstPageRequests = 0;
        const transport = new NotificationCenterTransport({
            nextCursor: firstCursor,
            notifications: [newest],
            readCount: 0,
            unreadCount: 3,
        });
        transport.historyResponders.set(newest.id, () => {
            firstPageRequests += 1;
            return firstPageRequests === 1 ? firstLoad.promise : backLoad.promise;
        });
        transport.history.set(firstHistory.id, {
            notifications: [terminalHistory],
            readCount: 0,
            unreadCount: 3,
        });
        const harness = renderCenter(transport);

        try {
            const { user } = await openNotificationCenter();
            const historyControl = screen.getByRole<HTMLButtonElement>("button", {
                name: "Load older notifications",
            });
            await user.click(historyControl);
            await waitFor(() => expect(firstPageRequests).toBe(1));
            const pendingForward = await screen.findByRole<HTMLButtonElement>("button", {
                name: "Loading older notifications…",
            });
            expect(pendingForward).toBe(historyControl);
            expect(pendingForward).toHaveFocus();
            expect(pendingForward.getAttribute("aria-busy")).toBe("true");
            expect(pendingForward.disabled).toBeFalse();

            firstLoad.resolve(firstPage);
            expect(await screen.findByText("Delayed first history row")).toBeTruthy();
            expect(historyControl).toHaveFocus();
            await user.click(historyControl);
            expect(await screen.findByText("Delayed terminal history row")).toBeTruthy();

            harness.queryClient.removeQueries({
                exact: true,
                queryKey: notificationHistoryQueryKey(firstCursor, {
                    readState: "all",
                }),
            });
            await user.click(screen.getByRole("button", { name: "Load newer page" }));
            await waitFor(() => expect(firstPageRequests).toBe(2));
            const pendingBack = await screen.findByRole<HTMLButtonElement>("button", {
                name: "Loading older notifications…",
            });
            expect(pendingBack).toBe(historyControl);
            expect(pendingBack).toHaveFocus();
            expect(pendingBack.getAttribute("aria-busy")).toBe("true");
            expect(pendingBack.disabled).toBeFalse();

            backLoad.resolve(firstPage);
            expect(await screen.findByText("Delayed first history row")).toBeTruthy();
            expect(historyControl).toHaveFocus();
        } finally {
            firstLoad.resolve(firstPage);
            backLoad.resolve(firstPage);
            await harness.cleanup();
        }
    });

    test("marks one notification read and removes another before refresh", async () => {
        const first = notification(ids[0]!, timestampMs, { title: "Mark me" });
        const second = notification(ids[1]!, timestampMs - 1000, {
            title: "Delete me",
        });
        const transport = new NotificationCenterTransport({
            notifications: [first, second],
            readCount: 0,
            unreadCount: 2,
        });
        transport.mutationResponder = (path, _input) => {
            if (path === "notifications.markRead") {
                const marked = { ...first, readAtMs: timestampMs + 1000 };
                transport.latest = {
                    notifications: [marked, second],
                    readCount: 1,
                    unreadCount: 1,
                };
                return Promise.resolve(marked);
            }
            if (path === "notifications.delete") {
                transport.latest = {
                    notifications: [{ ...first, readAtMs: timestampMs + 1000 }],
                    readCount: 1,
                    unreadCount: 0,
                };
                return Promise.resolve({
                    deletedAtMs: timestampMs + 2000,
                    id: second.id,
                });
            }
            return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
        };
        const harness = renderCenter(transport);

        try {
            const { user } = await openNotificationCenter();
            const firstTitle = await screen.findByText("Mark me");
            const firstArticle = firstTitle.closest("article");
            expect(firstArticle).not.toBeNull();
            await user.click(
                within(firstArticle!).getByRole("button", {
                    name: /^Mark Mark me read/u,
                })
            );
            await screen.findByRole("button", { name: "Notifications, 1 unread" });
            expect(
                within(firstArticle!).queryByRole("button", {
                    name: /^Mark Mark me read/u,
                })
            ).toBeNull();
            await waitFor(() =>
                expect(
                    screen.getByRole("button", {
                        name: /^Delete notification: Mark me/u,
                    })
                ).toHaveFocus()
            );

            const secondArticle = screen.getByText("Delete me").closest("article");
            expect(secondArticle).not.toBeNull();
            await user.click(
                within(secondArticle!).getByRole("button", {
                    name: /^Delete notification: Delete me/u,
                })
            );
            await waitFor(() => expect(screen.queryByText("Delete me")).toBeNull());
            await waitFor(() => expect(firstArticle).toHaveFocus());
            expect(transport.mutationCalls).toEqual([
                { input: { id: first.id }, path: "notifications.markRead" },
                { input: { id: second.id }, path: "notifications.delete" },
            ]);
        } finally {
            await harness.cleanup();
        }
    });

    test("restores exact action focus after a failed mutation", async () => {
        const row = notification(ids[0]!, timestampMs, {
            title: "Failed exact action",
        });
        const transport = new NotificationCenterTransport({
            notifications: [row],
            readCount: 0,
            unreadCount: 1,
        });
        transport.mutationResponder = () =>
            Promise.reject(new TypeError("Synthetic unavailable mutation"));
        const harness = renderCenter(transport);

        try {
            const { user } = await openNotificationCenter();
            const markButton = screen.getByRole("button", {
                name: /^Mark Failed exact action read/u,
            });
            await user.click(markButton);
            await waitFor(() => expect(markButton).toHaveFocus());

            const deleteButton = screen.getByRole("button", {
                name: /^Delete notification: Failed exact action/u,
            });
            await user.click(deleteButton);
            await waitFor(() => expect(deleteButton).toHaveFocus());
            expect(screen.queryByText("Failed exact action")).toBeTruthy();
        } finally {
            await harness.cleanup();
        }
    });

    test("removes stale exact rows after not-found even when refresh fails", async () => {
        const markTarget = notification(ids[0]!, timestampMs, {
            title: "Missing mark target",
        });
        const deleteTarget = notification(ids[1]!, timestampMs - 1000, {
            title: "Missing delete target",
        });
        const transport = new NotificationCenterTransport({
            notifications: [markTarget, deleteTarget],
            readCount: 0,
            unreadCount: 2,
        });
        const notFound = Object.assign(new Error("Synthetic not found"), {
            data: { code: "NOT_FOUND" as const },
        });
        transport.mutationResponder = () => {
            transport.latestResponder = () =>
                Promise.reject(new TypeError("Refresh unavailable"));
            return Promise.reject(notFound);
        };
        const consoleError = spyOn(console, "error").mockImplementation(() => {});
        const harness = renderCenter(transport);

        try {
            const { user } = await openNotificationCenter();
            await user.click(
                screen.getByRole("button", {
                    name: /^Mark Missing mark target read/u,
                })
            );
            await waitFor(() =>
                expect(screen.queryByText("Missing mark target")).toBeNull()
            );
            expect(
                await screen.findByText("This notification no longer exists.")
            ).toBeTruthy();
            await screen.findByRole("button", { name: "Notifications, 1 unread" });

            await user.click(
                screen.getByRole("button", {
                    name: /^Delete notification: Missing delete target/u,
                })
            );
            await waitFor(() =>
                expect(screen.queryByText("Missing delete target")).toBeNull()
            );
            await screen.findByRole("button", { name: "Notifications, none unread" });
            expect(transport.mutationCalls.map(({ path }) => path)).toEqual([
                "notifications.markRead",
                "notifications.delete",
            ]);
            expect(consoleError).toHaveBeenCalled();
        } finally {
            await harness.cleanup();
            consoleError.mockRestore();
        }
    });

    test("recovers heading focus when marking the last filtered unread row", async () => {
        const target = notification(ids[0]!, timestampMs, {
            title: "Only unread row",
        });
        const alreadyRead = notification(ids[1]!, timestampMs - 1000, {
            readAtMs: timestampMs,
            title: "Already read row",
        });
        const transport = new NotificationCenterTransport({
            notifications: [target, alreadyRead],
            readCount: 1,
            unreadCount: 1,
        });
        transport.mutationResponder = (path) => {
            if (path !== "notifications.markRead") {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            }
            const marked = { ...target, readAtMs: timestampMs + 1000 };
            transport.latest = {
                notifications: [marked, alreadyRead],
                readCount: 2,
                unreadCount: 0,
            };
            return Promise.resolve(marked);
        };
        const harness = renderCenter(transport);

        try {
            const { user } = await openNotificationCenter();
            const heading = screen.getByRole("heading", {
                level: 2,
                name: "Notifications",
            });
            await user.click(
                screen.getByRole("button", {
                    name: "Filter notifications by read state",
                })
            );
            await user.click(screen.getByRole("option", { name: "Unread" }));
            expect(screen.queryByText("Already read row")).toBeNull();

            await user.click(
                screen.getByRole("button", { name: /^Mark Only unread row read/u })
            );
            expect(
                await screen.findByRole("heading", {
                    level: 2,
                    name: "No matching notifications",
                })
            ).toBeTruthy();
            await waitFor(() => expect(heading).toHaveFocus());
        } finally {
            await harness.cleanup();
        }
    });

    test("recovers heading focus when deleting the last severity-filtered row", async () => {
        const target = notification(ids[0]!, timestampMs, {
            title: "Only warning row",
        });
        const hidden = notification(ids[1]!, timestampMs - 1000, {
            severity: "info",
            title: "Hidden info row",
        });
        const transport = new NotificationCenterTransport({
            notifications: [target, hidden],
            readCount: 0,
            unreadCount: 2,
        });
        transport.mutationResponder = (path) => {
            if (path !== "notifications.delete") {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            }
            transport.latest = {
                notifications: [hidden],
                readCount: 0,
                unreadCount: 1,
            };
            return Promise.resolve({
                deletedAtMs: timestampMs + 1000,
                id: target.id,
            });
        };
        const harness = renderCenter(transport);

        try {
            const { user } = await openNotificationCenter();
            const heading = screen.getByRole("heading", {
                level: 2,
                name: "Notifications",
            });
            await user.click(
                screen.getByRole("button", {
                    name: "Filter notifications by severity",
                })
            );
            await user.click(screen.getByRole("option", { name: "Warning" }));
            expect(screen.queryByText("Hidden info row")).toBeNull();

            await user.click(
                screen.getByRole("button", {
                    name: /^Delete notification: Only warning row/u,
                })
            );
            expect(
                await screen.findByRole("heading", {
                    level: 2,
                    name: "No matching notifications",
                })
            ).toBeTruthy();
            await waitFor(() => expect(heading).toHaveFocus());
        } finally {
            await harness.cleanup();
        }
    });

    test("moves focus to the panel heading after a successful bulk action", async () => {
        const row = notification(ids[0]!, timestampMs, {
            title: "Bulk mark row",
        });
        const transport = new NotificationCenterTransport({
            notifications: [row],
            readCount: 0,
            unreadCount: 1,
        });
        transport.mutationResponder = (path) => {
            if (path !== "notifications.markAllRead") {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            }
            transport.latest = {
                notifications: [{ ...row, readAtMs: timestampMs + 1000 }],
                readCount: 1,
                unreadCount: 0,
            };
            return Promise.resolve({
                affectedCount: 1,
                completedAtMs: timestampMs + 1000,
                remaining: false,
            });
        };
        const harness = renderCenter(transport);

        try {
            const { user } = await openNotificationCenter();
            const heading = screen.getByRole("heading", {
                level: 2,
                name: "Notifications",
            });
            await user.click(screen.getByRole("button", { name: "Mark all read" }));

            expect(await screen.findByText("Marked 1 notifications read.")).toBeTruthy();
            await waitFor(() => expect(heading).toHaveFocus());
            expect(
                screen.getByRole("button", { name: "Notifications, none unread" })
            ).toHaveAttribute("aria-expanded", "true");
        } finally {
            await harness.cleanup();
        }
    });

    test("finishes and refreshes a committed bulk action after the panel closes", async () => {
        const row = notification(ids[0]!, timestampMs, {
            title: "Closing bulk row",
        });
        const secondBatch = Promise.withResolvers<unknown>();
        const transport = new NotificationCenterTransport({
            notifications: [row],
            readCount: 0,
            unreadCount: 150,
        });
        transport.mutationResponder = (path) => {
            if (path !== "notifications.markAllRead") {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            }
            return transport.mutationCalls.length === 1
                ? Promise.resolve({
                      affectedCount: 100,
                      completedAtMs: timestampMs + 1000,
                      remaining: true,
                  })
                : secondBatch.promise;
        };
        const harness = renderCenter(transport);

        try {
            const { trigger, user } = await openNotificationCenter();
            await user.click(screen.getByRole("button", { name: "Mark all read" }));
            await waitFor(() => expect(transport.mutationCalls).toHaveLength(2));
            await user.click(trigger);
            await waitFor(() =>
                expect(trigger.getAttribute("aria-expanded")).toBe("false")
            );
            await user.click(trigger);
            expect(
                screen.getByRole<HTMLButtonElement>("button", {
                    name: "Mark all read",
                }).disabled
            ).toBeTrue();
            await user.click(trigger);

            transport.latest = {
                notifications: [{ ...row, readAtMs: timestampMs + 2000 }],
                readCount: 150,
                unreadCount: 0,
            };
            secondBatch.resolve({
                affectedCount: 50,
                completedAtMs: timestampMs + 2000,
                remaining: false,
            });

            await screen.findByRole("button", {
                name: "Notifications, none unread",
            });
            expect(transport.mutationCalls).toHaveLength(2);
        } finally {
            secondBatch.resolve({
                affectedCount: 0,
                completedAtMs: timestampMs + 2000,
                remaining: false,
            });
            await harness.cleanup();
        }
    });

    test("confirms clear-read and reports a safe partial bulk failure", async () => {
        const row = notification(ids[0]!, timestampMs, {
            readAtMs: timestampMs + 1000,
            title: "Read warning",
        });
        const transport = new NotificationCenterTransport({
            notifications: [row],
            readCount: 150,
            unreadCount: 0,
        });
        const secondBatch = Promise.withResolvers<unknown>();
        let clearCalls = 0;
        transport.mutationResponder = (path) => {
            if (path !== "notifications.clearRead") {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            }
            clearCalls += 1;
            return clearCalls === 1
                ? Promise.resolve({
                      affectedCount: 100,
                      completedAtMs: timestampMs + 2000,
                      remaining: true,
                  })
                : secondBatch.promise;
        };
        const harness = renderCenter(transport);

        try {
            const { trigger, user } = await openNotificationCenter();
            await user.click(
                screen.getByRole("button", {
                    name: "Filter notifications by severity",
                })
            );
            await user.click(screen.getByRole("option", { name: "Warning" }));
            await user.click(screen.getByRole("button", { name: "Clear read" }));
            const confirmation = screen.getByRole("dialog", {
                name: "Clear read notifications?",
            });
            expect(confirmation).toBeTruthy();
            expect(transport.mutationCalls).toHaveLength(0);

            await user.click(
                within(confirmation).getByRole("button", { name: "Clear read" })
            );
            await waitFor(() => expect(transport.mutationCalls).toHaveLength(2));
            expect(screen.getByRole("button", { name: "Clear read…" })).toBeDisabled();
            await act(async () => {
                secondBatch.reject(new Error("TOP SECRET transport failure"));
                await Promise.resolve();
            });
            const partialFailureCopy =
                "The bulk action may have completed partially. A refresh was requested; confirm the current state before retrying.";
            await waitFor(() =>
                expect(within(confirmation).getByText(partialFailureCopy)).toBeTruthy()
            );
            expect(
                screen.getByRole("dialog", { name: "Clear read notifications?" })
            ).toBe(confirmation);
            await waitFor(() =>
                expect(
                    within(confirmation).getByRole("button", {
                        name: "Clear read",
                    })
                ).toHaveFocus()
            );
            expect(trigger).toHaveAttribute("aria-expanded", "true");
            expect(screen.queryByText(/TOP SECRET/u)).toBeNull();
            expect(transport.mutationCalls).toEqual([
                {
                    input: { filters: { severities: ["warning"] } },
                    path: "notifications.clearRead",
                },
                {
                    input: { filters: { severities: ["warning"] } },
                    path: "notifications.clearRead",
                },
            ]);
            expect(
                transport.queryCalls.filter(
                    ({ input }) =>
                        input !== undefined && Object.hasOwn(input as object, "limit")
                ).length
            ).toBeGreaterThan(1);
        } finally {
            secondBatch.resolve({
                affectedCount: 0,
                completedAtMs: timestampMs + 3000,
                remaining: false,
            });
            await harness.cleanup();
        }
    });

    test("refreshes visible rows and the global badge after realtime change", async () => {
        const first = notification(ids[0]!, timestampMs, { title: "Existing row" });
        const added = notification(ids[1]!, timestampMs - 1000, {
            title: "Realtime row",
        });
        const transport = new NotificationCenterTransport({
            notifications: [first],
            readCount: 0,
            unreadCount: 1,
        });
        const harness = renderCenter(transport);

        try {
            await openNotificationCenter();
            await screen.findByText("Existing row");
            transport.latest = {
                notifications: [first, added],
                readCount: 0,
                unreadCount: 2,
            };
            await act(async () => {
                const output: RealtimeStreamOutput = {
                    data: {
                        event: {
                            entityId: added.id,
                            entityType: "notification",
                            occurredAtMs: timestampMs,
                            operation: "created",
                            payload: { id: added.id },
                            topic: monitoringRealtimeTopics.notifications,
                        },
                        kind: "change",
                    },
                    id: "24",
                };
                harness.realtimeClient.emit(output);
                await new Promise((resolve) =>
                    setTimeout(resolve, notificationRealtimeRefreshDelayMs + 20)
                );
            });

            expect(
                await screen.findByRole("button", { name: "Notifications, 2 unread" })
            ).toBeTruthy();
            expect(await screen.findByText("Realtime row")).toBeTruthy();
        } finally {
            await harness.cleanup();
        }
    });
});
