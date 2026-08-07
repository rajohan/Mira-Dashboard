import { describe, expect, jest, test } from "bun:test";

import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, StrictMode } from "react";

import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import { monitoringRealtimeTopics } from "../../contracts/monitoringRealtime.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import { reportQueryKey } from "../monitoring/monitoringQueries.ts";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import {
    notificationHistoryQueryKey,
    notificationLatestQueryKey,
} from "./notificationQueries.ts";
import {
    notificationRealtimeFallbackRefreshIntervalMs,
    notificationRealtimeRefreshDelayMs,
    useNotificationRealtimeInvalidation,
} from "./useNotificationRealtimeInvalidation.ts";

const { render } = await import("@testing-library/react");
const notificationId = "019fdc00-0000-7000-8000-000000000003";
const notificationCursor = {
    id: notificationId,
    occurredAtMs: 1_800_000_000_000,
} as const;
const activeHistoryKey = notificationHistoryQueryKey(notificationCursor, undefined);
const inactiveHistoryKey = notificationHistoryQueryKey(notificationCursor, {
    readState: "read",
});

function NotificationRealtimeProbe() {
    useNotificationRealtimeInvalidation();
    return null;
}

function ActiveNotificationHistoryProbe({
    onRefresh,
}: {
    readonly onRefresh: () => void;
}) {
    useQuery({
        queryFn: () => {
            onRefresh();
            return Promise.resolve({ pages: ["refreshed"] });
        },
        queryKey: activeHistoryKey,
        staleTime: Number.POSITIVE_INFINITY,
    });
    return null;
}

describe("notification realtime invalidation", () => {
    test("coalesces notification changes into notification-only invalidation", async () => {
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const reportKey = [...reportQueryKey, "test"] as const;
        let activeHistoryRefreshCount = 0;
        queryClient.setQueryData(notificationLatestQueryKey, { notifications: [] });
        queryClient.setQueryData(activeHistoryKey, { pages: ["active cached"] });
        queryClient.setQueryData(inactiveHistoryKey, { pages: ["inactive cached"] });
        queryClient.setQueryData(reportKey, { reports: [] });
        const view = render(
            <StrictMode>
                <QueryClientProvider client={queryClient}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <NotificationRealtimeProbe />
                        <ActiveNotificationHistoryProbe
                            onRefresh={() => {
                                activeHistoryRefreshCount += 1;
                            }}
                        />
                    </DashboardRealtimeProvider>
                </QueryClientProvider>
            </StrictMode>
        );

        expect(realtimeClient.input).toEqual({
            lastEventId: "0",
            topics: [monitoringRealtimeTopics.notifications],
        });
        expect(realtimeClient.activeSubscriptionCount).toBe(1);
        expect(activeHistoryRefreshCount).toBe(0);
        await act(async () => {
            const output: RealtimeStreamOutput = {
                data: {
                    event: {
                        entityId: notificationId,
                        entityType: "notification",
                        occurredAtMs: 1_800_000_000_000,
                        operation: "snapshot-required",
                        payload: { id: notificationId },
                        topic: monitoringRealtimeTopics.notifications,
                    },
                    kind: "change",
                },
                id: "18",
            };
            realtimeClient.emit(output);
            realtimeClient.emit(output);
            await new Promise((resolve) =>
                setTimeout(resolve, notificationRealtimeRefreshDelayMs + 20)
            );
        });

        expect(
            queryClient.getQueryState(notificationLatestQueryKey)?.isInvalidated
        ).toBeTrue();
        expect(activeHistoryRefreshCount).toBe(1);
        expect(queryClient.getQueryData(activeHistoryKey)).toEqual({
            pages: ["refreshed"],
        });
        expect(queryClient.getQueryState(inactiveHistoryKey)?.isInvalidated).toBeTrue();
        expect(queryClient.getQueryData(inactiveHistoryKey)).toEqual({
            pages: ["inactive cached"],
        });
        expect(queryClient.getQueryState(reportKey)?.isInvalidated).toBeFalse();
        view.unmount();
        expect(realtimeClient.activeSubscriptionCount).toBe(0);
        queryClient.clear();
    });

    test("refreshes immediately and periodically after terminal resync", async () => {
        jest.useFakeTimers();
        try {
            const queryClient = createDashboardQueryClient();
            const realtimeClient = new ControlledDashboardRealtimeClient();
            queryClient.setQueryData(notificationLatestQueryKey, {
                notifications: [],
            });
            const view = render(
                <QueryClientProvider client={queryClient}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <NotificationRealtimeProbe />
                    </DashboardRealtimeProvider>
                </QueryClientProvider>
            );

            await act(async () => {
                realtimeClient.requireResync();
                jest.advanceTimersByTime(notificationRealtimeRefreshDelayMs);
                await Promise.resolve();
            });
            expect(
                queryClient.getQueryState(notificationLatestQueryKey)?.isInvalidated
            ).toBeTrue();

            queryClient.setQueryData(notificationLatestQueryKey, {
                notifications: [],
            });
            await act(async () => {
                jest.advanceTimersByTime(
                    notificationRealtimeFallbackRefreshIntervalMs +
                        notificationRealtimeRefreshDelayMs
                );
                await Promise.resolve();
            });
            expect(
                queryClient.getQueryState(notificationLatestQueryKey)?.isInvalidated
            ).toBeTrue();

            view.unmount();
            queryClient.clear();
        } finally {
            jest.useRealTimers();
        }
    });
});
