import { describe, expect, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import type { TRPCRequestOptions } from "@trpc/client";
import { act, type ReactNode } from "react";
import * as v from "valibot";

import type { AuthStatus } from "../../contracts/auth.ts";
import { refreshCacheEntryInputSchema } from "../../contracts/cache.ts";
import type { JobRunSummary, ScheduleSummary } from "../../contracts/jobModel.ts";
import type { ListJobRunsResult } from "../../contracts/jobs.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import {
    authStatusQueryKey,
    resetAuthenticatedBrowserCache,
} from "../auth/authQueries.ts";
import type { DashboardBrowserCollections } from "../data/dashboardCollections.ts";
import {
    jobQueueSummaryQueryKey,
    jobRunDetailQueryKey,
    jobRunListQueryKey,
    scheduleDetailQueryKey,
    scheduleListQueryKey,
} from "../jobs/jobQueries.ts";
import {
    createCacheRefreshIdempotencyKey,
    useRefreshCacheEntryMutation,
} from "./cacheMutations.ts";
import { cacheBrowserFailureMessage } from "./cachePresentation.ts";
import { cacheEntryQueryKey, cacheStatusQueryKey } from "./cacheQueries.ts";

const { renderHook, waitFor } = await import("@testing-library/react");

const cacheKey = "system.host";
const otherCacheKey = "system.metrics";
const scheduleId = "cache.system-host";
const runId = "019fdf70-0000-7000-8000-000000000002";
const nextRunId = "019fdf80-0000-7000-8000-000000000003";
const newestRunId = "019fdf90-0000-7000-8000-000000000004";
const timestampMs = 1_800_000_000_000;

function authenticatedStatus(
    sessionMarker = "a",
    userId = "019fd974-54a2-74dd-a64b-d4186f8d8828"
): Extract<AuthStatus, { state: "authenticated" }> {
    return {
        session: {
            authenticatedAtMs: timestampMs,
            authMethod: "password",
            createdAtMs: timestampMs,
            expiresAtMs: timestampMs + 86_400_000,
            id: sessionMarker.repeat(32),
            isCurrent: true,
            lastSeenAtMs: timestampMs,
        },
        state: "authenticated",
        user: { id: userId, username: `operator-${sessionMarker}` },
    };
}

function queuedRun(id = runId, updatedAtMs = timestampMs): JobRunSummary {
    return {
        actionKey: "cache.refresh.system-host",
        attemptCount: 0,
        attemptLimit: 3,
        availableAtMs: timestampMs,
        cancellationPolicy: "cooperative",
        displayName: "System host cache",
        eventCount: 1,
        id,
        priority: 0,
        queuedAtMs: timestampMs,
        resourceClass: "light",
        resourceKeys: ["cache.system.host"],
        retrySafe: true,
        scheduledJobId: scheduleId,
        scheduledJobVersion: 1,
        state: "queued",
        stateVersion: 1,
        timeoutMs: 30_000,
        triggerType: "manual",
        updatedAtMs,
    };
}

function cacheSchedule(): ScheduleSummary {
    return {
        actionKey: "cache.refresh.system-host",
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        createdAtMs: timestampMs - 10_000,
        description: "Projects bounded host, memory, and root-filesystem status.",
        enabled: true,
        id: scheduleId,
        manualRunAvailable: false,
        name: "System host cache",
        nextRunAtMs: timestampMs + 86_400_000,
        priority: 0,
        resourceClass: "light",
        resourceKeys: ["cache.system.host"],
        retrySafe: true,
        schedule: { intervalMs: 86_400_000, kind: "interval" },
        timeoutMs: 30_000,
        updatedAtMs: timestampMs,
        version: 1,
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

interface MutationCall {
    readonly input: unknown;
    readonly path: string;
    readonly signal: AbortSignal | undefined;
}

class CacheMutationTransport implements DashboardTrpcTransport {
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

function renderRefreshMutation(
    queryClient: ReturnType<typeof createDashboardQueryClient>,
    transport: CacheMutationTransport,
    createIdempotencyKey: () => string
) {
    const client = createDashboardTrpcClient(transport);
    return renderHook(() => useRefreshCacheEntryMutation(createIdempotencyKey), {
        wrapper: ({ children }: { readonly children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>
                <DashboardTrpcProvider client={client}>{children}</DashboardTrpcProvider>
            </QueryClientProvider>
        ),
    });
}

describe("cache browser refresh mutation", () => {
    test("creates a contract-shaped random idempotency key", () => {
        const idempotencyKey = createCacheRefreshIdempotencyKey();

        expect(idempotencyKey).toMatch(/^[A-Fa-f0-9]{32}$/u);
        expect(
            v.parse(refreshCacheEntryInputSchema, {
                idempotencyKey,
                key: cacheKey,
            }).idempotencyKey
        ).toBe(idempotencyKey);
    });

    test("reuses independent lost-response keys and rotates only confirmed entries", async () => {
        const firstError = new TypeError("ambiguous host response");
        const secondError = new TypeError("ambiguous metrics response");
        const transport = new CacheMutationTransport([
            firstError,
            secondError,
            queuedRun(),
            queuedRun(nextRunId),
            queuedRun(newestRunId),
        ]);
        const generatedKeys = ["A".repeat(32), "B".repeat(32), "C".repeat(32)];
        let generationCount = 0;
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryData(authStatusQueryKey, authenticatedStatus());
        const rendered = renderRefreshMutation(queryClient, transport, () => {
            const key = generatedKeys[generationCount];
            generationCount += 1;
            if (key === undefined) throw new TypeError("Missing test key");
            return key;
        });

        try {
            let failure: unknown;
            await act(async () => {
                failure = await rendered.result.current
                    .mutateAsync({ key: cacheKey })
                    .catch((error: unknown) => error);
            });
            expect(failure).toBe(firstError);
            expect(rendered.result.current.hasPendingRequest(cacheKey)).toBeTrue();

            await act(async () => {
                failure = await rendered.result.current
                    .mutateAsync({ key: otherCacheKey })
                    .catch((error: unknown) => error);
            });
            expect(failure).toBe(secondError);
            expect(rendered.result.current.hasPendingRequest(otherCacheKey)).toBeTrue();

            let confirmedRun: JobRunSummary | undefined;
            await act(async () => {
                confirmedRun = await rendered.result.current.mutateAsync({
                    key: cacheKey,
                });
            });
            expect(confirmedRun?.state).toBe("queued");
            expect(rendered.result.current.hasPendingRequest(cacheKey)).toBeFalse();
            expect(rendered.result.current.hasPendingRequest(otherCacheKey)).toBeTrue();

            await act(async () => {
                await rendered.result.current.mutateAsync({ key: otherCacheKey });
            });
            expect(rendered.result.current.hasPendingRequest(otherCacheKey)).toBeFalse();

            await act(async () => {
                await rendered.result.current.mutateAsync({ key: cacheKey });
            });

            expect(transport.calls.map(({ input }) => input)).toEqual([
                { idempotencyKey: generatedKeys[0], key: cacheKey },
                { idempotencyKey: generatedKeys[1], key: otherCacheKey },
                { idempotencyKey: generatedKeys[0], key: cacheKey },
                { idempotencyKey: generatedKeys[1], key: otherCacheKey },
                { idempotencyKey: generatedKeys[2], key: cacheKey },
            ]);
            expect(transport.calls.map(({ path }) => path)).toEqual(
                Array.from({ length: 5 }, () => "cache.refreshEntry")
            );
            expect(
                transport.calls.every(({ signal }) => signal instanceof AbortSignal)
            ).toBeTrue();
            expect(generationCount).toBe(3);
        } finally {
            rendered.unmount();
            queryClient.clear();
        }
    });

    test("preserves ambiguous errors and invalidates retained projections safely", async () => {
        const rawError = new TypeError("private transport detail");
        const transport = new CacheMutationTransport([rawError]);
        const queryClient = createDashboardQueryClient();
        const statusData = {
            entries: [],
            generatedAtMs: timestampMs,
            totalCount: 0,
            truncated: false,
        };
        const entryData = { sentinel: "last-known-good" };
        const jobData = { sentinel: "jobs" };
        const scheduleData = { sentinel: "schedules" };
        const exactCacheKey = cacheEntryQueryKey(cacheKey);
        const jobKey = ["jobs", "retained"] as const;
        const scheduleKey = ["schedules", "retained"] as const;
        queryClient.setQueryData(authStatusQueryKey, authenticatedStatus());
        queryClient.setQueryData(cacheStatusQueryKey, statusData);
        queryClient.setQueryData(exactCacheKey, entryData);
        queryClient.setQueryData(jobKey, jobData);
        queryClient.setQueryData(scheduleKey, scheduleData);
        const rendered = renderRefreshMutation(queryClient, transport, () =>
            "D".repeat(32)
        );

        try {
            let failure: unknown;
            await act(async () => {
                failure = await rendered.result.current
                    .mutateAsync({ key: cacheKey })
                    .catch((error: unknown) => error);
            });

            expect(failure).toBe(rawError);
            await waitFor(() => expect(rendered.result.current.error).toBe(rawError));
            expect(rendered.result.current.failureMessage).toBe(
                cacheBrowserFailureMessage(rawError)
            );
            expect(rendered.result.current.failureMessage).not.toContain(
                rawError.message
            );
            expect(rendered.result.current.hasPendingRequest(cacheKey)).toBeTrue();
            await waitFor(() => {
                expect(
                    queryClient.getQueryState(cacheStatusQueryKey)?.isInvalidated
                ).toBeTrue();
                expect(
                    queryClient.getQueryState(exactCacheKey)?.isInvalidated
                ).toBeTrue();
                expect(queryClient.getQueryState(jobKey)?.isInvalidated).toBeTrue();
                expect(queryClient.getQueryState(scheduleKey)?.isInvalidated).toBeTrue();
            });
            expect(queryClient.getQueryData<typeof statusData>(cacheStatusQueryKey)).toBe(
                statusData
            );
            expect(queryClient.getQueryData<typeof entryData>(exactCacheKey)).toBe(
                entryData
            );
            expect(queryClient.getQueryData<typeof jobData>(jobKey)).toBe(jobData);
            expect(queryClient.getQueryData<typeof scheduleData>(scheduleKey)).toBe(
                scheduleData
            );
        } finally {
            rendered.unmount();
            queryClient.clear();
        }
    });

    test("drops pending keys when the authenticated cache generation rotates", async () => {
        const rawError = new TypeError("ambiguous previous-user response");
        const transport = new CacheMutationTransport([rawError, queuedRun()]);
        const queryClient = createDashboardQueryClient();
        const generatedKeys = ["E".repeat(32), "F".repeat(32)];
        let generationCount = 0;
        const createIdempotencyKey = () => {
            const key = generatedKeys[generationCount];
            generationCount += 1;
            if (key === undefined) throw new TypeError("Missing test key");
            return key;
        };
        const collections = {
            cleanup: () => Promise.resolve(),
            get agents(): DashboardBrowserCollections["agents"] {
                throw new TypeError("Agents collection should not be read");
            },
            get notifications(): DashboardBrowserCollections["notifications"] {
                throw new TypeError("Notification collection should not be read");
            },
            reset: () => Promise.resolve(),
        } satisfies DashboardBrowserCollections;
        queryClient.setQueryData(authStatusQueryKey, authenticatedStatus());
        let rendered = renderRefreshMutation(
            queryClient,
            transport,
            createIdempotencyKey
        );

        try {
            await act(async () => {
                await rendered.result.current
                    .mutateAsync({ key: cacheKey })
                    .catch(() => {});
            });
            expect(rendered.result.current.hasPendingRequest(cacheKey)).toBeTrue();
            rendered.unmount();

            await resetAuthenticatedBrowserCache(
                queryClient,
                collections,
                authenticatedStatus("b", "019fd974-54a2-74dd-a64b-d4186f8d8829")
            );
            rendered = renderRefreshMutation(
                queryClient,
                transport,
                createIdempotencyKey
            );
            expect(rendered.result.current.hasPendingRequest(cacheKey)).toBeFalse();

            await act(async () => {
                await rendered.result.current.mutateAsync({ key: cacheKey });
            });
            expect(transport.calls.map(({ input }) => input)).toEqual([
                { idempotencyKey: generatedKeys[0], key: cacheKey },
                { idempotencyKey: generatedKeys[1], key: cacheKey },
            ]);
            expect(generationCount).toBe(2);
        } finally {
            rendered.unmount();
            queryClient.clear();
        }
    });

    test("patches a confirmed queued run and invalidates cache, jobs, and schedules", async () => {
        const previousRun = queuedRun(runId, timestampMs);
        const confirmedRun = queuedRun(runId, timestampMs + 1000);
        const transport = new CacheMutationTransport([confirmedRun]);
        const queryClient = createDashboardQueryClient();
        const jobListKey = jobRunListQueryKey(undefined);
        const scheduleListKey = scheduleListQueryKey("enabled");
        const schedule = cacheSchedule();
        const exactCacheKey = cacheEntryQueryKey(cacheKey);
        queryClient.setQueryData(authStatusQueryKey, authenticatedStatus());
        queryClient.setQueryData(cacheStatusQueryKey, {
            entries: [],
            generatedAtMs: timestampMs,
            totalCount: 0,
            truncated: false,
        });
        queryClient.setQueryData(exactCacheKey, { sentinel: "last-known-good" });
        queryClient.setQueryData(jobListKey, {
            pageParams: [undefined],
            pages: [{ runs: [previousRun], summary: queueSummary() }],
        });
        queryClient.setQueryData(jobQueueSummaryQueryKey, {
            runs: [previousRun],
            summary: queueSummary(),
        });
        queryClient.setQueryData(jobRunDetailQueryKey(runId), {
            events: [],
            run: previousRun,
        });
        queryClient.setQueryData(scheduleListKey, {
            pageParams: [undefined],
            pages: [{ schedules: [schedule] }],
        });
        queryClient.setQueryData(scheduleDetailQueryKey(scheduleId), schedule);
        const rendered = renderRefreshMutation(queryClient, transport, () =>
            "G".repeat(32)
        );

        try {
            let result: JobRunSummary | undefined;
            await act(async () => {
                result = await rendered.result.current.mutateAsync({ key: cacheKey });
            });

            expect(result).toEqual(confirmedRun);
            expect(result?.state).toBe("queued");
            expect(rendered.result.current.failureMessage).toBeUndefined();
            expect(rendered.result.current.hasPendingRequest(cacheKey)).toBeFalse();
            expect(
                queryClient.getQueryData<{
                    readonly pages: readonly { readonly runs: JobRunSummary[] }[];
                }>(jobListKey)?.pages[0]?.runs
            ).toEqual([confirmedRun]);
            expect(
                queryClient.getQueryData<{ readonly run: JobRunSummary }>(
                    jobRunDetailQueryKey(runId)
                )?.run
            ).toEqual(confirmedRun);
            expect(
                queryClient.getQueryData<ScheduleSummary>(
                    scheduleDetailQueryKey(scheduleId)
                )
            ).toMatchObject({ activeRun: confirmedRun, latestRun: confirmedRun });
            await waitFor(() => {
                expect(
                    queryClient.getQueryState(cacheStatusQueryKey)?.isInvalidated
                ).toBeTrue();
                expect(
                    queryClient.getQueryState(exactCacheKey)?.isInvalidated
                ).toBeTrue();
                expect(queryClient.getQueryState(jobListKey)?.isInvalidated).toBeTrue();
                expect(
                    queryClient.getQueryState(jobRunDetailQueryKey(runId))?.isInvalidated
                ).toBeTrue();
                expect(
                    queryClient.getQueryState(scheduleListKey)?.isInvalidated
                ).toBeTrue();
                expect(
                    queryClient.getQueryState(scheduleDetailQueryKey(scheduleId))
                        ?.isInvalidated
                ).toBeTrue();
            });
        } finally {
            rendered.unmount();
            queryClient.clear();
        }
    });
});
