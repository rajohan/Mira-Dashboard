import { expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { logMaintenanceQueryKey, logSourcesQueryKey } from "./logQueries.ts";
import { LogsRoute } from "./LogsRoute.tsx";

const { render, screen } = await import("@testing-library/react");

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
    queryClient.setQueryData(
        logMaintenanceQueryKey,
        { observedAtMs, policies: [] },
        { updatedAt: observedAtMs }
    );
    const client = {
        mutation: () => Promise.reject(new Error("Unexpected mutation")),
        query: () => Promise.reject(new Error("Unexpected query")),
    } as unknown as DashboardTrpcClient;
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardTrpcProvider client={client}>
                <LogsRoute />
            </DashboardTrpcProvider>
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
