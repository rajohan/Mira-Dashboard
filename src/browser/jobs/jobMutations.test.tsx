import { describe, expect, test } from "bun:test";

import { QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import type { TRPCRequestOptions } from "@trpc/client";
import { act, type ReactNode } from "react";
import * as v from "valibot";

import type { AuthStatus } from "../../contracts/auth.ts";
import type {
    JobRunSummary,
    JobWorkerControl,
    ScheduleSummary,
} from "../../contracts/jobModel.ts";
import {
    jobQueueSummaryIsConsistent,
    type ListJobRunsResult,
} from "../../contracts/jobs.ts";
import { runScheduleInputSchema } from "../../contracts/schedules.ts";
import { liveHistoryArchiveQueryKey } from "../api/liveHistory.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import {
    createScheduleRunIdempotencyKey,
    patchJobRunInCachedQueries,
    patchJobWorkerControlInCachedQueries,
    patchScheduleInCachedQueries,
    removeJobRunFromCachedQueries,
    removeScheduleFromCachedQueries,
    useRunScheduleMutation,
    useUpdateScheduleMutation,
} from "./jobMutations.ts";
import {
    jobRunDetailQueryKey,
    jobRunEventGapQueryKey,
    jobRunEventHistoryQueryKey,
    jobRunListQueryKey,
    jobQueueSummaryQueryKey,
    scheduleDetailQueryKey,
    scheduleListQueryKey,
    scheduleRunListQueryKey,
} from "./jobQueries.ts";

const { renderHook } = await import("@testing-library/react");
const scheduleId = "system.worker-smoke";
const runId = "019fdf70-0000-7000-8000-000000000002";
const nextRunId = "019fdf80-0000-7000-8000-000000000003";
const newestRunId = "019fdf90-0000-7000-8000-000000000004";
const timestampMs = 1_800_000_000_000;

function authenticatedStatus(): Extract<AuthStatus, { state: "authenticated" }> {
    return {
        session: {
            authenticatedAtMs: timestampMs,
            authMethod: "password",
            createdAtMs: timestampMs,
            expiresAtMs: timestampMs + 86_400_000,
            id: "a".repeat(32),
            isCurrent: true,
            lastSeenAtMs: timestampMs,
        },
        state: "authenticated",
        user: {
            id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
            username: "operator",
        },
    };
}

function queuedRun(id = runId, queuedAtMs = timestampMs): JobRunSummary {
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

function cancelledRun(id = runId, queuedAtMs = timestampMs): JobRunSummary {
    return {
        ...queuedRun(id, queuedAtMs),
        eventCount: 2,
        finishedAtMs: queuedAtMs + 1000,
        state: "cancelled",
        stateVersion: 2,
        terminalCode: "operator-cancelled",
        terminalMessage: "Cancelled by the operator.",
        updatedAtMs: queuedAtMs + 1000,
    };
}

function runningRun(): JobRunSummary {
    return {
        ...queuedRun(),
        attemptCount: 1,
        eventCount: 2,
        firstStartedAtMs: timestampMs + 1000,
        lastAttemptStartedAtMs: timestampMs + 1000,
        state: "running",
        stateVersion: 2,
        updatedAtMs: timestampMs + 1000,
    };
}

function succeededRun(): JobRunSummary {
    return {
        ...runningRun(),
        eventCount: 3,
        finishedAtMs: timestampMs + 2000,
        state: "succeeded",
        stateVersion: 3,
        updatedAtMs: timestampMs + 2000,
    };
}

function schedule(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
    const run = queuedRun();
    return {
        actionKey: scheduleId,
        activeRun: run,
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        createdAtMs: timestampMs - 10_000,
        description: "Checks the worker without host mutation.",
        enabled: true,
        id: scheduleId,
        latestRun: run,
        manualRunAvailable: true,
        name: "Worker smoke",
        nextRunAtMs: timestampMs + 60_000,
        priority: 0,
        resourceClass: "light",
        resourceKeys: ["database"],
        retrySafe: true,
        schedule: { intervalMs: 60_000, kind: "interval" },
        timeoutMs: 30_000,
        updatedAtMs: timestampMs,
        version: 1,
        ...overrides,
    };
}

function queueSummary(): ListJobRunsResult["summary"] {
    return {
        activeResourceClasses: [],
        control: { claimingPaused: false, updatedAtMs: timestampMs, version: 1 },
        oldestQueuedAtMs: timestampMs,
        stateCounts: {
            cancelled: 0,
            failed: 0,
            queued: 1,
            running: 0,
            succeeded: 0,
            "timed-out": 0,
        },
        workers: [],
    };
}

function runningQueueSummary(): ListJobRunsResult["summary"] {
    return {
        activeResourceClasses: ["light"],
        control: { claimingPaused: false, updatedAtMs: timestampMs, version: 1 },
        stateCounts: {
            cancelled: 0,
            failed: 0,
            queued: 0,
            running: 1,
            succeeded: 0,
            "timed-out": 0,
        },
        workers: [
            {
                activeRunCount: 1,
                capacity: 1,
                heartbeatAtMs: timestampMs + 1000,
                id: "019fdf60-0000-7000-8000-000000000001",
                releaseId: "a".repeat(40),
                startedAtMs: timestampMs,
                state: "online",
            },
        ],
    };
}

interface MutationCall {
    readonly input: unknown;
    readonly path: string;
    readonly signal: AbortSignal | undefined;
}

class JobMutationTransport implements DashboardTrpcTransport {
    readonly calls: MutationCall[] = [];
    readonly #outputs: unknown[];

    constructor(outputs: unknown[]) {
        this.#outputs = outputs;
    }

    mutation(
        path: string,
        input?: unknown,
        options?: TRPCRequestOptions
    ): Promise<unknown> {
        const output = this.#outputs[this.calls.length];
        this.calls.push({ input, path, signal: options?.signal });
        return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
    }

    query(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected query: ${path}`));
    }
}

describe("jobs browser mutations", () => {
    test("patches materialized run, schedule, and worker projections before refresh", () => {
        const queryClient = createDashboardQueryClient();
        const queued = queuedRun();
        const scheduleRecord = schedule();
        const globalKey = liveHistoryArchiveQueryKey(jobRunListQueryKey(undefined));
        const queuedFilterKey = liveHistoryArchiveQueryKey(
            jobRunListQueryKey({ states: ["queued"] })
        );
        const cancelledFilterKey = liveHistoryArchiveQueryKey(
            jobRunListQueryKey({ states: ["cancelled"] })
        );
        const scheduleRunsKey = liveHistoryArchiveQueryKey(
            scheduleRunListQueryKey(scheduleId)
        );
        const eventHistoryKey = jobRunEventHistoryQueryKey(runId);
        const enabledSchedulesKey = scheduleListQueryKey("enabled");
        const disabledSchedulesKey = scheduleListQueryKey("disabled");
        const listData = {
            pageParams: [undefined],
            pages: [{ runs: [queued], summary: queueSummary() }],
        };
        queryClient.setQueryData(globalKey, listData);
        queryClient.setQueryData(jobQueueSummaryQueryKey, listData.pages[0]);
        queryClient.setQueryData(queuedFilterKey, listData);
        queryClient.setQueryData(cancelledFilterKey, {
            pageParams: [undefined],
            pages: [{ runs: [], summary: queueSummary() }],
        });
        queryClient.setQueryData(scheduleRunsKey, {
            pageParams: [undefined],
            pages: [{ runs: [queued] }],
        });
        queryClient.setQueryData(jobRunDetailQueryKey(runId), {
            events: [],
            run: queued,
        });
        queryClient.setQueryData(eventHistoryKey, {
            pageParams: [{ sequence: 1 }],
            pages: [{ events: [], run: queued }],
        });
        queryClient.setQueryData(scheduleDetailQueryKey(scheduleId), scheduleRecord);
        queryClient.setQueryData(enabledSchedulesKey, {
            pageParams: [undefined],
            pages: [{ schedules: [scheduleRecord] }],
        });
        queryClient.setQueryData(disabledSchedulesKey, {
            pageParams: [undefined],
            pages: [{ schedules: [] }],
        });

        try {
            const cancelled = cancelledRun();
            patchJobRunInCachedQueries(queryClient, cancelled);

            expect(
                queryClient.getQueryData<typeof listData>(globalKey)?.pages[0]
            ).toMatchObject({
                runs: [cancelled],
                summary: {
                    stateCounts: { cancelled: 0, queued: 1 },
                },
            });
            expect(
                queryClient.getQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey)?.runs
            ).toEqual([cancelled]);
            expect(
                queryClient.getQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey)
                    ?.summary.stateCounts
            ).toMatchObject({ cancelled: 0, queued: 1 });
            expect(
                queryClient.getQueryData<typeof listData>(queuedFilterKey)?.pages[0]?.runs
            ).toEqual([]);
            expect(
                queryClient.getQueryData<typeof listData>(cancelledFilterKey)?.pages[0]
                    ?.runs
            ).toEqual([]);
            expect(
                queryClient.getQueryData<{ run: JobRunSummary }>(
                    jobRunDetailQueryKey(runId)
                )?.run
            ).toEqual(cancelled);
            expect(
                queryClient.getQueryData<{
                    pages: { run: JobRunSummary }[];
                }>(eventHistoryKey)?.pages[0]?.run
            ).toEqual(cancelled);
            expect(
                queryClient.getQueryData<ScheduleSummary>(
                    scheduleDetailQueryKey(scheduleId)
                )
            ).toMatchObject({ latestRun: cancelled });
            expect(
                queryClient.getQueryData<ScheduleSummary>(
                    scheduleDetailQueryKey(scheduleId)
                )?.activeRun
            ).toBeUndefined();

            const control: JobWorkerControl = {
                claimingPaused: true,
                updatedAtMs: timestampMs + 2000,
                version: 2,
            };
            patchJobWorkerControlInCachedQueries(queryClient, control);
            expect(
                queryClient.getQueryData<typeof listData>(globalKey)?.pages[0]?.summary
                    .control
            ).toEqual(control);
            expect(
                queryClient.getQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey)
                    ?.summary.control
            ).toEqual(control);

            const disabled = schedule({
                activeDisableIntent: {
                    createdAtMs: timestampMs + 3000,
                    id: "019fdf90-0000-7000-8000-000000000004",
                    reason: "Maintenance",
                },
                activeRun: undefined,
                enabled: false,
                latestRun: cancelled,
                nextRunAtMs: undefined,
                updatedAtMs: timestampMs + 3000,
                version: 2,
            });
            patchScheduleInCachedQueries(queryClient, disabled);
            expect(
                queryClient.getQueryData<{ pages: { schedules: ScheduleSummary[] }[] }>(
                    enabledSchedulesKey
                )?.pages[0]?.schedules
            ).toEqual([]);
            expect(
                queryClient.getQueryData<{ pages: { schedules: ScheduleSummary[] }[] }>(
                    disabledSchedulesKey
                )?.pages[0]?.schedules
            ).toEqual([]);
            expect(
                queryClient.getQueryData<ScheduleSummary>(
                    scheduleDetailQueryKey(scheduleId)
                )
            ).toEqual(disabled);
        } finally {
            queryClient.clear();
        }
    });

    test("keeps newer realtime snapshots over delayed mutation responses", () => {
        const queryClient = createDashboardQueryClient();
        const currentRun = {
            ...succeededRun(),
            eventCount: 4,
            stateVersion: 4,
            updatedAtMs: timestampMs + 3000,
        };
        const currentControl: JobWorkerControl = {
            claimingPaused: true,
            updatedAtMs: timestampMs + 3000,
            version: 3,
        };
        const currentSummary: ListJobRunsResult["summary"] = {
            activeResourceClasses: [],
            control: currentControl,
            stateCounts: {
                cancelled: 0,
                failed: 0,
                queued: 0,
                running: 0,
                succeeded: 1,
                "timed-out": 0,
            },
            workers: [],
        };
        const currentSchedule = schedule({
            activeRun: undefined,
            latestRun: currentRun,
            updatedAtMs: timestampMs + 3000,
            version: 3,
        });
        const globalKey = liveHistoryArchiveQueryKey(jobRunListQueryKey(undefined));
        const eventHistoryKey = jobRunEventHistoryQueryKey(runId);
        const scheduleRunsKey = liveHistoryArchiveQueryKey(
            scheduleRunListQueryKey(scheduleId)
        );
        const schedulesKey = scheduleListQueryKey("all");
        queryClient.setQueryData(globalKey, {
            pageParams: [undefined],
            pages: [{ runs: [currentRun], summary: currentSummary }],
        });
        queryClient.setQueryData(jobQueueSummaryQueryKey, {
            runs: [currentRun],
            summary: currentSummary,
        });
        queryClient.setQueryData(jobRunDetailQueryKey(runId), {
            events: [],
            result: { status: "ok" },
            run: currentRun,
        });
        queryClient.setQueryData(eventHistoryKey, {
            pageParams: [{ sequence: 1 }],
            pages: [{ events: [], result: { status: "ok" }, run: currentRun }],
        });
        queryClient.setQueryData(scheduleRunsKey, {
            pageParams: [undefined],
            pages: [{ runs: [currentRun] }],
        });
        queryClient.setQueryData(scheduleDetailQueryKey(scheduleId), currentSchedule);
        queryClient.setQueryData(schedulesKey, {
            pageParams: [undefined],
            pages: [{ schedules: [currentSchedule] }],
        });

        try {
            const delayedRuns = [
                {
                    ...currentRun,
                    eventCount: currentRun.eventCount + 1,
                    stateVersion: currentRun.stateVersion - 1,
                    updatedAtMs: currentRun.updatedAtMs + 1000,
                },
                {
                    ...currentRun,
                    eventCount: currentRun.eventCount - 1,
                    stateVersion: currentRun.stateVersion + 1,
                    updatedAtMs: currentRun.updatedAtMs + 1000,
                },
                {
                    ...currentRun,
                    eventCount: currentRun.eventCount + 1,
                    stateVersion: currentRun.stateVersion + 1,
                    updatedAtMs: currentRun.updatedAtMs - 1000,
                },
            ];
            for (const delayed of delayedRuns) {
                patchJobRunInCachedQueries(queryClient, delayed);
            }

            const staleByVersion = schedule({
                activeRun: undefined,
                description: "Stale version",
                latestRun: cancelledRun(),
                updatedAtMs: timestampMs + 4000,
                version: 2,
            });
            const staleByTimestamp = schedule({
                activeRun: undefined,
                description: "Stale timestamp",
                latestRun: cancelledRun(),
                updatedAtMs: timestampMs + 2000,
                version: 4,
            });
            patchScheduleInCachedQueries(queryClient, staleByVersion);
            patchScheduleInCachedQueries(queryClient, staleByTimestamp);
            patchJobWorkerControlInCachedQueries(queryClient, {
                claimingPaused: false,
                updatedAtMs: timestampMs + 4000,
                version: 2,
            });

            expect(
                queryClient.getQueryData<{
                    pages: { runs: JobRunSummary[] }[];
                }>(globalKey)?.pages[0]?.runs
            ).toEqual([currentRun]);
            expect(
                queryClient.getQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey)?.runs
            ).toEqual([currentRun]);
            expect(
                queryClient.getQueryData<{ run: JobRunSummary }>(
                    jobRunDetailQueryKey(runId)
                )?.run
            ).toEqual(currentRun);
            expect(
                queryClient.getQueryData<{
                    pages: { run: JobRunSummary }[];
                }>(eventHistoryKey)?.pages[0]?.run
            ).toEqual(currentRun);
            expect(
                queryClient.getQueryData<{
                    pages: { runs: JobRunSummary[] }[];
                }>(scheduleRunsKey)?.pages[0]?.runs
            ).toEqual([currentRun]);
            expect(
                queryClient.getQueryData<ScheduleSummary>(
                    scheduleDetailQueryKey(scheduleId)
                )
            ).toEqual(currentSchedule);
            expect(
                queryClient.getQueryData<{
                    pages: { schedules: ScheduleSummary[] }[];
                }>(schedulesKey)?.pages[0]?.schedules
            ).toEqual([currentSchedule]);
            expect(
                queryClient.getQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey)
                    ?.summary.control
            ).toEqual(currentControl);
            expect(
                queryClient.getQueryData<{
                    pages: { summary: ListJobRunsResult["summary"] }[];
                }>(globalKey)?.pages[0]?.summary.control
            ).toEqual(currentControl);

            const nextControl: JobWorkerControl = {
                claimingPaused: false,
                updatedAtMs: timestampMs + 2000,
                version: 4,
            };
            patchJobWorkerControlInCachedQueries(queryClient, nextControl);
            expect(
                queryClient.getQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey)
                    ?.summary.control
            ).toEqual(nextControl);
            expect(
                queryClient.getQueryData<{
                    pages: { summary: ListJobRunsResult["summary"] }[];
                }>(globalKey)?.pages[0]?.summary.control
            ).toEqual(nextControl);
        } finally {
            queryClient.clear();
        }
    });

    test("keeps an advanced due cursor after a delayed update response and failed refresh", async () => {
        const updateResponse = Promise.withResolvers<ScheduleSummary>();
        const responseCursor = timestampMs + 120_000;
        const advancedCursor = timestampMs + 240_000;
        const updateTimestamp = timestampMs + 1000;
        const delayedResponse = schedule({
            activeRun: undefined,
            latestRun: undefined,
            nextRunAtMs: responseCursor,
            schedule: { intervalMs: 120_000, kind: "interval" },
            updatedAtMs: updateTimestamp,
            version: 2,
        });
        const scheduledRun: JobRunSummary = {
            ...queuedRun(nextRunId, responseCursor),
            scheduledForAtMs: responseCursor,
            scheduledJobVersion: 2,
            triggerType: "schedule",
        };
        const advancedSnapshot = schedule({
            activeRun: scheduledRun,
            latestRun: scheduledRun,
            nextRunAtMs: advancedCursor,
            schedule: { intervalMs: 120_000, kind: "interval" },
            updatedAtMs: updateTimestamp,
            version: 2,
        });
        const transport = new JobMutationTransport([updateResponse.promise]);
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryData(authStatusQueryKey, authenticatedStatus());
        const detailKey = scheduleDetailQueryKey(scheduleId);
        const listKey = scheduleListQueryKey("all");
        queryClient.setQueryData(detailKey, advancedSnapshot);
        queryClient.setQueryData(listKey, {
            pageParams: [undefined],
            pages: [{ schedules: [advancedSnapshot] }],
        });
        let refreshAttempts = 0;
        const refreshFailed = Promise.withResolvers<void>();
        const observer = new QueryObserver(queryClient, {
            queryFn: () => {
                refreshAttempts += 1;
                return Promise.reject(new TypeError("schedule refresh unavailable"));
            },
            queryKey: detailKey,
            retry: false,
            staleTime: Number.POSITIVE_INFINITY,
        });
        const unsubscribe = observer.subscribe((result) => {
            if (result.isError && result.data !== undefined) refreshFailed.resolve();
        });
        const client = createDashboardTrpcClient(transport);
        const rendered = renderHook(() => useUpdateScheduleMutation(), {
            wrapper: ({ children }: { readonly children: ReactNode }) => (
                <QueryClientProvider client={queryClient}>
                    <DashboardTrpcProvider client={client}>
                        {children}
                    </DashboardTrpcProvider>
                </QueryClientProvider>
            ),
        });

        try {
            const mutation = rendered.result.current.mutateAsync({
                expectedVersion: 1,
                id: scheduleId,
                patch: { schedule: { intervalMs: 120_000, kind: "interval" } },
            });
            updateResponse.resolve(delayedResponse);
            await act(async () => {
                await mutation;
            });
            await refreshFailed.promise;

            expect(refreshAttempts).toBe(1);
            expect(queryClient.getQueryData<ScheduleSummary>(detailKey)).toEqual(
                advancedSnapshot
            );
            expect(
                queryClient.getQueryData<{
                    pages: { schedules: ScheduleSummary[] }[];
                }>(listKey)?.pages[0]?.schedules
            ).toEqual([advancedSnapshot]);
            expect(queryClient.getQueryState(detailKey)?.error).toBeInstanceOf(TypeError);
        } finally {
            unsubscribe();
            rendered.unmount();
            queryClient.clear();
        }
    });

    test("patches only materialized replay rows and preserves newer schedule references and cursors", () => {
        const queryClient = createDashboardQueryClient();
        const replayed = cancelledRun();
        const current = queuedRun(nextRunId, timestampMs + 10_000);
        const newer = queuedRun(newestRunId, timestampMs + 20_000);
        const currentSchedule = schedule({
            activeRun: current,
            latestRun: current,
        });
        const firstPageCursor = {
            id: current.id,
            queuedAtMs: current.queuedAtMs,
        };
        const globalKey = liveHistoryArchiveQueryKey(jobRunListQueryKey(undefined));
        const scheduleRunsKey = liveHistoryArchiveQueryKey(
            scheduleRunListQueryKey(scheduleId)
        );
        const schedulesKey = scheduleListQueryKey("all");
        const globalData = {
            pageParams: [undefined, firstPageCursor],
            pages: [
                {
                    nextCursor: firstPageCursor,
                    runs: [current],
                    summary: {
                        ...queueSummary(),
                        oldestQueuedAtMs: current.queuedAtMs,
                    },
                },
                { runs: [queuedRun()], summary: queueSummary() },
            ],
        };
        const scheduleRunData = {
            pageParams: [undefined, firstPageCursor],
            pages: [
                { nextCursor: firstPageCursor, runs: [current] },
                { runs: [queuedRun()] },
            ],
        };
        queryClient.setQueryData(globalKey, globalData);
        queryClient.setQueryData(scheduleRunsKey, scheduleRunData);
        queryClient.setQueryData(scheduleDetailQueryKey(scheduleId), currentSchedule);
        queryClient.setQueryData(schedulesKey, {
            pageParams: [undefined],
            pages: [{ schedules: [currentSchedule] }],
        });

        try {
            patchJobRunInCachedQueries(queryClient, replayed, true);

            const patchedGlobal = queryClient.getQueryData<typeof globalData>(globalKey);
            const patchedScheduleRuns =
                queryClient.getQueryData<typeof scheduleRunData>(scheduleRunsKey);
            expect(patchedGlobal?.pageParams).toEqual(globalData.pageParams);
            expect(patchedGlobal?.pages[0]).toEqual(globalData.pages[0]);
            expect(patchedGlobal?.pages[1]?.runs).toEqual([replayed]);
            expect(patchedScheduleRuns?.pageParams).toEqual(scheduleRunData.pageParams);
            expect(patchedScheduleRuns?.pages[0]).toEqual(scheduleRunData.pages[0]);
            expect(patchedScheduleRuns?.pages[1]?.runs).toEqual([replayed]);
            expect(
                queryClient.getQueryData<ScheduleSummary>(
                    scheduleDetailQueryKey(scheduleId)
                )
            ).toMatchObject({ activeRun: current, latestRun: current });

            patchJobRunInCachedQueries(queryClient, newer, true);

            expect(
                queryClient
                    .getQueryData<typeof globalData>(globalKey)
                    ?.pages.flatMap(({ runs }) => runs)
            ).toEqual([current, replayed]);
            expect(
                queryClient
                    .getQueryData<typeof scheduleRunData>(scheduleRunsKey)
                    ?.pages.flatMap(({ runs }) => runs)
            ).toEqual([current, replayed]);
            expect(
                queryClient.getQueryData<ScheduleSummary>(
                    scheduleDetailQueryKey(scheduleId)
                )
            ).toMatchObject({ activeRun: newer, latestRun: newer });
            expect(
                queryClient.getQueryData<{
                    pages: { schedules: ScheduleSummary[] }[];
                }>(schedulesKey)?.pages[0]?.schedules[0]
            ).toMatchObject({ activeRun: newer, latestRun: newer });
        } finally {
            queryClient.clear();
        }
    });

    test("removes server-missing runs and schedules from every known cache", () => {
        const queryClient = createDashboardQueryClient();
        const run = queuedRun();
        const scheduleRecord = schedule();
        const globalKey = liveHistoryArchiveQueryKey(jobRunListQueryKey(undefined));
        const scheduleRunsKey = liveHistoryArchiveQueryKey(
            scheduleRunListQueryKey(scheduleId)
        );
        const eventGapKey = jobRunEventGapQueryKey(runId);
        const eventHistoryKey = jobRunEventHistoryQueryKey(runId);
        const schedulesKey = scheduleListQueryKey("all");
        queryClient.setQueryData(globalKey, {
            pageParams: [undefined],
            pages: [{ runs: [run], summary: queueSummary() }],
        });
        queryClient.setQueryData(jobQueueSummaryQueryKey, {
            runs: [run],
            summary: queueSummary(),
        });
        queryClient.setQueryData(scheduleRunsKey, {
            pageParams: [undefined],
            pages: [{ runs: [run] }],
        });
        queryClient.setQueryData(jobRunDetailQueryKey(runId), { events: [], run });
        queryClient.setQueryData(eventHistoryKey, {
            pageParams: [{ sequence: 1 }],
            pages: [{ events: [], run }],
        });
        queryClient.setQueryData(eventGapKey, {
            events: [],
            request: { cursor: { sequence: 2 }, knownSequence: 1 },
        });
        queryClient.setQueryData(schedulesKey, {
            pageParams: [undefined],
            pages: [{ schedules: [scheduleRecord] }],
        });
        queryClient.setQueryData(scheduleDetailQueryKey(scheduleId), scheduleRecord);

        try {
            removeJobRunFromCachedQueries(queryClient, runId);
            const cachedGlobal = queryClient.getQueryData<{
                pages: {
                    runs: JobRunSummary[];
                    summary: ReturnType<typeof queueSummary>;
                }[];
            }>(globalKey)?.pages[0];
            expect(cachedGlobal?.runs).toEqual([]);
            expect(cachedGlobal?.summary.stateCounts.queued).toBe(1);
            expect(cachedGlobal?.summary.oldestQueuedAtMs).toBe(timestampMs);
            expect(
                queryClient.getQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey)
                    ?.summary
            ).toEqual(queueSummary());
            expect(queryClient.getQueryData(jobRunDetailQueryKey(runId))).toBeUndefined();
            expect(queryClient.getQueryData(eventHistoryKey)).toBeUndefined();
            expect(queryClient.getQueryData(eventGapKey)).toBeUndefined();
            expect(
                queryClient.getQueryData<ScheduleSummary>(
                    scheduleDetailQueryKey(scheduleId)
                )?.activeRun
            ).toBeUndefined();

            removeScheduleFromCachedQueries(queryClient, scheduleId);
            expect(
                queryClient.getQueryData<{ pages: { schedules: ScheduleSummary[] }[] }>(
                    schedulesKey
                )?.pages[0]?.schedules
            ).toEqual([]);
            expect(
                queryClient.getQueryData(scheduleDetailQueryKey(scheduleId))
            ).toBeUndefined();
            expect(queryClient.getQueryData(scheduleRunsKey)).toBeUndefined();
        } finally {
            queryClient.clear();
        }
    });

    test("does not double-count a replay outside the queue poll's single materialized row", () => {
        const queryClient = createDashboardQueryClient();
        const replayed = queuedRun(nextRunId);
        queryClient.setQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey, {
            runs: [queuedRun()],
            summary: queueSummary(),
        });

        try {
            patchJobRunInCachedQueries(queryClient, replayed, true);

            expect(
                queryClient.getQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey)
                    ?.summary
            ).toMatchObject({
                oldestQueuedAtMs: timestampMs,
                stateCounts: { queued: 1 },
            });
        } finally {
            queryClient.clear();
        }
    });

    test("keeps each queue snapshot independent from a stale detail projection", () => {
        const queryClient = createDashboardQueryClient();
        const running = runningRun();
        const summary = runningQueueSummary();
        queryClient.setQueryData(jobRunDetailQueryKey(runId), {
            events: [],
            run: queuedRun(),
        });
        queryClient.setQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey, {
            runs: [running],
            summary,
        });

        try {
            patchJobRunInCachedQueries(queryClient, running);

            const snapshot = queryClient.getQueryData<ListJobRunsResult>(
                jobQueueSummaryQueryKey
            );
            expect(snapshot?.runs).toEqual([running]);
            expect(snapshot?.summary).toEqual(summary);
            expect(
                snapshot === undefined
                    ? false
                    : jobQueueSummaryIsConsistent(snapshot.summary)
            ).toBeTrue();
        } finally {
            queryClient.clear();
        }
    });

    test("retains coherent server-owned aggregates when a running run settles", () => {
        const queryClient = createDashboardQueryClient();
        const running = runningRun();
        const succeeded = succeededRun();
        const summary = runningQueueSummary();
        queryClient.setQueryData(jobRunDetailQueryKey(runId), {
            events: [],
            run: running,
        });
        queryClient.setQueryData<ListJobRunsResult>(jobQueueSummaryQueryKey, {
            runs: [running],
            summary,
        });

        try {
            patchJobRunInCachedQueries(queryClient, succeeded);

            const snapshot = queryClient.getQueryData<ListJobRunsResult>(
                jobQueueSummaryQueryKey
            );
            expect(snapshot?.runs).toEqual([succeeded]);
            expect(snapshot?.summary).toEqual(summary);
            expect(
                snapshot === undefined
                    ? false
                    : jobQueueSummaryIsConsistent(snapshot.summary)
            ).toBeTrue();
        } finally {
            queryClient.clear();
        }
    });

    test("retains a manual-run key across lost response and refreshed active state", async () => {
        const firstKey = "A".repeat(32);
        const secondKey = "B".repeat(32);
        const generatedKeys = [firstKey, secondKey];
        let generationCount = 0;
        const transport = new JobMutationTransport([
            new TypeError("ambiguous transport failure"),
            queuedRun(),
            queuedRun(nextRunId),
        ]);
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryData(authStatusQueryKey, authenticatedStatus());
        queryClient.setQueryData(jobRunDetailQueryKey(runId), {
            events: [],
            run: queuedRun(),
        });
        queryClient.setQueryData(
            scheduleDetailQueryKey(scheduleId),
            schedule({ activeRun: undefined, latestRun: undefined })
        );
        const client = createDashboardTrpcClient(transport);
        const renderMutation = () =>
            renderHook(
                () =>
                    useRunScheduleMutation(() => {
                        const key = generatedKeys[generationCount];
                        generationCount += 1;
                        if (key === undefined) throw new TypeError("Missing test key");
                        return key;
                    }),
                {
                    wrapper: ({ children }: { readonly children: ReactNode }) => (
                        <QueryClientProvider client={queryClient}>
                            <DashboardTrpcProvider client={client}>
                                {children}
                            </DashboardTrpcProvider>
                        </QueryClientProvider>
                    ),
                }
            );
        let rendered = renderMutation();

        try {
            let firstFailure: unknown;
            await act(async () => {
                firstFailure = await rendered.result.current
                    .mutateAsync({ id: scheduleId })
                    .catch((error: unknown) => error);
            });
            expect(firstFailure).toBeInstanceOf(TypeError);
            expect(rendered.result.current.hasPendingRequest(scheduleId)).toBeTrue();
            expect(
                queryClient.getQueryState(jobRunDetailQueryKey(runId))?.isInvalidated
            ).toBeTrue();
            expect(
                queryClient.getQueryState(scheduleDetailQueryKey(scheduleId))
                    ?.isInvalidated
            ).toBeTrue();
            queryClient.setQueryData(scheduleDetailQueryKey(scheduleId), schedule());
            expect(
                queryClient.getQueryData<ScheduleSummary>(
                    scheduleDetailQueryKey(scheduleId)
                )?.activeRun
            ).toBeDefined();

            rendered.unmount();
            rendered = renderMutation();
            expect(rendered.result.current.hasPendingRequest(scheduleId)).toBeTrue();

            await act(async () => {
                await rendered.result.current.mutateAsync({ id: scheduleId });
            });
            expect(rendered.result.current.hasPendingRequest(scheduleId)).toBeFalse();
            await act(async () => {
                await rendered.result.current.mutateAsync({ id: scheduleId });
            });

            expect(transport.calls.map(({ input }) => input)).toEqual([
                { id: scheduleId, idempotencyKey: firstKey },
                { id: scheduleId, idempotencyKey: firstKey },
                { id: scheduleId, idempotencyKey: secondKey },
            ]);
            expect(
                transport.calls.every(({ signal }) => signal instanceof AbortSignal)
            ).toBeTrue();
            expect(generationCount).toBe(2);
        } finally {
            rendered.unmount();
            queryClient.clear();
        }
    });

    test("creates a contract-shaped random idempotency key", () => {
        const idempotencyKey = createScheduleRunIdempotencyKey();
        expect(idempotencyKey).toMatch(/^[A-Fa-f0-9]{32}$/u);
        expect(
            v.parse(runScheduleInputSchema, { id: scheduleId, idempotencyKey })
                .idempotencyKey
        ).toBe(idempotencyKey);
    });
});
