import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
    useSearch,
} from "@tanstack/react-router";
import type { TRPCRequestOptions } from "@trpc/client";
import { act, Activity } from "react";

import type { JobRunEvent, JobRunSummary } from "../../contracts/jobModel.ts";
import type {
    GetJobRunInput,
    JobQueueSummary,
    JobRunDetail,
} from "../../contracts/jobs.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import {
    installIntersectionObserverHarness,
    type IntersectionObserverHarness,
} from "../test/intersectionObserverTest.ts";
import {
    jobHistoryNeedsInitialFill,
    jobRunDetailQueryKey,
    jobRunEventHistoryQueryKey,
} from "./jobQueries.ts";
import { parseJobsRouteSearch } from "./jobRouteSearch.ts";
import { SelectedJobRun } from "./JobRunBrowser.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const runId = "019fdf70-0000-7000-8000-000000000002";
const otherRunId = "019fdf70-0000-7000-8000-000000000003";
const timestampMs = 1_800_000_000_000;
const eventProjectionWait = { timeout: 3000 } as const;
let intersectionObserver: IntersectionObserverHarness;

beforeEach(() => {
    intersectionObserver = installIntersectionObserverHarness();
});

afterEach(() => intersectionObserver.restore());

test("keeps filling history until reported active runs are represented", () => {
    expect(jobHistoryNeedsInitialFill(0, 100, 1)).toBeTrue();
    expect(jobHistoryNeedsInitialFill(1, 100, 1)).toBeFalse();
    expect(jobHistoryNeedsInitialFill(0, 49)).toBeTrue();
});

function runningRun(eventCount: number, id = runId): JobRunSummary {
    return {
        actionKey: "system.worker-smoke",
        attemptCount: 1,
        attemptLimit: 3,
        availableAtMs: timestampMs,
        cancellationPolicy: "cooperative",
        displayName: "Gap-safe worker smoke",
        eventCount,
        firstStartedAtMs: timestampMs + 1000,
        id,
        lastAttemptStartedAtMs: timestampMs + 1000,
        priority: 0,
        queuedAtMs: timestampMs,
        resourceClass: "light",
        resourceKeys: [],
        retrySafe: true,
        state: "running",
        stateVersion: 2,
        timeoutMs: 60_000,
        triggerType: "system",
        updatedAtMs: timestampMs + 1000,
    };
}

function runEvent(sequence: number): JobRunEvent {
    return {
        attempt: 1,
        kind: "stdout",
        message: `Output ${sequence}`,
        occurredAtMs: timestampMs + sequence,
        sequence,
    };
}

function eventRange(newest: number, oldest: number): JobRunEvent[] {
    return Array.from({ length: newest - oldest + 1 }, (_, index) =>
        runEvent(newest - index)
    );
}

function detailPage(
    newest: number,
    oldest: number,
    eventCount: number,
    nextEventCursor = true,
    id = runId
): JobRunDetail {
    return {
        events: eventRange(newest, oldest),
        ...(nextEventCursor ? { nextEventCursor: { sequence: oldest } } : {}),
        run: runningRun(eventCount, id),
    };
}

function emptyQueueSummary(): JobQueueSummary {
    return {
        activeResourceClasses: [],
        control: { claimingPaused: false, updatedAtMs: timestampMs, version: 1 },
        stateCounts: {
            cancelled: 0,
            failed: 0,
            queued: 0,
            running: 0,
            succeeded: 0,
            "timed-out": 0,
        },
        workers: [],
    };
}

class EventGapTransport implements DashboardTrpcTransport {
    readonly calls: {
        readonly input: unknown;
        readonly path: string;
        readonly signal: AbortSignal | undefined;
    }[] = [];
    #deferredGap = Promise.withResolvers<unknown>();
    #deferredGapEnabled = false;
    #deferredGapUsed = false;
    exactFailuresRemaining = 0;
    gap33FailuresRemaining = 0;
    newestExactSequence = 22;

    deferFirstGap(): void {
        this.#deferredGapEnabled = true;
    }

    resolveDeferredGap(): void {
        this.#deferredGap.resolve(
            detailPage(32, 23, Math.max(42, this.newestExactSequence))
        );
    }

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, input?: unknown, options?: TRPCRequestOptions): Promise<unknown> {
        this.calls.push({ input, path, signal: options?.signal });
        if (path === "jobs.listRuns") {
            return Promise.resolve({ runs: [], summary: emptyQueueSummary() });
        }
        if (path !== "jobs.getRun") {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        const { eventCursor, id } = input as GetJobRunInput;
        if (id === otherRunId) {
            return Promise.resolve(detailPage(2, 1, 2, false, otherRunId));
        }
        if (eventCursor === undefined) {
            if (this.exactFailuresRemaining > 0) {
                this.exactFailuresRemaining -= 1;
                return Promise.reject(new TypeError("Exact detail unavailable"));
            }
            if (this.newestExactSequence === 22) {
                return Promise.resolve(detailPage(22, 13, 22));
            }
            if (this.newestExactSequence === 42) {
                return Promise.resolve(detailPage(42, 33, 42));
            }
            return Promise.resolve(detailPage(62, 53, 62));
        }
        if (eventCursor.sequence === 13) {
            return Promise.resolve(detailPage(12, 3, 22, false));
        }
        if (eventCursor.sequence === 33) {
            if (this.gap33FailuresRemaining > 0) {
                this.gap33FailuresRemaining -= 1;
                return Promise.reject(new TypeError("Event gap unavailable"));
            }
            if (this.#deferredGapEnabled && !this.#deferredGapUsed) {
                this.#deferredGapUsed = true;
                return this.#deferredGap.promise;
            }
            return Promise.resolve(
                detailPage(32, 23, Math.max(42, this.newestExactSequence))
            );
        }
        if (eventCursor.sequence === 53) {
            return Promise.resolve(detailPage(52, 43, 62));
        }
        return Promise.reject(
            new TypeError(`Unexpected event cursor: ${eventCursor.sequence}`)
        );
    }
}

class DetailOnlyTransport extends EventGapTransport {
    override query(
        path: string,
        input?: unknown,
        options?: TRPCRequestOptions
    ): Promise<unknown> {
        if (path === "jobs.listRuns") {
            this.calls.push({ input, path, signal: options?.signal });
            return Promise.reject(new TypeError("Run list unavailable"));
        }
        return super.query(path, input, options);
    }
}

function eventCursors(transport: EventGapTransport): (number | undefined)[] {
    return transport.calls
        .filter(({ path }) => path === "jobs.getRun")
        .map(({ input }) => (input as GetJobRunInput).eventCursor?.sequence);
}

function SelectedRunFromSearch() {
    const search = parseJobsRouteSearch(useSearch({ from: "/jobs" }) as unknown);
    return search.runId === undefined ? null : (
        <SelectedJobRun
            focusRequested={false}
            id={search.runId}
            key={search.runId}
            onFocusHandled={() => {}}
        />
    );
}

function createJobsTestRouter() {
    const rootRoute = createRootRoute();
    const jobsRoute = createRoute({
        component: SelectedRunFromSearch,
        getParentRoute: () => rootRoute,
        path: "/jobs",
        validateSearch: parseJobsRouteSearch,
    });
    return createRouter({
        history: createMemoryHistory({ initialEntries: [`/jobs?runId=${runId}`] }),
        routeTree: rootRoute.addChildren([jobsRoute]),
    });
}

function createJobBrowserHarness(transport: EventGapTransport) {
    const queryClient = createDashboardQueryClient();
    queryClient.setDefaultOptions({
        ...queryClient.getDefaultOptions(),
        queries: {
            ...queryClient.getDefaultOptions().queries,
            retry: false,
        },
    });
    const client = createDashboardTrpcClient(transport);
    const router = createJobsTestRouter();
    const tree = (mode: "hidden" | "visible") => (
        <QueryClientProvider client={queryClient}>
            <DashboardTrpcProvider client={client}>
                <Activity mode={mode}>
                    <RouterProvider router={router} />
                </Activity>
            </DashboardTrpcProvider>
        </QueryClientProvider>
    );
    const view = render(tree("visible"));
    return { queryClient, router, tree, view };
}

async function loadInitialEventHistory(): Promise<void> {
    expect(
        await screen.findByRole(
            "article",
            { name: "Event 13: stdout" },
            eventProjectionWait
        )
    ).toBeTruthy();
    act(() => intersectionObserver.intersectLatest());
    expect(
        await screen.findByRole(
            "article",
            { name: "Event 3: stdout" },
            eventProjectionWait
        )
    ).toBeTruthy();
}

async function refreshExactDetail(
    transport: EventGapTransport,
    queryClient: ReturnType<typeof createDashboardQueryClient>,
    newestExactSequence: 42 | 62
): Promise<void> {
    transport.newestExactSequence = newestExactSequence;
    await act(async () => {
        await queryClient.invalidateQueries({
            exact: true,
            queryKey: jobRunDetailQueryKey(runId),
        });
    });
}

describe("job run browser", () => {
    test("renders a deep-linked run while list and summary reads fail", async () => {
        const transport = new DetailOnlyTransport();
        const { queryClient, view } = createJobBrowserHarness(transport);

        try {
            expect(
                await screen.findByRole("heading", { name: "Gap-safe worker smoke" })
            ).toBeTruthy();
            expect(transport.calls.some(({ path }) => path === "jobs.getRun")).toBeTrue();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("fills a realtime cursor jump without discarding loaded history", async () => {
        const transport = new EventGapTransport();
        const { queryClient, view } = createJobBrowserHarness(transport);

        try {
            await loadInitialEventHistory();
            await refreshExactDetail(transport, queryClient, 42);

            expect(
                await screen.findByRole(
                    "article",
                    { name: "Event 23: stdout" },
                    eventProjectionWait
                )
            ).toBeTruthy();
            expect(
                screen.getByRole("article", { name: "Event 22: stdout" })
            ).toBeTruthy();
            expect(screen.getByRole("article", { name: "Event 3: stdout" })).toBeTruthy();
            await waitFor(() =>
                expect(
                    screen.getAllByRole("article", { name: /^Event \d+: stdout$/u })
                ).toHaveLength(40)
            );
            expect(
                screen.getAllByRole("article", { name: "Event 23: stdout" })
            ).toHaveLength(1);
            const renderedSequences = screen
                .getAllByRole("article", { name: /^Event \d+: stdout$/u })
                .map((article) =>
                    Number(
                        article
                            .getAttribute("aria-label")
                            ?.split(" ")[1]
                            ?.replace(":", "") ?? ""
                    )
                );
            expect(renderedSequences.at(0)).toBe(42);
            expect(renderedSequences.slice(9, 11)).toEqual([33, 32]);
            expect(renderedSequences.slice(19, 21)).toEqual([23, 22]);
            expect(renderedSequences.at(-1)).toBe(3);

            expect(eventCursors(transport)).toEqual([undefined, 13, undefined, 33]);
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("repairs a later cursor jump after cached history remounts through A to B to A", async () => {
        const transport = new EventGapTransport();
        const { queryClient, router, view } = createJobBrowserHarness(transport);

        try {
            await loadInitialEventHistory();
            expect(
                queryClient.getQueryData(jobRunEventHistoryQueryKey(runId))
            ).toBeDefined();

            await act(async () => {
                await router.navigate({
                    search: { runId: otherRunId },
                    to: "/jobs",
                });
            });
            await waitFor(() =>
                expect(
                    transport.calls.some(
                        ({ input, path }) =>
                            path === "jobs.getRun" &&
                            (input as GetJobRunInput).id === otherRunId
                    )
                ).toBeTrue()
            );

            transport.newestExactSequence = 42;
            await act(async () => {
                await router.navigate({
                    search: { runId },
                    to: "/jobs",
                });
            });

            await waitFor(
                () => expect(eventCursors(transport)).toContain(33),
                eventProjectionWait
            );
            expect(
                await screen.findByRole(
                    "article",
                    { name: "Event 23: stdout" },
                    eventProjectionWait
                )
            ).toBeTruthy();
            expect(screen.getByRole("article", { name: "Event 3: stdout" })).toBeTruthy();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("serializes realtime gap repairs when another cursor jump arrives in flight", async () => {
        const transport = new EventGapTransport();
        transport.deferFirstGap();
        const { queryClient, view } = createJobBrowserHarness(transport);

        try {
            await loadInitialEventHistory();
            await refreshExactDetail(transport, queryClient, 42);
            await waitFor(
                () => expect(eventCursors(transport)).toContain(33),
                eventProjectionWait
            );

            await refreshExactDetail(transport, queryClient, 62);
            expect(eventCursors(transport)).not.toContain(53);
            act(() => transport.resolveDeferredGap());

            await waitFor(
                () => expect(eventCursors(transport)).toContain(53),
                eventProjectionWait
            );
            expect(
                await screen.findByRole(
                    "article",
                    { name: "Event 43: stdout" },
                    eventProjectionWait
                )
            ).toBeTruthy();
            await waitFor(
                () =>
                    expect(
                        screen.getAllByRole("article", {
                            name: /^Event \d+: stdout$/u,
                        })
                    ).toHaveLength(60),
                eventProjectionWait
            );
            expect(eventCursors(transport)).toEqual([
                undefined,
                13,
                undefined,
                33,
                undefined,
                53,
            ]);
        } finally {
            transport.resolveDeferredGap();
            view.unmount();
            queryClient.clear();
        }
    });

    test("restarts an aborted gap repair after authenticated activity resumes", async () => {
        const transport = new EventGapTransport();
        transport.deferFirstGap();
        const { queryClient, tree, view } = createJobBrowserHarness(transport);

        try {
            await loadInitialEventHistory();
            await refreshExactDetail(transport, queryClient, 42);
            await waitFor(
                () => expect(eventCursors(transport)).toContain(33),
                eventProjectionWait
            );
            const firstGapSignal = transport.calls.find(
                ({ input, path }) =>
                    path === "jobs.getRun" &&
                    (input as GetJobRunInput).eventCursor?.sequence === 33
            )?.signal;
            if (firstGapSignal === undefined) {
                throw new TypeError("Missing first event-gap signal");
            }
            await refreshExactDetail(transport, queryClient, 62);
            expect(eventCursors(transport)).not.toContain(53);

            view.rerender(tree("hidden"));
            await waitFor(() => expect(firstGapSignal.aborted).toBeTrue());
            view.rerender(tree("visible"));

            await waitFor(
                () =>
                    expect(
                        eventCursors(transport).filter((cursor) => cursor === 33)
                    ).toHaveLength(2),
                eventProjectionWait
            );
            expect(
                await screen.findByRole(
                    "article",
                    { name: "Event 23: stdout" },
                    eventProjectionWait
                )
            ).toBeTruthy();
            expect(
                await screen.findByRole(
                    "article",
                    { name: "Event 43: stdout" },
                    eventProjectionWait
                )
            ).toBeTruthy();
            expect(eventCursors(transport)).toContain(53);
        } finally {
            transport.resolveDeferredGap();
            view.unmount();
            queryClient.clear();
        }
    });

    test("offers a dedicated retry after final-history gap repair fails", async () => {
        const transport = new EventGapTransport();
        transport.gap33FailuresRemaining = 1;
        const { queryClient, view } = createJobBrowserHarness(transport);

        try {
            await loadInitialEventHistory();
            await refreshExactDetail(transport, queryClient, 42);

            await waitFor(
                () => expect(eventCursors(transport)).toContain(33),
                eventProjectionWait
            );
            const retry = await screen.findByRole(
                "button",
                { name: "Retry missing events" },
                eventProjectionWait
            );
            await refreshExactDetail(transport, queryClient, 62);
            expect(eventCursors(transport)).not.toContain(53);
            expect(
                screen.queryByRole("button", { name: "Load older events" })
            ).toBeNull();
            await userEvent.setup().click(retry);

            await waitFor(
                () =>
                    expect(
                        eventCursors(transport).filter((cursor) => cursor === 33)
                    ).toHaveLength(2),
                eventProjectionWait
            );
            await waitFor(
                () => expect(eventCursors(transport)).toContain(53),
                eventProjectionWait
            );
            expect(
                await screen.findByRole(
                    "article",
                    { name: "Event 23: stdout" },
                    eventProjectionWait
                )
            ).toBeTruthy();
            expect(
                await screen.findByRole(
                    "article",
                    { name: "Event 43: stdout" },
                    eventProjectionWait
                )
            ).toBeTruthy();
            expect(
                eventCursors(transport).filter((cursor) => cursor === 33)
            ).toHaveLength(2);
            expect(eventCursors(transport)).toContain(53);
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("keeps event-history retry when its safe message matches detail failure", async () => {
        const transport = new EventGapTransport();
        transport.gap33FailuresRemaining = 1;
        const { queryClient, view } = createJobBrowserHarness(transport);

        try {
            await loadInitialEventHistory();
            await refreshExactDetail(transport, queryClient, 42);
            expect(
                await screen.findByRole(
                    "button",
                    { name: "Retry missing events" },
                    eventProjectionWait
                )
            ).toBeVisible();

            transport.exactFailuresRemaining = 1;
            await refreshExactDetail(transport, queryClient, 42);

            expect(
                screen.getByRole("button", { name: "Retry missing events" })
            ).toBeVisible();
            expect(
                screen.getAllByText("The request could not be completed. Try again.")
            ).toHaveLength(1);
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });
});
