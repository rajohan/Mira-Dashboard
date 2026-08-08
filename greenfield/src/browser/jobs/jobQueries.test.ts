import { describe, expect, jest, test } from "bun:test";

import { InfiniteQueryObserver, QueryObserver } from "@tanstack/react-query";
import type { TRPCRequestOptions } from "@trpc/client";

import type {
    JobRunSummary,
    JobWorkerSummary,
    ScheduleSummary,
} from "../../contracts/jobModel.ts";
import type { JobQueueSummary } from "../../contracts/jobs.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import {
    jobRunDetailQueryOptions,
    jobRunEventGapQueryKey,
    jobRunEventGapQueryOptions,
    jobRunEventHistoryQueryKey,
    jobRunEventHistoryQueryOptions,
    jobRunListQueryOptions,
    jobQueueSummaryQueryOptions,
    jobQueueSummaryRefreshIntervalMs,
    refreshJobQueries,
    refreshScheduleQueries,
    scheduleDetailQueryOptions,
    scheduleListQueryOptions,
    scheduleRunListQueryOptions,
    uniqueJobRunEvents,
    uniqueJobRows,
} from "./jobQueries.ts";

const newestRunId = "019fdf70-0000-7000-8000-000000000002";
const oldestRunId = "019fdf60-0000-7000-8000-000000000001";
const timestampMs = 1_800_000_000_000;
const scheduleId = "system.worker-smoke";

function queuedRun(id: string, queuedAtMs: number): JobRunSummary {
    return {
        actionKey: scheduleId,
        attemptCount: 0,
        attemptLimit: 3,
        availableAtMs: queuedAtMs,
        cancellationPolicy: "cooperative",
        displayName: "Worker smoke",
        eventCount: 1,
        id,
        priority: 0,
        queuedAtMs,
        resourceClass: "light",
        resourceKeys: ["database"],
        retrySafe: true,
        scheduledJobId: scheduleId,
        scheduledJobVersion: 1,
        state: "queued",
        stateVersion: 1,
        timeoutMs: 30_000,
        triggerType: "manual",
        updatedAtMs: queuedAtMs,
    };
}

function schedule(id: string, enabled = true): ScheduleSummary {
    return {
        actionKey: scheduleId,
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        createdAtMs: timestampMs - 10_000,
        description: "Checks the worker without host mutation.",
        enabled,
        id,
        name: "Worker smoke",
        ...(enabled ? { nextRunAtMs: timestampMs + 60_000 } : {}),
        priority: 0,
        resourceClass: "light",
        resourceKeys: ["database"],
        retrySafe: true,
        schedule: { intervalMs: 60_000, kind: "interval" },
        timeoutMs: 30_000,
        updatedAtMs: timestampMs,
        version: 1,
    };
}

function queueSummary(workers: readonly JobWorkerSummary[] = []): JobQueueSummary {
    return {
        activeResourceClasses: [],
        control: { claimingPaused: false, updatedAtMs: timestampMs, version: 1 },
        oldestQueuedAtMs: timestampMs - 1000,
        stateCounts: {
            cancelled: 0,
            failed: 0,
            queued: 2,
            running: 0,
            succeeded: 0,
            "timed-out": 0,
        },
        workers: [...workers],
    };
}

function onlineWorker(): JobWorkerSummary {
    return {
        activeRunCount: 0,
        capacity: 1,
        heartbeatAtMs: timestampMs,
        id: "019fdf50-0000-7000-8000-000000000004",
        releaseId: "a".repeat(40),
        startedAtMs: timestampMs - 10_000,
        state: "online",
    };
}

interface QueryCall {
    readonly input: unknown;
    readonly path: string;
    readonly signal: AbortSignal | undefined;
}

class JobQueryTransport implements DashboardTrpcTransport {
    readonly calls: QueryCall[] = [];
    readonly #outputs: Readonly<Record<string, readonly unknown[]>>;

    constructor(outputs: Readonly<Record<string, readonly unknown[]>>) {
        this.#outputs = outputs;
    }

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, input?: unknown, options?: TRPCRequestOptions): Promise<unknown> {
        const callIndex = this.calls.filter((call) => call.path === path).length;
        this.calls.push({ input, path, signal: options?.signal });
        const output = this.#outputs[path]?.[callIndex];
        if (output === undefined) {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
    }
}

describe("jobs browser queries", () => {
    test("refreshes the mounted queue summary so idle stale workers expire", async () => {
        jest.useFakeTimers();
        const worker = onlineWorker();
        const transport = new JobQueryTransport({
            "jobs.listRuns": [
                { runs: [], summary: queueSummary([worker]) },
                { runs: [], summary: queueSummary() },
            ],
        });
        const queryClient = createDashboardQueryClient();
        const observer = new QueryObserver(
            queryClient,
            jobQueueSummaryQueryOptions(createDashboardTrpcClient(transport))
        );
        const firstResult = Promise.withResolvers<void>();
        const refreshedResult = Promise.withResolvers<void>();
        const unsubscribe = observer.subscribe((result) => {
            if (!result.isSuccess) return;
            const workers = result.data.workers;
            if (workers?.[0]?.id === worker.id) firstResult.resolve();
            if (workers?.length === 0 && transport.calls.length === 2) {
                refreshedResult.resolve();
            }
        });

        try {
            await firstResult.promise;
            expect(transport.calls).toHaveLength(1);
            jest.advanceTimersByTime(jobQueueSummaryRefreshIntervalMs);
            await refreshedResult.promise;

            expect(transport.calls.map(({ path }) => path)).toEqual([
                "jobs.listRuns",
                "jobs.listRuns",
            ]);
            expect(transport.calls.map(({ input }) => input)).toEqual([
                { limit: 1 },
                { limit: 1 },
            ]);
            expect(observer.getCurrentResult().data?.workers).toEqual([]);
        } finally {
            unsubscribe();
            queryClient.clear();
            jest.useRealTimers();
        }
    });

    test("forwards global run filters, keyset cursors, and cancellation signals", async () => {
        const newest = queuedRun(newestRunId, timestampMs);
        const oldest = queuedRun(oldestRunId, timestampMs - 1000);
        const transport = new JobQueryTransport({
            "jobs.listRuns": [
                {
                    nextCursor: { id: newest.id, queuedAtMs: newest.queuedAtMs },
                    runs: [newest],
                    summary: queueSummary(),
                },
                { runs: [oldest], summary: queueSummary() },
            ],
        });
        const queryClient = createDashboardQueryClient();

        try {
            await queryClient.fetchInfiniteQuery({
                ...jobRunListQueryOptions(createDashboardTrpcClient(transport), {
                    resourceClasses: ["light"],
                    states: ["queued"],
                    triggerTypes: ["manual"],
                }),
                pages: 2,
            });

            expect(transport.calls.map(({ input, path }) => ({ input, path }))).toEqual([
                {
                    input: {
                        filters: {
                            resourceClasses: ["light"],
                            states: ["queued"],
                            triggerTypes: ["manual"],
                        },
                        limit: 100,
                    },
                    path: "jobs.listRuns",
                },
                {
                    input: {
                        cursor: { id: newest.id, queuedAtMs: newest.queuedAtMs },
                        filters: {
                            resourceClasses: ["light"],
                            states: ["queued"],
                            triggerTypes: ["manual"],
                        },
                        limit: 100,
                    },
                    path: "jobs.listRuns",
                },
            ]);
            expect(
                transport.calls.every(({ signal }) => signal instanceof AbortSignal)
            ).toBeTrue();
        } finally {
            queryClient.clear();
        }
    });

    test("paginates schedule inventory and schedule-scoped run history independently", async () => {
        const firstSchedule = schedule("alpha", false);
        const secondSchedule = schedule(scheduleId);
        const newest = queuedRun(newestRunId, timestampMs);
        const oldest = queuedRun(oldestRunId, timestampMs - 1000);
        const transport = new JobQueryTransport({
            "schedules.list": [
                {
                    nextCursor: { id: firstSchedule.id },
                    schedules: [firstSchedule],
                },
                { schedules: [secondSchedule] },
            ],
            "schedules.listRuns": [
                {
                    nextCursor: { id: newest.id, queuedAtMs: newest.queuedAtMs },
                    runs: [newest],
                },
                { runs: [oldest] },
            ],
        });
        const queryClient = createDashboardQueryClient();
        const client = createDashboardTrpcClient(transport);

        try {
            await queryClient.fetchInfiniteQuery({
                ...scheduleListQueryOptions(client, "all"),
                pages: 2,
            });
            await queryClient.fetchInfiniteQuery({
                ...scheduleRunListQueryOptions(client, scheduleId),
                pages: 2,
            });

            expect(transport.calls.map(({ input, path }) => ({ input, path }))).toEqual([
                {
                    input: { enabled: "all", limit: 100 },
                    path: "schedules.list",
                },
                {
                    input: {
                        cursor: { id: firstSchedule.id },
                        enabled: "all",
                        limit: 100,
                    },
                    path: "schedules.list",
                },
                {
                    input: { id: scheduleId, limit: 100 },
                    path: "schedules.listRuns",
                },
                {
                    input: {
                        cursor: { id: newest.id, queuedAtMs: newest.queuedAtMs },
                        id: scheduleId,
                        limit: 100,
                    },
                    path: "schedules.listRuns",
                },
            ]);
        } finally {
            queryClient.clear();
        }
    });

    test("loads exact run and schedule details without depending on list pages", async () => {
        const run = queuedRun(newestRunId, timestampMs);
        const scheduleRecord = schedule(scheduleId);
        const transport = new JobQueryTransport({
            "jobs.getRun": [
                {
                    events: [
                        {
                            attempt: 0,
                            kind: "queued",
                            occurredAtMs: timestampMs,
                            sequence: 1,
                        },
                    ],
                    run,
                },
            ],
            "schedules.get": [scheduleRecord],
        });
        const queryClient = createDashboardQueryClient();
        const client = createDashboardTrpcClient(transport);

        try {
            const runDetail = await queryClient.fetchQuery(
                jobRunDetailQueryOptions(client, run.id)
            );
            const exactSchedule = await queryClient.fetchQuery(
                scheduleDetailQueryOptions(client, scheduleId)
            );
            expect(runDetail.run.id).toBe(run.id);
            expect(exactSchedule.id).toBe(scheduleId);
            expect(transport.calls.map(({ input, path }) => ({ input, path }))).toEqual([
                {
                    input: { eventLimit: 100, id: run.id },
                    path: "jobs.getRun",
                },
                { input: { id: scheduleId }, path: "schedules.get" },
            ]);
        } finally {
            queryClient.clear();
        }
    });

    test("pages and deduplicates older events outside the exact detail cache", async () => {
        const run = { ...queuedRun(newestRunId, timestampMs), eventCount: 4 };
        const exactDetail = {
            events: [
                {
                    attempt: 0,
                    kind: "queued" as const,
                    occurredAtMs: timestampMs,
                    sequence: 4,
                },
            ],
            nextEventCursor: { sequence: 4 },
            run,
        };
        const transport = new JobQueryTransport({
            "jobs.getRun": [
                exactDetail,
                {
                    events: [
                        {
                            attempt: 0,
                            kind: "queued",
                            occurredAtMs: timestampMs - 1,
                            sequence: 3,
                        },
                    ],
                    nextEventCursor: { sequence: 3 },
                    run,
                },
                {
                    events: [
                        {
                            attempt: 0,
                            kind: "queued",
                            occurredAtMs: timestampMs - 2,
                            sequence: 2,
                        },
                    ],
                    run,
                },
            ],
        });
        const queryClient = createDashboardQueryClient();
        const client = createDashboardTrpcClient(transport);

        try {
            const detail = await queryClient.fetchQuery(
                jobRunDetailQueryOptions(client, run.id)
            );
            const history = await queryClient.fetchInfiniteQuery({
                ...jobRunEventHistoryQueryOptions(client, run.id, detail.nextEventCursor),
                pages: 2,
            });
            const duplicate = history.pages[0]?.events[0];
            if (duplicate === undefined) throw new TypeError("Missing history event");
            const events = uniqueJobRunEvents([
                ...detail.events,
                ...history.pages.flatMap((page) => page.events),
                duplicate,
            ]);

            expect(events.map(({ sequence }) => sequence)).toEqual([4, 3, 2]);
            expect(transport.calls.map(({ input }) => input)).toEqual([
                { eventLimit: 100, id: run.id },
                {
                    eventCursor: { sequence: 4 },
                    eventLimit: 100,
                    id: run.id,
                },
                {
                    eventCursor: { sequence: 3 },
                    eventLimit: 100,
                    id: run.id,
                },
            ]);
        } finally {
            queryClient.clear();
        }
    });

    test("bridges a multi-page realtime event gap to the nearest known sequence", async () => {
        const run = { ...queuedRun(newestRunId, timestampMs), eventCount: 602 };
        const eventPage = (
            newestSequence: number,
            count: number,
            nextSequence: number
        ) => ({
            events: Array.from({ length: count }, (_, index) => ({
                attempt: 0,
                kind: "queued" as const,
                occurredAtMs: timestampMs + newestSequence - index,
                sequence: newestSequence - index,
            })),
            nextEventCursor: { sequence: nextSequence },
            run,
        });
        const transport = new JobQueryTransport({
            "jobs.getRun": [
                eventPage(302, 100, 203),
                eventPage(202, 100, 103),
                eventPage(502, 100, 403),
            ],
        });
        const queryClient = createDashboardQueryClient();
        const client = createDashboardTrpcClient(transport);
        const request = {
            cursor: { sequence: 303 },
            knownSequence: 102,
        };

        try {
            const gap = await queryClient.fetchQuery(
                jobRunEventGapQueryOptions(client, run.id, request)
            );

            expect(gap.events).toHaveLength(200);
            expect(gap.events.at(0)?.sequence).toBe(302);
            expect(gap.events.at(-1)?.sequence).toBe(103);
            const nextRequest = {
                cursor: { sequence: 503 },
                knownSequence: 402,
            };
            await queryClient.invalidateQueries({
                exact: true,
                queryKey: jobRunEventGapQueryKey(run.id),
            });
            await queryClient.fetchQuery(
                jobRunEventGapQueryOptions(client, run.id, nextRequest)
            );
            const accumulatedGap = queryClient.getQueryData<{
                readonly events: readonly { readonly sequence: number }[];
            }>(jobRunEventGapQueryKey(run.id));
            if (accumulatedGap === undefined) {
                throw new TypeError("Missing accumulated event gap");
            }
            expect(accumulatedGap.events).toHaveLength(300);
            expect(accumulatedGap.events.at(0)?.sequence).toBe(502);
            expect(accumulatedGap.events.at(-1)?.sequence).toBe(103);
            expect(transport.calls.map(({ input }) => input)).toEqual([
                {
                    eventCursor: { sequence: 303 },
                    eventLimit: 100,
                    id: run.id,
                },
                {
                    eventCursor: { sequence: 203 },
                    eventLimit: 100,
                    id: run.id,
                },
                {
                    eventCursor: { sequence: 503 },
                    eventLimit: 100,
                    id: run.id,
                },
            ]);
            expect(
                jobRunEventGapQueryOptions(client, run.id, nextRequest).queryKey
            ).toEqual(jobRunEventGapQueryKey(run.id));
        } finally {
            queryClient.clear();
        }
    });

    test("retains immutable event history across a short observer teardown", async () => {
        const run = { ...queuedRun(newestRunId, timestampMs), eventCount: 2 };
        const historyPage = {
            events: [
                {
                    attempt: 0,
                    kind: "queued" as const,
                    occurredAtMs: timestampMs - 1,
                    sequence: 1,
                },
            ],
            run,
        };
        const transport = new JobQueryTransport({
            "jobs.getRun": [historyPage, historyPage],
        });
        const queryClient = createDashboardQueryClient();
        const options = jobRunEventHistoryQueryOptions(
            createDashboardTrpcClient(transport),
            run.id,
            { sequence: 2 }
        );
        const firstObserver = new InfiniteQueryObserver(queryClient, options);
        const loaded = Promise.withResolvers<void>();
        const unsubscribeFirst = firstObserver.subscribe((result) => {
            if (result.isSuccess) loaded.resolve();
        });

        try {
            await loaded.promise;
            unsubscribeFirst();
            await new Promise<void>((resolve) => setTimeout(resolve, 0));

            expect(queryClient.getQueryData(options.queryKey)).toBeDefined();
            const restoredObserver = new InfiniteQueryObserver(queryClient, options);
            const unsubscribeRestored = restoredObserver.subscribe(() => {});
            try {
                expect(restoredObserver.getCurrentResult().data?.pages).toEqual([
                    historyPage,
                ]);
                await Promise.resolve();
                expect(transport.calls).toHaveLength(1);
            } finally {
                unsubscribeRestored();
            }
        } finally {
            unsubscribeFirst();
            queryClient.clear();
        }
    });

    test("retains cached exact detail when an older event page fails", async () => {
        const run = { ...queuedRun(newestRunId, timestampMs), eventCount: 2 };
        const exactDetail = {
            events: [
                {
                    attempt: 0,
                    kind: "queued" as const,
                    occurredAtMs: timestampMs,
                    sequence: 2,
                },
            ],
            nextEventCursor: { sequence: 2 },
            run,
        };
        const transport = new JobQueryTransport({
            "jobs.getRun": [exactDetail, new TypeError("history unavailable")],
        });
        const queryClient = createDashboardQueryClient();
        const client = createDashboardTrpcClient(transport);

        try {
            const detail = await queryClient.fetchQuery(
                jobRunDetailQueryOptions(client, run.id)
            );
            const failure = await queryClient
                .fetchInfiniteQuery({
                    ...jobRunEventHistoryQueryOptions(
                        client,
                        run.id,
                        detail.nextEventCursor
                    ),
                    retry: false,
                })
                .catch((error: unknown) => error);

            expect(failure).toBeInstanceOf(TypeError);
            expect(
                queryClient.getQueryData(
                    jobRunDetailQueryOptions(client, run.id).queryKey
                )
            ).toEqual(exactDetail);
        } finally {
            queryClient.clear();
        }
    });

    test("deduplicates overlapping pages and invalidates only the requested root", async () => {
        const run = queuedRun(newestRunId, timestampMs);
        expect(
            uniqueJobRows([run, run, queuedRun(oldestRunId, timestampMs - 1)])
        ).toEqual([run, queuedRun(oldestRunId, timestampMs - 1)]);

        const queryClient = createDashboardQueryClient();
        const jobKey = ["jobs", "runs", "detail", newestRunId] as const;
        const eventHistoryKey = jobRunEventHistoryQueryKey(newestRunId);
        const scheduleKey = ["schedules", "detail", scheduleId] as const;
        queryClient.setQueryData(jobKey, { run });
        queryClient.setQueryData(eventHistoryKey, { pages: [] });
        queryClient.setQueryData(scheduleKey, schedule(scheduleId));
        try {
            await refreshJobQueries(queryClient);
            expect(queryClient.getQueryState(jobKey)?.isInvalidated).toBeTrue();
            expect(queryClient.getQueryState(eventHistoryKey)?.isInvalidated).toBeFalse();
            expect(queryClient.getQueryState(scheduleKey)?.isInvalidated).toBeFalse();

            await refreshScheduleQueries(queryClient);
            expect(queryClient.getQueryState(scheduleKey)?.isInvalidated).toBeTrue();
        } finally {
            queryClient.clear();
        }
    });
});
