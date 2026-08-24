import { expect, jest, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { logMaintenanceQueryKey, logSourcesQueryKey } from "../logs/logQueries.ts";
import { Route as logsLazyRoute } from "./logs.lazy.tsx";

const { render, screen } = await import("@testing-library/react");

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
    queryClient.setQueryData(
        logMaintenanceQueryKey,
        { observedAtMs, policies: [] },
        { updatedAt: observedAtMs }
    );
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
            <DashboardTrpcProvider client={client}>
                <RouteBoundary />
            </DashboardTrpcProvider>
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
