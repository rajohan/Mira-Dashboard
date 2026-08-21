import { expect, jest, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { LogMaintenanceStatusOutput } from "../../contracts/logs.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { logMaintenanceQueryKey, logSourcesQueryKey } from "../logs/logQueries.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";
import { Route as logsLazyRoute } from "./logs.lazy.tsx";

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

test("logs lazy route holds the redacted logs page behind current session verification", async () => {
    expect(logsLazyRoute.options.id).toBe("/logs");
    const RouteBoundary = logsLazyRoute.options.component;
    expect(RouteBoundary).toBeFunction();
    if (RouteBoundary === undefined)
        throw new TypeError("Logs route component is missing");

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
    const statusRequest = Promise.withResolvers<AuthStatus>();
    const query = jest.fn((name: string) => {
        if (name === "auth.status") return statusRequest.promise;
        return Promise.reject(new Error(`Unexpected query: ${name}`));
    });
    const client = {
        mutation: () => Promise.reject(new Error("Unexpected mutation")),
        query,
    } as unknown as DashboardTrpcClient;
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardRealtimeProvider client={noOpDashboardRealtimeClient}>
                <DashboardTrpcProvider client={client}>
                    <RouteBoundary />
                </DashboardTrpcProvider>
            </DashboardRealtimeProvider>
        </QueryClientProvider>
    );

    try {
        expect(screen.getByLabelText("Authentication status")).toHaveTextContent(
            "Checking your session…"
        );
        expect(screen.queryByRole("heading", { name: "Logs" })).toBeNull();

        await act(async () => {
            statusRequest.resolve({
                session: {
                    authenticatedAtMs: observedAtMs,
                    authMethod: "password",
                    createdAtMs: observedAtMs,
                    expiresAtMs: observedAtMs + 86_400_000,
                    id: "a".repeat(32),
                    isCurrent: true,
                    lastSeenAtMs: observedAtMs,
                },
                state: "authenticated",
                user: {
                    id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
                    username: "operator",
                },
            });
            await statusRequest.promise;
        });

        expect(
            await screen.findByRole("heading", { level: 1, name: "Logs" })
        ).toBeVisible();
        expect(query).toHaveBeenCalledWith(
            "auth.status",
            {},
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
    } finally {
        view.unmount();
        queryClient.clear();
    }
});
