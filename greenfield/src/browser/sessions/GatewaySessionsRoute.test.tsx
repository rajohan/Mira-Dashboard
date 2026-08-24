import { expect, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";

import {
    deriveGatewaySessionStats,
    gatewayPrimarySessionKey,
    type GatewaySession,
    type ListGatewaySessionsResult,
} from "../../contracts/gatewaySessions.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import type { DashboardRealtimeClient } from "../api/realtimeClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { Route as sessionsLazyRoute } from "../routes/sessions.lazy.tsx";
import { gatewaySessionQueryKey } from "./gatewaySessionQueries.ts";
import { GatewaySessionsRoute } from "./GatewaySessionsRoute.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");

const observedAtMs = 1_800_000_000_000;
const primarySession: GatewaySession = {
    displayName: "Primary main",
    hasActiveRun: true,
    key: gatewayPrimarySessionKey,
    kind: "main",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    sessionId: "primary-session-generation",
    totalTokens: 12_000,
    totalTokensFresh: true,
    updatedAtMs: observedAtMs,
};
const snapshot: ListGatewaySessionsResult = {
    filter: "ALL",
    projectionTruncated: false,
    sessions: [primarySession],
    source: {
        checkedAtMs: observedAtMs,
        connection: "connected",
        freshness: "fresh",
        observedAtMs,
    },
    stats: deriveGatewaySessionStats([primarySession], observedAtMs),
};

test("sessions route composes its bounded browser and lazy route registration", async () => {
    const queryClient = createDashboardQueryClient();
    queryClient.setQueryData(gatewaySessionQueryKey, snapshot, {
        updatedAt: Date.now(),
    });
    const realtimeClient: DashboardRealtimeClient = {
        subscribe: () => ({ unsubscribe() {} }),
    };
    const trpcClient = {} as DashboardTrpcClient;
    const rendered = render(
        <QueryClientProvider client={queryClient}>
            <DashboardRealtimeProvider client={realtimeClient}>
                <DashboardTrpcProvider client={trpcClient}>
                    <GatewaySessionsRoute />
                </DashboardTrpcProvider>
            </DashboardRealtimeProvider>
        </QueryClientProvider>
    );

    try {
        expect(sessionsLazyRoute.options.id).toBe("/sessions");
        expect(
            await screen.findByRole("heading", { level: 1, name: "Sessions" })
        ).toBeVisible();
        expect(
            await screen.findByRole("table", { name: "Current OpenClaw sessions" })
        ).toBeVisible();
        expect(
            screen.getByText(
                /Sensitive actions require a recent multi-factor authentication check/u
            )
        ).toBeVisible();
        expect(screen.getByText(/Updates automatically every 10 seconds/u)).toBeVisible();
        expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
        expect(screen.getByText("Primary main")).toBeVisible();
        await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    } finally {
        rendered.unmount();
        queryClient.clear();
    }
});
