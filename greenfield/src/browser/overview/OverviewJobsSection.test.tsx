import { afterEach, describe, expect, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";

import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import { jobRealtimeTopics } from "../../contracts/jobRealtime.ts";
import type { JobQueueSummary, ListJobRunsResult } from "../../contracts/jobs.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { jobRealtimeRefreshDelayMs } from "../jobs/useJobRealtimeInvalidation.ts";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { OverviewJobsSection } from "./OverviewJobsSection.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;

const activeSummary = Object.freeze({
    activeResourceClasses: ["light"],
    control: { claimingPaused: false, updatedAtMs: timestampMs, version: 1 },
    oldestQueuedAtMs: timestampMs - 60_000,
    stateCounts: {
        cancelled: 0,
        failed: 1,
        queued: 2,
        running: 1,
        succeeded: 8,
        "timed-out": 0,
    },
    workers: [],
} satisfies JobQueueSummary);

const pausedSummary = Object.freeze({
    ...activeSummary,
    control: { claimingPaused: true, updatedAtMs: timestampMs + 1000, version: 2 },
    oldestQueuedAtMs: timestampMs - 120_000,
    stateCounts: { ...activeSummary.stateCounts, queued: 3 },
} satisfies JobQueueSummary);

function jobPage(summary: JobQueueSummary): ListJobRunsResult {
    return { runs: [], summary };
}

type JobOutput = Error | ListJobRunsResult | Promise<ListJobRunsResult>;

class JobsOverviewTransport implements DashboardTrpcTransport {
    readonly calls: Array<{ readonly input: unknown; readonly path: string }> = [];
    readonly #outputs: readonly JobOutput[];

    constructor(outputs: readonly JobOutput[]) {
        this.#outputs = outputs;
    }

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, input?: unknown): Promise<unknown> {
        const index = this.calls.length;
        this.calls.push({ input, path });
        if (path !== "jobs.listRuns") {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        const output = this.#outputs[Math.min(index, this.#outputs.length - 1)];
        if (output === undefined) {
            return Promise.reject(new TypeError("Missing jobs output"));
        }
        return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
    }
}

interface SectionHarness {
    readonly queryClient: ReturnType<typeof createDashboardQueryClient>;
    readonly realtimeClient: ControlledDashboardRealtimeClient;
    readonly transport: JobsOverviewTransport;
    readonly view: ReturnType<typeof render>;
}

const harnesses: SectionHarness[] = [];

afterEach(() => {
    for (const { queryClient, view } of harnesses.splice(0)) {
        view.unmount();
        queryClient.clear();
    }
});

function renderSection(outputs: readonly JobOutput[]): SectionHarness {
    const queryClient = createDashboardQueryClient();
    queryClient.setDefaultOptions({
        ...queryClient.getDefaultOptions(),
        queries: {
            ...queryClient.getDefaultOptions().queries,
            retry: false,
        },
    });
    const transport = new JobsOverviewTransport(outputs);
    const trpcClient = createDashboardTrpcClient(transport);
    const realtimeClient = new ControlledDashboardRealtimeClient();
    const rootRoute = createRootRoute();
    const overviewRoute = createRoute({
        component: OverviewJobsSection,
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
        routeTree: rootRoute.addChildren([overviewRoute, jobsRoute]),
    });
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardRealtimeProvider client={realtimeClient}>
                <DashboardTrpcProvider client={trpcClient}>
                    <RouterProvider router={router} />
                </DashboardTrpcProvider>
            </DashboardRealtimeProvider>
        </QueryClientProvider>
    );
    const harness = { queryClient, realtimeClient, transport, view };
    harnesses.push(harness);
    return harness;
}

async function emitQueueChange(
    realtimeClient: ControlledDashboardRealtimeClient
): Promise<void> {
    const output: RealtimeStreamOutput = {
        data: {
            event: {
                entityId: "worker-control",
                entityType: "job-queue",
                occurredAtMs: timestampMs + 1000,
                operation: "snapshot-required",
                payload: { id: "worker-control" },
                topic: jobRealtimeTopics.runs,
            },
            kind: "change",
        },
        id: "41",
    };
    await act(async () => {
        realtimeClient.emit(output);
        await new Promise((resolve) =>
            setTimeout(resolve, jobRealtimeRefreshDelayMs + 20)
        );
    });
}

describe("OverviewJobsSection", () => {
    test("loads the exact bounded summary and refreshes after a queue snapshot", async () => {
        const firstPage = Promise.withResolvers<ListJobRunsResult>();
        const harness = renderSection([firstPage.promise, jobPage(pausedSummary)]);

        expect(await screen.findByLabelText("Loading Dashboard job queue…")).toBeTruthy();
        firstPage.resolve(jobPage(activeSummary));
        expect(await screen.findByText("Claiming active")).toBeTruthy();
        expect(harness.transport.calls[0]).toEqual({
            input: { limit: 1 },
            path: "jobs.listRuns",
        });
        expect(harness.realtimeClient.input?.topics).toEqual([
            jobRealtimeTopics.runs,
            jobRealtimeTopics.schedules,
        ]);

        await emitQueueChange(harness.realtimeClient);
        expect(await screen.findByText("Claiming paused")).toBeTruthy();
        expect(harness.transport.calls).toHaveLength(2);
    });

    test("retains validated queue state when a background refresh fails", async () => {
        const rawFailure = new TypeError("private jobs transport detail");
        const harness = renderSection([jobPage(activeSummary), rawFailure]);
        expect(await screen.findByText("Claiming active")).toBeTruthy();

        await emitQueueChange(harness.realtimeClient);
        expect(
            await screen.findByText("The request could not be completed. Try again.")
        ).toBeTruthy();
        expect(screen.getByText("Claiming active")).toBeTruthy();
        expect(screen.queryByText(rawFailure.message)).toBeNull();
    });

    test("recovers an initial safe error through the explicit retry", async () => {
        const rawFailure = new TypeError("private initial jobs failure");
        renderSection([rawFailure, jobPage(activeSummary)]);

        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Dashboard job queue unavailable",
            })
        ).toBeTruthy();
        expect(screen.queryByText(rawFailure.message)).toBeNull();

        await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(screen.getByText("Claiming active")).toBeTruthy());
    });
});
