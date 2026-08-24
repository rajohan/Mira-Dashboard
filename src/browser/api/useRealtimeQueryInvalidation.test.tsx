import { describe, expect, jest, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import { monitoringRealtimeTopics } from "../../contracts/monitoringRealtime.ts";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { createDashboardQueryClient } from "./queryClient.ts";
import { DashboardRealtimeProvider } from "./realtimeContext.tsx";
import { useRealtimeQueryInvalidation } from "./useRealtimeQueryInvalidation.ts";

const { render } = await import("@testing-library/react");
const refreshDelayMs = 100;
const notificationId = "019fdc00-0000-7000-8000-000000000003";

function notificationChange(): RealtimeStreamOutput {
    return {
        data: {
            event: {
                entityId: notificationId,
                entityType: "notification",
                occurredAtMs: 1_800_000_000_000,
                operation: "created",
                payload: { id: notificationId },
                topic: monitoringRealtimeTopics.notifications,
            },
            kind: "change",
        },
        id: "18",
    };
}

describe("realtime query invalidation", () => {
    test("serializes refreshes and runs one trailing refresh for events received in flight", async () => {
        jest.useFakeTimers();
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const firstRefresh = Promise.withResolvers<void>();
        let activeRefreshCount = 0;
        let maximumActiveRefreshCount = 0;
        let refreshCount = 0;
        const refreshQueries = async () => {
            refreshCount += 1;
            activeRefreshCount += 1;
            maximumActiveRefreshCount = Math.max(
                maximumActiveRefreshCount,
                activeRefreshCount
            );
            try {
                if (refreshCount === 1) await firstRefresh.promise;
            } finally {
                activeRefreshCount -= 1;
            }
        };

        function Probe() {
            useRealtimeQueryInvalidation({
                fallbackRefreshIntervalMs: 30_000,
                refreshDelayMs,
                refreshQueries,
                topic: monitoringRealtimeTopics.notifications,
            });
            return null;
        }

        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardRealtimeProvider client={realtimeClient}>
                    <Probe />
                </DashboardRealtimeProvider>
            </QueryClientProvider>
        );

        try {
            await act(async () => {
                realtimeClient.emit(notificationChange());
                jest.advanceTimersByTime(refreshDelayMs);
                await Promise.resolve();
            });
            expect(refreshCount).toBe(1);
            expect(activeRefreshCount).toBe(1);

            await act(async () => {
                realtimeClient.emit(notificationChange());
                realtimeClient.emit(notificationChange());
                jest.advanceTimersByTime(refreshDelayMs * 2);
                await Promise.resolve();
            });
            expect(refreshCount).toBe(1);
            expect(maximumActiveRefreshCount).toBe(1);

            await act(async () => {
                firstRefresh.resolve();
                await firstRefresh.promise;
                await Promise.resolve();
                jest.advanceTimersByTime(refreshDelayMs);
                await Promise.resolve();
            });
            expect(refreshCount).toBe(2);
            expect(maximumActiveRefreshCount).toBe(1);
        } finally {
            firstRefresh.resolve();
            view.unmount();
            queryClient.clear();
            jest.useRealTimers();
        }
    });
});
