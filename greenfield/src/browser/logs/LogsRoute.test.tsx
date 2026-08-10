import { expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { LogMaintenanceStatusOutput } from "../../contracts/logs.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";
import { logMaintenanceQueryKey, logSourcesQueryKey } from "./logQueries.ts";
import { LogsRoute } from "./LogsRoute.tsx";

const { render, screen } = await import("@testing-library/react");

function maintenanceStatus(observedAtMs: number): LogMaintenanceStatusOutput {
    return {
        observedAtMs,
        policies: [
            {
                id: "docker-managed",
                label: "Managed application and container logs",
                scope: "docker",
                state: "queueable",
            },
            {
                id: "host-alternatives",
                label: "Host alternatives log",
                scope: "host",
                state: "unavailable",
            },
            {
                id: "host-apport",
                label: "Host Apport log",
                scope: "host",
                state: "unavailable",
            },
            {
                id: "host-dpkg",
                label: "Host package log",
                scope: "host",
                state: "unavailable",
            },
            {
                id: "host-rsyslog",
                label: "Host system logs",
                scope: "host",
                state: "unavailable",
            },
        ],
    };
}

test("logs route explains the redacted operator surface and composes its browser", async () => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const observedAtMs = Date.now();
    queryClient.setQueryData(
        logSourcesQueryKey,
        { observedAtMs, sources: [] },
        { updatedAt: observedAtMs }
    );
    queryClient.setQueryData(logMaintenanceQueryKey, maintenanceStatus(observedAtMs), {
        updatedAt: observedAtMs,
    });
    const client = {
        mutation: () => Promise.reject(new Error("Unexpected mutation")),
        query: () => Promise.reject(new Error("Unexpected query")),
    } as unknown as DashboardTrpcClient;
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardRealtimeProvider client={noOpDashboardRealtimeClient}>
                <DashboardTrpcProvider client={client}>
                    <LogsRoute />
                </DashboardTrpcProvider>
            </DashboardRealtimeProvider>
        </QueryClientProvider>
    );

    try {
        expect(
            await screen.findByRole("heading", { level: 1, name: "Logs" })
        ).toBeVisible();
        expect(screen.getByText("Operations")).toBeVisible();
        expect(
            screen.getByText(
                /Sensitive values are removed before display, and queued maintenance jobs require recent multi-factor authentication/u
            )
        ).toBeVisible();
        expect(
            await screen.findByRole("heading", { name: "No log sources" })
        ).toBeVisible();
    } finally {
        view.unmount();
        queryClient.clear();
    }
});
