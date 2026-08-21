import { describe, expect, jest, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode } from "react";

import { cacheRealtimeTopic } from "../../contracts/cacheRealtime.ts";
import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { cacheEntryQueryKey, cacheStatusQueryKey } from "./cacheQueries.ts";
import {
    cacheRealtimeFallbackRefreshIntervalMs,
    cacheRealtimeRefreshDelayMs,
    useCacheRealtimeInvalidation,
} from "./useCacheRealtimeInvalidation.ts";

const { render } = await import("@testing-library/react");
const systemHostKey = "system.host";
const systemMetricsKey = "system.metrics";
const unrelatedKey = ["monitoring", "reports", "detail", "report-1"] as const;

function CacheRealtimeProbe() {
    useCacheRealtimeInvalidation();
    return null;
}

function cacheChange(key: string, entityId = key, id = "41"): RealtimeStreamOutput {
    return {
        data: {
            event: {
                entityId,
                entityType: "cache-entry",
                occurredAtMs: 1_800_000_000_000,
                operation: "updated",
                payload: { key },
                topic: cacheRealtimeTopic,
            },
            kind: "change",
        },
        id,
    };
}

describe("cache realtime invalidation", () => {
    test("coalesces matching events into status and exact-entry invalidation", async () => {
        jest.useFakeTimers();
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const hostKey = cacheEntryQueryKey(systemHostKey);
        const metricsKey = cacheEntryQueryKey(systemMetricsKey);
        queryClient.setQueryData(cacheStatusQueryKey, { entries: [] });
        queryClient.setQueryData(hostKey, { key: systemHostKey });
        queryClient.setQueryData(metricsKey, { key: systemMetricsKey });
        queryClient.setQueryData(unrelatedKey, { id: "report-1" });
        const view = render(
            <StrictMode>
                <QueryClientProvider client={queryClient}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <CacheRealtimeProbe />
                    </DashboardRealtimeProvider>
                </QueryClientProvider>
            </StrictMode>
        );

        try {
            expect(realtimeClient.input).toEqual({
                topics: [cacheRealtimeTopic],
            });
            expect(realtimeClient.activeSubscriptionCount).toBe(1);

            act(() => {
                realtimeClient.emit(cacheChange(systemHostKey));
                realtimeClient.emit(cacheChange(systemHostKey, systemHostKey, "42"));
            });
            expect(
                queryClient.getQueryState(cacheStatusQueryKey)?.isInvalidated
            ).toBeFalse();
            const unsubscribeCountBeforeRerender = realtimeClient.unsubscribeCount;
            view.rerender(
                <StrictMode>
                    <QueryClientProvider client={queryClient}>
                        <DashboardRealtimeProvider client={realtimeClient}>
                            <CacheRealtimeProbe />
                        </DashboardRealtimeProvider>
                    </QueryClientProvider>
                </StrictMode>
            );
            expect(realtimeClient.unsubscribeCount).toBe(unsubscribeCountBeforeRerender);

            await act(async () => {
                jest.advanceTimersByTime(cacheRealtimeRefreshDelayMs);
                await Promise.resolve();
            });

            expect(
                queryClient.getQueryState(cacheStatusQueryKey)?.isInvalidated
            ).toBeTrue();
            expect(queryClient.getQueryState(hostKey)?.isInvalidated).toBeTrue();
            expect(queryClient.getQueryState(metricsKey)?.isInvalidated).toBeFalse();
            expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBeFalse();
        } finally {
            view.unmount();
            expect(realtimeClient.activeSubscriptionCount).toBe(0);
            queryClient.clear();
            jest.useRealTimers();
        }
    });

    test("does not use an inconsistent envelope identity for exact invalidation", async () => {
        jest.useFakeTimers();
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const hostKey = cacheEntryQueryKey(systemHostKey);
        const metricsKey = cacheEntryQueryKey(systemMetricsKey);
        queryClient.setQueryData(cacheStatusQueryKey, { entries: [] });
        queryClient.setQueryData(hostKey, { key: systemHostKey });
        queryClient.setQueryData(metricsKey, { key: systemMetricsKey });
        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardRealtimeProvider client={realtimeClient}>
                    <CacheRealtimeProbe />
                </DashboardRealtimeProvider>
            </QueryClientProvider>
        );

        try {
            await act(async () => {
                realtimeClient.emit(cacheChange(systemMetricsKey, systemHostKey));
                jest.advanceTimersByTime(cacheRealtimeRefreshDelayMs);
                await Promise.resolve();
            });

            expect(
                queryClient.getQueryState(cacheStatusQueryKey)?.isInvalidated
            ).toBeTrue();
            expect(queryClient.getQueryState(hostKey)?.isInvalidated).toBeFalse();
            expect(queryClient.getQueryState(metricsKey)?.isInvalidated).toBeFalse();
        } finally {
            view.unmount();
            queryClient.clear();
            jest.useRealTimers();
        }
    });

    test("invalidates all exact entries immediately and periodically after resync", async () => {
        jest.useFakeTimers();
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const hostKey = cacheEntryQueryKey(systemHostKey);
        const metricsKey = cacheEntryQueryKey(systemMetricsKey);
        queryClient.setQueryData(cacheStatusQueryKey, { entries: [] });
        queryClient.setQueryData(hostKey, { key: systemHostKey });
        queryClient.setQueryData(metricsKey, { key: systemMetricsKey });
        queryClient.setQueryData(unrelatedKey, { id: "report-1" });
        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardRealtimeProvider client={realtimeClient}>
                    <CacheRealtimeProbe />
                </DashboardRealtimeProvider>
            </QueryClientProvider>
        );

        try {
            await act(async () => {
                realtimeClient.requireResync();
                jest.advanceTimersByTime(cacheRealtimeRefreshDelayMs);
                await Promise.resolve();
            });
            expect(
                queryClient.getQueryState(cacheStatusQueryKey)?.isInvalidated
            ).toBeTrue();
            expect(queryClient.getQueryState(hostKey)?.isInvalidated).toBeTrue();
            expect(queryClient.getQueryState(metricsKey)?.isInvalidated).toBeTrue();
            expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBeFalse();

            queryClient.setQueryData(cacheStatusQueryKey, { entries: [] });
            queryClient.setQueryData(hostKey, { key: systemHostKey });
            queryClient.setQueryData(metricsKey, { key: systemMetricsKey });
            view.rerender(
                <QueryClientProvider client={queryClient}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <CacheRealtimeProbe />
                    </DashboardRealtimeProvider>
                </QueryClientProvider>
            );
            await act(async () => {
                jest.advanceTimersByTime(
                    cacheRealtimeFallbackRefreshIntervalMs + cacheRealtimeRefreshDelayMs
                );
                await Promise.resolve();
            });
            expect(
                queryClient.getQueryState(cacheStatusQueryKey)?.isInvalidated
            ).toBeTrue();
            expect(queryClient.getQueryState(hostKey)?.isInvalidated).toBeTrue();
            expect(queryClient.getQueryState(metricsKey)?.isInvalidated).toBeTrue();
        } finally {
            view.unmount();
            queryClient.clear();
            jest.useRealTimers();
        }
    });
});
