import { describe, expect, jest, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode } from "react";

import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import { jobRealtimeTopics } from "../../contracts/jobRealtime.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { jobRunDetailQueryKey, scheduleDetailQueryKey } from "./jobQueries.ts";
import {
    jobRealtimeFallbackRefreshIntervalMs,
    jobRealtimeRefreshDelayMs,
    useJobRealtimeInvalidation,
} from "./useJobRealtimeInvalidation.ts";

const { render, waitFor } = await import("@testing-library/react");
const runId = "019fdf70-0000-7000-8000-000000000002";
const scheduleId = "system.worker-smoke";
const unrelatedKey = ["monitoring", "reports", "test"] as const;

function JobRealtimeProbe() {
    useJobRealtimeInvalidation();
    return null;
}

function runChange(): RealtimeStreamOutput {
    return {
        data: {
            event: {
                entityId: runId,
                entityType: "job-run",
                occurredAtMs: 1_800_000_000_000,
                operation: "updated",
                payload: { id: runId },
                topic: jobRealtimeTopics.runs,
            },
            kind: "change",
        },
        id: "31",
    };
}

function scheduleChange(): RealtimeStreamOutput {
    return {
        data: {
            event: {
                entityId: scheduleId,
                entityType: "schedule",
                occurredAtMs: 1_800_000_000_100,
                operation: "updated",
                payload: { id: scheduleId },
                topic: jobRealtimeTopics.schedules,
            },
            kind: "change",
        },
        id: "32",
    };
}

describe("jobs realtime invalidation", () => {
    test("coalesces run events into both job and schedule roots", async () => {
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const runKey = jobRunDetailQueryKey(runId);
        const scheduleKey = scheduleDetailQueryKey(scheduleId);
        queryClient.setQueryData(runKey, { id: runId });
        queryClient.setQueryData(scheduleKey, { id: scheduleId });
        queryClient.setQueryData(unrelatedKey, { reports: [] });
        const view = render(
            <StrictMode>
                <QueryClientProvider client={queryClient}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <JobRealtimeProbe />
                    </DashboardRealtimeProvider>
                </QueryClientProvider>
            </StrictMode>
        );

        try {
            expect(realtimeClient.input).toEqual({
                topics: [jobRealtimeTopics.runs, jobRealtimeTopics.schedules],
            });
            expect(realtimeClient.activeSubscriptionCount).toBe(1);
            act(() => {
                realtimeClient.emit(runChange());
                realtimeClient.emit(runChange());
            });
            await waitFor(() => {
                expect(queryClient.getQueryState(runKey)?.isInvalidated).toBeTrue();
                expect(queryClient.getQueryState(scheduleKey)?.isInvalidated).toBeTrue();
            });
            expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBeFalse();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("keeps schedule events precise and starts fallback after terminal resync", async () => {
        jest.useFakeTimers();
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const runKey = jobRunDetailQueryKey(runId);
        const scheduleKey = scheduleDetailQueryKey(scheduleId);
        queryClient.setQueryData(runKey, { id: runId });
        queryClient.setQueryData(scheduleKey, { id: scheduleId });
        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardRealtimeProvider client={realtimeClient}>
                    <JobRealtimeProbe />
                </DashboardRealtimeProvider>
            </QueryClientProvider>
        );

        try {
            await act(async () => {
                realtimeClient.emit(scheduleChange());
                jest.advanceTimersByTime(jobRealtimeRefreshDelayMs);
                await Promise.resolve();
            });
            expect(queryClient.getQueryState(scheduleKey)?.isInvalidated).toBeTrue();
            expect(queryClient.getQueryState(runKey)?.isInvalidated).toBeFalse();

            queryClient.setQueryData(runKey, { id: runId });
            queryClient.setQueryData(scheduleKey, { id: scheduleId });
            await act(async () => {
                realtimeClient.requireResync();
                jest.advanceTimersByTime(jobRealtimeRefreshDelayMs);
                await Promise.resolve();
            });
            expect(queryClient.getQueryState(runKey)?.isInvalidated).toBeTrue();
            expect(queryClient.getQueryState(scheduleKey)?.isInvalidated).toBeTrue();

            queryClient.setQueryData(runKey, { id: runId });
            queryClient.setQueryData(scheduleKey, { id: scheduleId });
            await act(async () => {
                jest.advanceTimersByTime(
                    jobRealtimeFallbackRefreshIntervalMs + jobRealtimeRefreshDelayMs
                );
                await Promise.resolve();
            });
            expect(queryClient.getQueryState(runKey)?.isInvalidated).toBeTrue();
            expect(queryClient.getQueryState(scheduleKey)?.isInvalidated).toBeTrue();
        } finally {
            view.unmount();
            queryClient.clear();
            jest.useRealTimers();
        }
    });
});
