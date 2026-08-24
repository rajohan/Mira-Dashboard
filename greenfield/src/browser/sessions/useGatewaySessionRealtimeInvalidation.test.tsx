import { describe, expect, jest, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode } from "react";

import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import { gatewayRealtimeTopics } from "../../contracts/gatewayRealtime.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { gatewaySessionQueryKey } from "./gatewaySessionQueries.ts";
import {
    gatewaySessionRealtimeRefreshDelayMs,
    useGatewaySessionRealtimeInvalidation,
} from "./useGatewaySessionRealtimeInvalidation.ts";

const { render } = await import("@testing-library/react");
const unrelatedQueryKey = ["monitoring", "reports", "test"] as const;

function GatewaySessionRealtimeProbe() {
    useGatewaySessionRealtimeInvalidation();
    return null;
}

function gatewaySessionChange(): RealtimeStreamOutput {
    return {
        data: {
            event: {
                entityId: "current",
                entityType: "gateway-sessions",
                occurredAtMs: 1_800_000_000_000,
                operation: "snapshot-required",
                payload: { kind: "snapshot-required" },
                topic: gatewayRealtimeTopics.sessions,
            },
            kind: "change",
        },
        id: "51",
    };
}

describe("Gateway session realtime invalidation", () => {
    test("subscribes once to gateway.sessions and refreshes only its snapshot query", async () => {
        jest.useFakeTimers();
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        queryClient.setQueryData(gatewaySessionQueryKey, { sessions: [] });
        queryClient.setQueryData(unrelatedQueryKey, { reports: [] });
        const view = render(
            <StrictMode>
                <QueryClientProvider client={queryClient}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <GatewaySessionRealtimeProbe />
                    </DashboardRealtimeProvider>
                </QueryClientProvider>
            </StrictMode>
        );

        try {
            expect(realtimeClient.input).toEqual({
                topics: [gatewayRealtimeTopics.sessions],
            });
            expect(realtimeClient.activeSubscriptionCount).toBe(1);
            act(() => {
                realtimeClient.emit(gatewaySessionChange());
                realtimeClient.emit(gatewaySessionChange());
            });
            expect(
                queryClient.getQueryState(gatewaySessionQueryKey)?.isInvalidated
            ).toBeFalse();

            await act(async () => {
                jest.advanceTimersByTime(gatewaySessionRealtimeRefreshDelayMs);
                await Promise.resolve();
            });

            expect(
                queryClient.getQueryState(gatewaySessionQueryKey)?.isInvalidated
            ).toBeTrue();
            expect(
                queryClient.getQueryState(unrelatedQueryKey)?.isInvalidated
            ).toBeFalse();
        } finally {
            view.unmount();
            expect(realtimeClient.activeSubscriptionCount).toBe(0);
            queryClient.clear();
            jest.useRealTimers();
        }
    });
});
