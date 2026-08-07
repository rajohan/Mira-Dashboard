import { describe, expect, jest, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode } from "react";

import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import { monitoringRealtimeTopics } from "../../contracts/monitoringRealtime.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { incidentDetailQueryKey, reportDetailQueryKey } from "./monitoringQueries.ts";
import {
    monitoringRealtimeFallbackRefreshIntervalMs,
    monitoringRealtimeRefreshDelayMs,
    useIncidentRealtimeInvalidation,
    useReportRealtimeInvalidation,
} from "./useMonitoringRealtimeInvalidation.ts";

const { render } = await import("@testing-library/react");
const reportId = "019fd974-54a2-74dd-a64b-d4186f8d8828";
const incidentId = "019fd984-63e8-7404-a7da-80c6f243794f";

function ReportRealtimeProbe() {
    useReportRealtimeInvalidation();
    return null;
}

function IncidentRealtimeProbe() {
    useIncidentRealtimeInvalidation();
    return null;
}

describe("monitoring realtime invalidation", () => {
    test("coalesces report changes into report-only cache invalidation", async () => {
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const reportKey = reportDetailQueryKey(reportId);
        const incidentKey = incidentDetailQueryKey(incidentId);
        queryClient.setQueryData(reportKey, { id: reportId });
        queryClient.setQueryData(incidentKey, { id: incidentId });
        const view = render(
            <StrictMode>
                <QueryClientProvider client={queryClient}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <ReportRealtimeProbe />
                    </DashboardRealtimeProvider>
                </QueryClientProvider>
            </StrictMode>
        );

        expect(realtimeClient.input).toEqual({
            lastEventId: "0",
            topics: [monitoringRealtimeTopics.reports],
        });
        expect(realtimeClient.activeSubscriptionCount).toBe(1);
        await act(async () => {
            const output: RealtimeStreamOutput = {
                data: {
                    event: {
                        entityId: reportId,
                        entityType: "report",
                        occurredAtMs: 1_800_000_000_000,
                        operation: "created",
                        payload: { id: reportId },
                        topic: monitoringRealtimeTopics.reports,
                    },
                    kind: "change",
                },
                id: "18",
            };
            realtimeClient.emit(output);
            realtimeClient.emit(output);
            await new Promise((resolve) =>
                setTimeout(resolve, monitoringRealtimeRefreshDelayMs + 20)
            );
        });

        expect(queryClient.getQueryState(reportKey)?.isInvalidated).toBeTrue();
        expect(queryClient.getQueryState(incidentKey)?.isInvalidated).toBeFalse();
        view.unmount();
        expect(realtimeClient.activeSubscriptionCount).toBe(0);
        queryClient.clear();
    });

    test("refreshes immediately and periodically after terminal incident resync", async () => {
        jest.useFakeTimers();
        try {
            const queryClient = createDashboardQueryClient();
            const realtimeClient = new ControlledDashboardRealtimeClient();
            const incidentKey = incidentDetailQueryKey(incidentId);
            queryClient.setQueryData(incidentKey, { id: incidentId });
            const view = render(
                <QueryClientProvider client={queryClient}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <IncidentRealtimeProbe />
                    </DashboardRealtimeProvider>
                </QueryClientProvider>
            );

            expect(realtimeClient.input).toEqual({
                lastEventId: "0",
                topics: [monitoringRealtimeTopics.incidents],
            });
            await act(async () => {
                realtimeClient.requireResync();
                jest.advanceTimersByTime(monitoringRealtimeRefreshDelayMs);
                await Promise.resolve();
            });
            expect(queryClient.getQueryState(incidentKey)?.isInvalidated).toBeTrue();

            queryClient.setQueryData(incidentKey, { id: incidentId });
            await act(async () => {
                jest.advanceTimersByTime(
                    monitoringRealtimeFallbackRefreshIntervalMs +
                        monitoringRealtimeRefreshDelayMs
                );
                await Promise.resolve();
            });
            expect(queryClient.getQueryState(incidentKey)?.isInvalidated).toBeTrue();

            view.unmount();
            queryClient.clear();
        } finally {
            jest.useRealTimers();
        }
    });
});
