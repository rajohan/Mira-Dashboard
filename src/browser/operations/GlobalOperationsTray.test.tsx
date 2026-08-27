import { afterEach, describe, expect, jest, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";

import { jobRealtimeTopics } from "../../contracts/jobRealtime.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { dashboardTrpcContext } from "../api/trpcContextValue.ts";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { GlobalOperationsTray } from "./GlobalOperationsTray.tsx";
import { OperationTrackerContext } from "./operationTrackerContextValue.ts";

const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

afterEach(cleanup);

describe("global operations tray", () => {
    test("keeps a cached active operation non-dismissible after a refetch error", async () => {
        const user = userEvent.setup();
        let activeRunAttempt = 0;
        const query = jest.fn((_name: string, input: { id: string }) => {
            if (input.id === "missing-run") {
                return Promise.reject(new Error("run not found"));
            }
            activeRunAttempt += 1;
            if (activeRunAttempt === 1) {
                return Promise.resolve({ run: { state: "running" } });
            }
            if (activeRunAttempt === 2) {
                return Promise.reject(new Error("temporarily unavailable"));
            }
            return Promise.resolve({ run: { state: "succeeded" } });
        });
        const dismiss = jest.fn();
        const settle = jest.fn();
        const client = { query } as unknown as DashboardTrpcClient;
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const rootRoute = createRootRoute();
        const indexRoute = createRoute({
            component: GlobalOperationsTray,
            getParentRoute: () => rootRoute,
            path: "/",
        });
        const jobsRoute = createRoute({
            component: () => null,
            getParentRoute: () => rootRoute,
            path: "/jobs",
        });
        const router = createRouter({
            history: createMemoryHistory({ initialEntries: ["/"] }),
            routeTree: rootRoute.addChildren([indexRoute, jobsRoute]),
        });
        const view = render(
            <QueryClientProvider client={queryClient}>
                <dashboardTrpcContext.Provider value={client}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <OperationTrackerContext
                            value={{
                                dismiss,
                                operations: [
                                    {
                                        jobRunId: "run-1",
                                        label: "Scan for updates",
                                        terminal: false,
                                    },
                                    {
                                        jobRunId: "missing-run",
                                        label: "Unknown operation",
                                        terminal: false,
                                    },
                                ],
                                settle,
                                track: jest.fn(),
                            }}
                        >
                            <RouterProvider router={router} />
                        </OperationTrackerContext>
                    </DashboardRealtimeProvider>
                </dashboardTrpcContext.Provider>
            </QueryClientProvider>
        );

        try {
            expect(await screen.findByText("running")).toBeVisible();
            await queryClient.refetchQueries({ queryKey: ["operations", "runs"] });
            await waitFor(() => expect(activeRunAttempt).toBe(2));

            expect(screen.getByText("running")).toBeVisible();
            expect(
                screen.queryByRole("button", { name: "Dismiss Scan for updates" })
            ).not.toBeInTheDocument();
            expect(screen.getByText("Status unavailable")).toBeVisible();
            expect(
                screen.getByRole("button", { name: "Dismiss Unknown operation" })
            ).toBeVisible();

            await queryClient.refetchQueries({ queryKey: ["operations", "runs"] });
            expect(await screen.findByText("succeeded")).toBeVisible();
            await waitFor(() => expect(settle).toHaveBeenCalledWith("run-1"));
            await user.click(
                screen.getByRole("button", { name: "Dismiss Scan for updates" })
            );
            expect(dismiss).toHaveBeenCalledWith("run-1");
            const runQueryCountBeforeRealtimeEvent = query.mock.calls.filter(
                ([, input]) => input.id === "run-1"
            ).length;
            const missingQueryCountBeforeRealtimeEvent = query.mock.calls.filter(
                ([, input]) => input.id === "missing-run"
            ).length;
            act(() => {
                realtimeClient.emit({
                    data: {
                        event: {
                            entityId: "run-1",
                            entityType: "job-run",
                            occurredAtMs: 1_800_000_000_000,
                            operation: "updated",
                            payload: { id: "run-1" },
                            topic: jobRealtimeTopics.runs,
                        },
                        kind: "change",
                    },
                    id: "1",
                });
            });
            await waitFor(() =>
                expect(
                    query.mock.calls.filter(([, input]) => input.id === "missing-run")
                        .length
                ).toBeGreaterThan(missingQueryCountBeforeRealtimeEvent)
            );
            expect(
                query.mock.calls.filter(([, input]) => input.id === "run-1").length
            ).toBe(runQueryCountBeforeRealtimeEvent);
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });
});
