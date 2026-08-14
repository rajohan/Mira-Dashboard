import { describe, expect, jest, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode } from "react";

import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import { taskRealtimeTopic } from "../../contracts/taskRealtime.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { taskDetailQueryKey } from "./taskQueries.ts";
import {
    taskRealtimeFallbackRefreshIntervalMs,
    taskRealtimeRefreshDelayMs,
    useTaskRealtimeInvalidation,
} from "./useTaskRealtimeInvalidation.ts";

const { render } = await import("@testing-library/react");
const taskId = "019fd984-63e8-7404-a7da-80c6f243794f";

function TaskRealtimeProbe() {
    useTaskRealtimeInvalidation();
    return null;
}

describe("task realtime invalidation", () => {
    test("coalesces validated task changes and disposes the stream", async () => {
        jest.useFakeTimers();
        try {
            const queryClient = createDashboardQueryClient();
            const realtimeClient = new ControlledDashboardRealtimeClient();
            const queryKey = taskDetailQueryKey(taskId);
            queryClient.setQueryData(queryKey, { id: taskId });
            const view = render(
                <StrictMode>
                    <QueryClientProvider client={queryClient}>
                        <DashboardRealtimeProvider client={realtimeClient}>
                            <TaskRealtimeProbe />
                        </DashboardRealtimeProvider>
                    </QueryClientProvider>
                </StrictMode>
            );

            expect(realtimeClient.input).toEqual({
                lastEventId: "0",
                topics: [taskRealtimeTopic],
            });
            expect(realtimeClient.activeSubscriptionCount).toBe(1);
            await act(async () => {
                const output: RealtimeStreamOutput = {
                    data: {
                        event: {
                            entityId: taskId,
                            entityType: "task",
                            occurredAtMs: 1_800_000_000_000,
                            operation: "updated",
                            payload: { id: taskId },
                            topic: taskRealtimeTopic,
                        },
                        kind: "change",
                    },
                    id: "18",
                };
                realtimeClient.emit(output);
                realtimeClient.emit(output);
                jest.advanceTimersByTime(taskRealtimeRefreshDelayMs);
                await Promise.resolve();
            });
            expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBeTrue();

            view.unmount();
            expect(realtimeClient.activeSubscriptionCount).toBe(0);
            expect(realtimeClient.unsubscribeCount).toBeGreaterThanOrEqual(1);
            queryClient.clear();
        } finally {
            jest.useRealTimers();
        }
    });

    test("falls back to slow polling after a terminal stream failure", async () => {
        jest.useFakeTimers();
        try {
            const queryClient = createDashboardQueryClient();
            const realtimeClient = new ControlledDashboardRealtimeClient();
            const queryKey = taskDetailQueryKey(taskId);
            queryClient.setQueryData(queryKey, { id: taskId });
            const view = render(
                <QueryClientProvider client={queryClient}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <TaskRealtimeProbe />
                    </DashboardRealtimeProvider>
                </QueryClientProvider>
            );

            await act(async () => {
                realtimeClient.fail();
                jest.advanceTimersByTime(taskRealtimeRefreshDelayMs);
                await Promise.resolve();
            });
            expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBeTrue();

            queryClient.setQueryData(queryKey, { id: taskId });
            expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBeFalse();
            await act(async () => {
                jest.advanceTimersByTime(
                    taskRealtimeFallbackRefreshIntervalMs + taskRealtimeRefreshDelayMs
                );
                await Promise.resolve();
            });
            expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBeTrue();

            view.unmount();
            queryClient.setQueryData(queryKey, { id: taskId });
            jest.advanceTimersByTime(
                taskRealtimeFallbackRefreshIntervalMs + taskRealtimeRefreshDelayMs
            );
            expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBeFalse();
            expect(realtimeClient.activeSubscriptionCount).toBe(0);
            queryClient.clear();
        } finally {
            jest.useRealTimers();
        }
    });

    test("falls back to slow polling after a terminal resync delivery", async () => {
        jest.useFakeTimers();
        try {
            const queryClient = createDashboardQueryClient();
            const realtimeClient = new ControlledDashboardRealtimeClient();
            const queryKey = taskDetailQueryKey(taskId);
            queryClient.setQueryData(queryKey, { id: taskId });
            const view = render(
                <QueryClientProvider client={queryClient}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <TaskRealtimeProbe />
                    </DashboardRealtimeProvider>
                </QueryClientProvider>
            );

            await act(async () => {
                realtimeClient.requireResync();
                jest.advanceTimersByTime(taskRealtimeRefreshDelayMs);
                await Promise.resolve();
            });
            expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBeTrue();

            queryClient.setQueryData(queryKey, { id: taskId });
            await act(async () => {
                jest.advanceTimersByTime(
                    taskRealtimeFallbackRefreshIntervalMs + taskRealtimeRefreshDelayMs
                );
                await Promise.resolve();
            });
            expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBeTrue();

            view.unmount();
            queryClient.clear();
        } finally {
            jest.useRealTimers();
        }
    });

    test("contains a rejected cache refresh inside the invalidation boundary", async () => {
        jest.useFakeTimers();
        try {
            const queryClient = createDashboardQueryClient();
            const realtimeClient = new ControlledDashboardRealtimeClient();
            let refreshCount = 0;
            Reflect.set(queryClient, "invalidateQueries", () => {
                refreshCount += 1;
                return Promise.reject(new TypeError("cache refresh failed"));
            });
            const view = render(
                <QueryClientProvider client={queryClient}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <TaskRealtimeProbe />
                    </DashboardRealtimeProvider>
                </QueryClientProvider>
            );

            await act(async () => {
                realtimeClient.requireResync();
                jest.advanceTimersByTime(taskRealtimeRefreshDelayMs);
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(refreshCount).toBe(1);

            view.unmount();
            queryClient.clear();
        } finally {
            jest.useRealTimers();
        }
    });
});
