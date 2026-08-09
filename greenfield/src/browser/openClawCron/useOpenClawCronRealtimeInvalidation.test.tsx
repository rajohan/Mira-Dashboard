import { describe, expect, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode } from "react";

import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import { gatewayRealtimeTopics } from "../../contracts/gatewayRealtime.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import {
    openClawCronDetailQueryRoot,
    openClawCronListQueryRoot,
    openClawCronRunsQueryRoot,
} from "./openClawCronQueries.ts";
import { OpenClawCronSection } from "./OpenClawCronSection.tsx";
import { openClawCronRealtimeRefreshDelayMs } from "./useOpenClawCronRealtimeInvalidation.ts";

const { render, waitFor } = await import("@testing-library/react");

describe("OpenClaw cron realtime invalidation", () => {
    test("subscribes once to the cron topic and refreshes every cron projection", async () => {
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const listKey = [...openClawCronListQueryRoot, "all"] as const;
        const detailKey = [...openClawCronDetailQueryRoot, "nightly-report"] as const;
        const runsKey = [...openClawCronRunsQueryRoot, "nightly-report"] as const;
        const unrelatedKey = ["jobs", "runs", "list"] as const;
        queryClient.setQueryData(listKey, { jobs: [] });
        queryClient.setQueryData(detailKey, { id: "nightly-report" });
        queryClient.setQueryData(runsKey, { runs: [] });
        queryClient.setQueryData(unrelatedKey, { runs: [] });

        const view = render(
            <StrictMode>
                <QueryClientProvider client={queryClient}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <OpenClawCronSection
                            onDelete={() => Promise.resolve()}
                            onRetry={() => {}}
                            onRun={() => Promise.resolve()}
                            onSetEnabled={() => Promise.resolve()}
                            onUpdate={() => Promise.resolve()}
                            state={{ status: "loading" }}
                        />
                    </DashboardRealtimeProvider>
                </QueryClientProvider>
            </StrictMode>
        );

        try {
            expect(realtimeClient.input).toEqual({
                lastEventId: "0",
                topics: [gatewayRealtimeTopics.cron],
            });
            expect(realtimeClient.activeSubscriptionCount).toBe(1);
            const output: RealtimeStreamOutput = {
                data: {
                    event: {
                        entityId: "current",
                        entityType: "openclaw-cron",
                        occurredAtMs: 1_800_000_000_000,
                        operation: "snapshot-required",
                        payload: { kind: "snapshot-required" },
                        topic: gatewayRealtimeTopics.cron,
                    },
                    kind: "change",
                },
                id: "44",
            };
            act(() => {
                realtimeClient.emit(output);
                realtimeClient.emit(output);
            });
            await waitFor(
                () => {
                    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBeTrue();
                    expect(
                        queryClient.getQueryState(detailKey)?.isInvalidated
                    ).toBeTrue();
                    expect(queryClient.getQueryState(runsKey)?.isInvalidated).toBeTrue();
                },
                { timeout: openClawCronRealtimeRefreshDelayMs + 1000 }
            );
            expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBeFalse();
        } finally {
            view.unmount();
            expect(realtimeClient.activeSubscriptionCount).toBe(0);
            queryClient.clear();
        }
    });
});
