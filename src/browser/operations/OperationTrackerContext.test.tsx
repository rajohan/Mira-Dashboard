import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { dashboardTrpcContext } from "../api/trpcContextValue.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import { authenticatedDashboardStoryStatus } from "../storySupport/dashboardStoryTransport.ts";
import { OperationTrackerProvider } from "./OperationTrackerContext.tsx";
import { useOperationTracker } from "./operationTrackerContextValue.ts";

const { cleanup, render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

afterEach(() => {
    cleanup();
});

function ProviderHarness({
    children,
    query = () => Promise.resolve({ runs: [], summary: {} }),
}: {
    readonly children: ReactNode;
    readonly query?: (...arguments_: readonly unknown[]) => Promise<unknown>;
}) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(authStatusQueryKey, authenticatedDashboardStoryStatus);
    const client = { query } as unknown as DashboardTrpcClient;
    return (
        <QueryClientProvider client={queryClient}>
            <dashboardTrpcContext.Provider value={client}>
                <OperationTrackerProvider>{children}</OperationTrackerProvider>
            </dashboardTrpcContext.Provider>
        </QueryClientProvider>
    );
}

function Harness() {
    const tracker = useOperationTracker();
    const [terminalRefreshes, setTerminalRefreshes] = useState(0);
    return (
        <div>
            <button
                onClick={() => tracker.track({ jobRunId: "run-1", label: "First" })}
                type="button"
            >
                Track first
            </button>
            <button
                onClick={() => tracker.track({ jobRunId: "run-1", label: "Updated" })}
                type="button"
            >
                Track updated
            </button>
            <button onClick={() => tracker.dismiss("run-1")} type="button">
                Dismiss
            </button>
            <button
                onClick={() => {
                    for (let index = 1; index <= 13; index += 1) {
                        tracker.track({
                            jobRunId: `active-${index}`,
                            label: `Active ${index}`,
                        });
                    }
                }}
                type="button"
            >
                Track active batch
            </button>
            <button onClick={() => tracker.settle("active-1")} type="button">
                Settle oldest
            </button>
            <button
                onClick={() =>
                    tracker.track({
                        jobRunId: "refresh-run",
                        label: "Refresh run",
                        onTerminal: () => setTerminalRefreshes((current) => current + 1),
                    })
                }
                type="button"
            >
                Track refresh
            </button>
            <button onClick={() => tracker.settle("refresh-run")} type="button">
                Settle refresh
            </button>
            <output aria-label="Operations">
                {tracker.operations.map(({ label }) => label).join(",")}
                {` (${tracker.operations.length})`}
            </output>
            <output aria-label="Terminal refreshes">{terminalRefreshes}</output>
        </div>
    );
}

function IdentityHarness() {
    const tracker = useOperationTracker();
    return (
        <output aria-label="Exact operation state">
            {tracker.operationIsActive("job:docker.updater:scan") ? "Scanning" : "Idle"}
        </output>
    );
}

function restoredScanQuery() {
    return Promise.resolve({
        runs: [
            {
                actionKey: "docker.updater",
                displayName: "Docker updater scan",
                id: "restored-scan",
                operationKey: "job:docker.updater:scan",
                state: "running",
            },
        ],
        summary: {},
    });
}

describe("operation tracker", () => {
    test("restores only active manual operations from the backend", async () => {
        const query = mock((..._arguments: readonly unknown[]) =>
            Promise.resolve({
                runs: [
                    {
                        actionKey: "docker.updater",
                        displayName: "Docker updater",
                        id: "run-from-another-device",
                        operationKey: "job:docker.updater:scan",
                        state: "running",
                    },
                ],
                summary: {},
            })
        );
        render(
            <ProviderHarness query={query}>
                <Harness />
            </ProviderHarness>
        );

        expect(
            await screen.findByRole("status", { name: "Operations" })
        ).toHaveTextContent("Docker updater (1)");
        expect(query).toHaveBeenCalledWith(
            "jobs.listRuns",
            {
                filters: {
                    states: ["queued", "running"],
                    triggerTypes: ["manual"],
                },
                limit: 100,
            },
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
    });

    test("restores the exact active button identity after provider remount", async () => {
        const view = render(
            <ProviderHarness query={restoredScanQuery}>
                <IdentityHarness />
            </ProviderHarness>
        );

        expect(
            await screen.findByRole("status", { name: "Exact operation state" })
        ).toHaveTextContent("Scanning");
        view.unmount();
        render(
            <ProviderHarness query={restoredScanQuery}>
                <IdentityHarness />
            </ProviderHarness>
        );
        expect(
            await screen.findByRole("status", { name: "Exact operation state" })
        ).toHaveTextContent("Scanning");
    });

    test("deduplicates durable run identities and dismisses them", async () => {
        const user = userEvent.setup();
        render(
            <ProviderHarness>
                <Harness />
            </ProviderHarness>
        );

        await user.click(screen.getByRole("button", { name: "Track first" }));
        expect(screen.getByRole("status", { name: "Operations" }).textContent).toContain(
            "First"
        );
        await user.click(screen.getByRole("button", { name: "Track updated" }));
        expect(screen.getByRole("status", { name: "Operations" }).textContent).toContain(
            "Updated"
        );
        expect(
            screen.getByRole("status", { name: "Operations" }).textContent
        ).not.toContain("First");
        await user.click(screen.getByRole("button", { name: "Dismiss" }));
        expect(screen.getByRole("status", { name: "Operations" }).textContent).toBe(
            " (0)"
        );
    });

    test("keeps every active operation and caps only terminal history", async () => {
        const user = userEvent.setup();
        render(
            <ProviderHarness>
                <Harness />
            </ProviderHarness>
        );

        await user.click(screen.getByRole("button", { name: "Track active batch" }));
        expect(screen.getByRole("status", { name: "Operations" }).textContent).toContain(
            "Active 1"
        );
        expect(screen.getByRole("status", { name: "Operations" }).textContent).toContain(
            "(13)"
        );

        await user.click(screen.getByRole("button", { name: "Settle oldest" }));
        expect(
            screen.getByRole("status", { name: "Operations" }).textContent
        ).not.toContain("Active 1,");
        expect(screen.getByRole("status", { name: "Operations" }).textContent).toContain(
            "(12)"
        );
    });

    test("runs one domain refresh exactly once when a tracked job becomes terminal", async () => {
        const user = userEvent.setup();
        render(
            <ProviderHarness>
                <Harness />
            </ProviderHarness>
        );

        await user.click(screen.getByRole("button", { name: "Track refresh" }));
        await user.click(screen.getByRole("button", { name: "Settle refresh" }));
        await user.click(screen.getByRole("button", { name: "Settle refresh" }));

        expect(
            screen.getByRole("status", { name: "Terminal refreshes" })
        ).toHaveTextContent("1");
    });
});
