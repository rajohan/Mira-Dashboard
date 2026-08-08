import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";
import { act } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import type {
    JobRunSummary,
    JobWorkerControl,
    ScheduleSummary,
} from "../../contracts/jobModel.ts";
import { jobRealtimeTopics } from "../../contracts/jobRealtime.ts";
import type {
    CancelJobRunInput,
    GetJobRunInput,
    JobRunDetail,
    JobQueueSummary,
    ListJobRunsInput,
    SetJobClaimingPausedInput,
} from "../../contracts/jobs.ts";
import type {
    ListScheduleRunsInput,
    ListSchedulesInput,
    RunScheduleInput,
    UpdateScheduleInput,
} from "../../contracts/schedules.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import type { DashboardRealtimeClient } from "../api/realtimeClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardBrowserApplication } from "../application.tsx";
import {
    createDashboardBrowserCollections,
    type DashboardBrowserCollections,
} from "../data/dashboardCollections.ts";
import { createDashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "../security/webauthn/webauthnClient.ts";
import { emptyNotificationListResult } from "../test/notifications.ts";
import {
    ControlledDashboardRealtimeClient,
    noOpDashboardRealtimeClient,
} from "../test/realtime.ts";

const { fireEvent, render, screen, waitFor, within } =
    await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const scheduleId = "system.worker-smoke";
const runId = "019fdf70-0000-7000-8000-000000000002";
const olderRunId = "019fdf60-0000-7000-8000-000000000001";
const manualRunId = "019fdf80-0000-7000-8000-000000000003";
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
            userAgent: "Jobs route test",
        },
        state: "authenticated",
        user: {
            id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
            username: "operator",
        },
    };
}

interface QueuedRunOptions {
    readonly displayName: string;
    readonly id: string;
    readonly queuedAtMs?: number;
    readonly scheduledJobId?: string;
}

function queuedRun({
    displayName,
    id,
    queuedAtMs = timestampMs,
    scheduledJobId,
}: QueuedRunOptions): JobRunSummary {
    return {
        actionKey: scheduleId,
        attemptCount: 0,
        attemptLimit: 3,
        availableAtMs: queuedAtMs,
        cancellationPolicy: "cooperative",
        displayName,
        eventCount: 1,
        id,
        priority: 0,
        queuedAtMs,
        resourceClass: "light",
        resourceKeys: [],
        retrySafe: true,
        ...(scheduledJobId === undefined
            ? { triggerType: "system" as const }
            : {
                  scheduledJobId,
                  scheduledJobVersion: 1,
                  triggerType: "manual" as const,
              }),
        state: "queued",
        stateVersion: 1,
        timeoutMs: 60_000,
        updatedAtMs: queuedAtMs,
    };
}

function runDetail(run: JobRunSummary): JobRunDetail {
    return {
        events: [
            {
                attempt: 0,
                kind: "queued" as const,
                occurredAtMs: run.queuedAtMs,
                sequence: 1,
            },
        ],
        run,
    };
}

function scheduleSummary(
    id = scheduleId,
    overrides: Partial<ScheduleSummary> = {}
): ScheduleSummary {
    return {
        actionKey: scheduleId,
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        createdAtMs: timestampMs - 10_000,
        description: "Checks the durable worker without host mutation.",
        enabled: true,
        id,
        name: "Worker smoke",
        nextRunAtMs: timestampMs + 60_000,
        priority: 0,
        resourceClass: "light",
        resourceKeys: [],
        retrySafe: true,
        schedule: { intervalMs: 60_000, kind: "interval" },
        timeoutMs: 60_000,
        updatedAtMs: timestampMs,
        version: 1,
        ...overrides,
    };
}

function newestFirst(runs: readonly JobRunSummary[]): JobRunSummary[] {
    return [...runs].toSorted((left, right) => {
        if (left.queuedAtMs !== right.queuedAtMs) {
            return left.queuedAtMs > right.queuedAtMs ? -1 : 1;
        }
        return right.id.localeCompare(left.id);
    });
}

function queueSummary(
    runs: readonly JobRunSummary[],
    control: JobWorkerControl
): JobQueueSummary {
    const stateCounts: JobQueueSummary["stateCounts"] = {
        cancelled: 0,
        failed: 0,
        queued: 0,
        running: 0,
        succeeded: 0,
        "timed-out": 0,
    };
    for (const run of runs) stateCounts[run.state] += 1;
    const queued = runs.filter((run) => run.state === "queued");
    const activeResourceClasses = [
        ...new Set(
            runs.filter((run) => run.state === "running").map((run) => run.resourceClass)
        ),
    ].toSorted();
    return {
        activeResourceClasses,
        control,
        ...(queued.length === 0
            ? {}
            : {
                  oldestQueuedAtMs: Math.min(
                      ...queued.map(({ queuedAtMs }) => queuedAtMs)
                  ),
              }),
        stateCounts,
        workers: [],
    };
}

interface TransportCall {
    readonly input: unknown;
    readonly kind: "mutation" | "query";
    readonly path: string;
}

class JobsRouteTransport implements DashboardTrpcTransport {
    authStatus: AuthStatus = authenticatedStatus();
    readonly calls: TransportCall[] = [];
    control: JobWorkerControl = {
        claimingPaused: false,
        updatedAtMs: timestampMs,
        version: 1,
    };
    failNextCommittedScheduleRunResponses = 0;
    failJobList = false;
    failScheduleList = false;
    readonly failNextMutationCounts = new Map<string, number>();
    readonly failNextQueryCounts = new Map<string, number>();
    nextManualRunId = manualRunId;
    readonly runEventDetails = new Map<string, JobRunDetail>();
    readonly runDetails = new Map<string, JobRunDetail>();
    runPages: readonly (readonly JobRunSummary[])[] | undefined;
    runs: JobRunSummary[] = [];
    readonly scheduleDetails = new Map<string, ScheduleSummary>();
    scheduleRuns: JobRunSummary[] = [];
    schedules: ScheduleSummary[] = [];

    addRunDetail(run: JobRunSummary): void {
        this.runDetails.set(run.id, runDetail(run));
    }

    addRunEventDetail(id: string, eventCursor: number, detail: JobRunDetail): void {
        this.runEventDetails.set(`${id}:${eventCursor}`, detail);
    }

    addScheduleDetail(schedule: ScheduleSummary): void {
        this.scheduleDetails.set(schedule.id, schedule);
    }

    callsFor(path: string): TransportCall[] {
        return this.calls.filter((call) => call.path === path);
    }

    mutation(path: string, input?: unknown): Promise<unknown> {
        this.calls.push({ input, kind: "mutation", path });
        const failuresRemaining = this.failNextMutationCounts.get(path) ?? 0;
        if (failuresRemaining > 0) {
            if (failuresRemaining === 1) this.failNextMutationCounts.delete(path);
            else this.failNextMutationCounts.set(path, failuresRemaining - 1);
            return Promise.reject(new TypeError(`${path} temporarily unavailable`));
        }
        switch (path) {
            case "auth.touch": {
                return Promise.resolve({ lastSeenAtMs: timestampMs });
            }
            case "jobs.cancelRun": {
                const { id } = input as CancelJobRunInput;
                const detail = this.runDetails.get(id);
                if (detail === undefined) {
                    return Promise.reject(new TypeError("Unknown job run"));
                }
                const finishedAtMs = detail.run.updatedAtMs + 1000;
                const cancelled: JobRunSummary = {
                    ...detail.run,
                    eventCount: detail.run.eventCount + 1,
                    finishedAtMs,
                    state: "cancelled",
                    stateVersion: detail.run.stateVersion + 1,
                    terminalCode: "operator-cancelled",
                    terminalMessage: "Cancelled by the operator.",
                    updatedAtMs: finishedAtMs,
                };
                this.runDetails.set(id, {
                    events: [
                        {
                            attempt: cancelled.attemptCount,
                            kind: "cancelled",
                            occurredAtMs: finishedAtMs,
                            sequence: cancelled.eventCount,
                        },
                        ...detail.events,
                    ],
                    run: cancelled,
                });
                this.runs = this.runs.map((run) => (run.id === id ? cancelled : run));
                this.scheduleRuns = this.scheduleRuns.map((run) =>
                    run.id === id ? cancelled : run
                );
                return Promise.resolve(cancelled);
            }
            case "jobs.setClaimingPaused": {
                const { paused } = input as SetJobClaimingPausedInput;
                this.control = {
                    claimingPaused: paused,
                    updatedAtMs: this.control.updatedAtMs + 1000,
                    version: this.control.version + 1,
                };
                return Promise.resolve(this.control);
            }
            case "schedules.update": {
                const update = input as UpdateScheduleInput;
                const current = this.scheduleDetails.get(update.id);
                if (current === undefined) {
                    return Promise.reject(new TypeError("Unknown schedule"));
                }
                let updated: ScheduleSummary = {
                    ...current,
                    ...(update.patch.schedule === undefined
                        ? {}
                        : { schedule: update.patch.schedule }),
                    updatedAtMs: current.updatedAtMs + 1000,
                    version: current.version + 1,
                };
                if (update.patch.enabled === false) {
                    const {
                        activeDisableIntent: _activeDisableIntent,
                        nextRunAtMs: _nextRunAtMs,
                        ...withoutEnabledState
                    } = updated;
                    const disableIntent = update.patch.disableIntent;
                    if (disableIntent === undefined || disableIntent === null) {
                        return Promise.reject(new TypeError("Missing disable intent"));
                    }
                    updated = {
                        ...withoutEnabledState,
                        activeDisableIntent: {
                            createdAtMs: updated.updatedAtMs,
                            id: "019fdf90-0000-7000-8000-000000000004",
                            reason: disableIntent.reason,
                            ...(disableIntent.expiresAtMs === undefined
                                ? {}
                                : { expiresAtMs: disableIntent.expiresAtMs }),
                        },
                        enabled: false,
                    };
                } else if (update.patch.enabled === true) {
                    const {
                        activeDisableIntent: _activeDisableIntent,
                        ...withoutDisableIntent
                    } = updated;
                    updated = {
                        ...withoutDisableIntent,
                        enabled: true,
                        nextRunAtMs: updated.updatedAtMs + 60_000,
                    };
                }
                this.scheduleDetails.set(updated.id, updated);
                this.schedules = this.schedules.map((schedule) =>
                    schedule.id === updated.id ? updated : schedule
                );
                return Promise.resolve(updated);
            }
            case "schedules.run": {
                const { id } = input as RunScheduleInput;
                const schedule = this.scheduleDetails.get(id);
                if (schedule === undefined) {
                    return Promise.reject(new TypeError("Unknown schedule"));
                }
                const run = queuedRun({
                    displayName: `${schedule.name} manual run`,
                    id: this.nextManualRunId,
                    queuedAtMs: timestampMs + 20_000,
                    scheduledJobId: schedule.id,
                });
                this.addRunDetail(run);
                this.runs = [
                    run,
                    ...this.runs.filter(({ id: runId }) => runId !== run.id),
                ];
                this.scheduleRuns = [
                    run,
                    ...this.scheduleRuns.filter(({ id: runId }) => runId !== run.id),
                ];
                const scheduleWithRun = {
                    ...schedule,
                    activeRun: run,
                    latestRun: run,
                };
                this.scheduleDetails.set(schedule.id, scheduleWithRun);
                this.schedules = this.schedules.map((candidate) =>
                    candidate.id === schedule.id ? scheduleWithRun : candidate
                );
                if (this.failNextCommittedScheduleRunResponses > 0) {
                    this.failNextCommittedScheduleRunResponses -= 1;
                    return Promise.reject(
                        new TypeError("schedules.run response was lost after commit")
                    );
                }
                return Promise.resolve(run);
            }
            default: {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            }
        }
    }

    query(path: string, input?: unknown): Promise<unknown> {
        this.calls.push({ input, kind: "query", path });
        const failuresRemaining = this.failNextQueryCounts.get(path) ?? 0;
        if (failuresRemaining > 0) {
            if (failuresRemaining === 1) this.failNextQueryCounts.delete(path);
            else this.failNextQueryCounts.set(path, failuresRemaining - 1);
            return Promise.reject(new TypeError(`${path} temporarily unavailable`));
        }
        switch (path) {
            case "auth.status": {
                return Promise.resolve(this.authStatus);
            }
            case "notifications.list": {
                return Promise.resolve(emptyNotificationListResult);
            }
            case "jobs.listRuns": {
                if (this.failJobList) {
                    return Promise.reject(new TypeError("Job list unavailable"));
                }
                const request = input as ListJobRunsInput;
                if (this.runPages !== undefined && request.filters === undefined) {
                    const pageIndex = request.cursor === undefined ? 0 : 1;
                    const runs = this.runPages[pageIndex] ?? [];
                    const last = runs.at(-1);
                    return Promise.resolve({
                        ...(pageIndex < this.runPages.length - 1 && last !== undefined
                            ? {
                                  nextCursor: {
                                      id: last.id,
                                      queuedAtMs: last.queuedAtMs,
                                  },
                              }
                            : {}),
                        runs,
                        summary: queueSummary(this.runs, this.control),
                    });
                }
                const runs = newestFirst(this.runs).filter((run) => {
                    const filters = request.filters;
                    return (
                        (filters?.resourceClasses === undefined ||
                            filters.resourceClasses.includes(run.resourceClass)) &&
                        (filters?.scheduleId === undefined ||
                            filters.scheduleId === run.scheduledJobId) &&
                        (filters?.states === undefined ||
                            filters.states.includes(run.state)) &&
                        (filters?.triggerTypes === undefined ||
                            filters.triggerTypes.includes(run.triggerType))
                    );
                });
                return Promise.resolve({
                    runs,
                    summary: queueSummary(this.runs, this.control),
                });
            }
            case "jobs.getRun": {
                const request = input as GetJobRunInput;
                const detail =
                    request.eventCursor === undefined
                        ? this.runDetails.get(request.id)
                        : this.runEventDetails.get(
                              `${request.id}:${request.eventCursor.sequence}`
                          );
                return detail === undefined
                    ? Promise.reject(new TypeError("Unknown job run"))
                    : Promise.resolve(detail);
            }
            case "schedules.list": {
                if (this.failScheduleList) {
                    return Promise.reject(new TypeError("Schedule list unavailable"));
                }
                const request = input as ListSchedulesInput;
                const schedules = [...this.schedules]
                    .filter(
                        (schedule) =>
                            request.enabled === "all" ||
                            (request.enabled === "enabled" && schedule.enabled) ||
                            (request.enabled === "disabled" && !schedule.enabled)
                    )
                    .toSorted((left, right) => left.id.localeCompare(right.id));
                return Promise.resolve({ schedules });
            }
            case "schedules.get": {
                const id = (input as { readonly id: string }).id;
                const schedule = this.scheduleDetails.get(id);
                return schedule === undefined
                    ? Promise.reject(new TypeError("Unknown schedule"))
                    : Promise.resolve(schedule);
            }
            case "schedules.listRuns": {
                const { id } = input as ListScheduleRunsInput;
                return Promise.resolve({
                    runs: newestFirst(
                        this.scheduleRuns.filter(
                            ({ scheduledJobId }) => scheduledJobId === id
                        )
                    ),
                });
            }
            default: {
                return Promise.reject(new TypeError(`Unexpected query: ${path}`));
            }
        }
    }
}

const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});
const queryClients: ReturnType<typeof createDashboardQueryClient>[] = [];
const collectionRegistries: DashboardBrowserCollections[] = [];
const mountedViews: ReturnType<typeof render>[] = [];

function renderJobsRoute(
    path: string,
    transport: JobsRouteTransport,
    realtimeClient: DashboardRealtimeClient = noOpDashboardRealtimeClient
) {
    const queryClient = createDashboardQueryClient();
    queryClient.setDefaultOptions({
        ...queryClient.getDefaultOptions(),
        queries: {
            ...queryClient.getDefaultOptions().queries,
            retry: false,
        },
    });
    queryClients.push(queryClient);
    const trpcClient = createDashboardTrpcClient(transport);
    const collections = createDashboardBrowserCollections(queryClient, trpcClient);
    collectionRegistries.push(collections);
    const router = createDashboardRouter(createMemoryHistory({ initialEntries: [path] }));
    mountedViews.push(
        render(
            <DashboardBrowserApplication
                collections={collections}
                queryClient={queryClient}
                realtimeClient={realtimeClient}
                router={router}
                trpcClient={trpcClient}
                webAuthnClient={unexpectedWebAuthnClient}
            />
        )
    );
    return { queryClient, router };
}

afterEach(async () => {
    for (const view of mountedViews.splice(0)) view.unmount();
    await Promise.all(
        collectionRegistries.splice(0).map((collections) => collections.cleanup())
    );
    for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe("Dashboard jobs route", () => {
    test("loads independent exact deep links and wires navigation and realtime refresh", async () => {
        const transport = new JobsRouteTransport();
        const run = queuedRun({
            displayName: "Deep-linked durable run",
            id: runId,
            scheduledJobId: scheduleId,
        });
        const schedule = scheduleSummary(scheduleId, { name: "Deep-linked schedule" });
        transport.addRunDetail(run);
        transport.addScheduleDetail(schedule);
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const { queryClient } = renderJobsRoute(
            `/jobs?runId=${runId}&scheduleId=${scheduleId}`,
            transport,
            realtimeClient
        );

        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Deep-linked durable run",
            })
        ).toBeTruthy();
        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Deep-linked schedule",
            })
        ).toBeTruthy();
        await waitFor(() => expect(queryClient.isFetching()).toBe(0));
        expect(transport.runs).toEqual([]);
        expect(transport.schedules).toEqual([]);
        expect(transport.callsFor("jobs.getRun")[0]?.input).toEqual({
            eventLimit: 100,
            id: runId,
        });
        expect(transport.callsFor("schedules.get")[0]?.input).toEqual({
            id: scheduleId,
        });
        const navigation = screen.getByRole("navigation", {
            name: "Main navigation",
        });
        expect(within(navigation).getByRole("link", { name: "Jobs" })).toHaveAttribute(
            "aria-current",
            "page"
        );
        await waitFor(() => {
            expect(realtimeClient.input?.topics).toContain(jobRealtimeTopics.runs);
            expect(realtimeClient.input?.topics).toContain(jobRealtimeTopics.schedules);
        });

        const detailCallsBeforeChange = transport.callsFor("jobs.getRun").length;
        const change: RealtimeStreamOutput = {
            data: {
                event: {
                    entityId: runId,
                    entityType: "job-run",
                    occurredAtMs: timestampMs + 1000,
                    operation: "updated",
                    payload: { id: runId },
                    topic: jobRealtimeTopics.runs,
                },
                kind: "change",
            },
            id: "41",
        };
        act(() => {
            realtimeClient.emit(change);
        });
        await waitFor(() =>
            expect(transport.callsFor("jobs.getRun").length).toBeGreaterThan(
                detailCallsBeforeChange
            )
        );
    });

    test("keeps loaded event history stable while realtime shifts the exact-page cursor", async () => {
        const transport = new JobsRouteTransport();
        const initialRun = {
            ...queuedRun({
                displayName: "Long-lived durable run",
                id: runId,
                scheduledJobId: scheduleId,
            }),
            eventCount: 202,
        };
        const eventPage = (
            run: JobRunSummary,
            newestSequence: number,
            count: number,
            nextEventCursor: number
        ): JobRunDetail => ({
            events: Array.from({ length: count }, (_, index) => {
                const sequence = newestSequence - index;
                return {
                    attempt: 0,
                    kind: "queued" as const,
                    occurredAtMs: timestampMs + sequence,
                    sequence,
                };
            }),
            nextEventCursor: { sequence: nextEventCursor },
            run,
        });
        transport.runDetails.set(runId, eventPage(initialRun, 202, 100, 103));
        transport.addRunEventDetail(runId, 103, eventPage(initialRun, 102, 100, 3));
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const { queryClient } = renderJobsRoute(
            `/jobs?runId=${runId}`,
            transport,
            realtimeClient
        );
        const user = userEvent.setup();
        const detailCalls = () =>
            transport
                .callsFor("jobs.getRun")
                .filter(
                    ({ input }) => (input as GetJobRunInput).eventCursor === undefined
                );
        const historyCalls = () =>
            transport
                .callsFor("jobs.getRun")
                .filter(
                    ({ input }) => (input as GetJobRunInput).eventCursor !== undefined
                );
        const emitRunChange = (id: string) => {
            const change: RealtimeStreamOutput = {
                data: {
                    event: {
                        entityId: runId,
                        entityType: "job-run",
                        occurredAtMs: timestampMs + 1000,
                        operation: "updated",
                        payload: { id: runId },
                        topic: jobRealtimeTopics.runs,
                    },
                    kind: "change",
                },
                id,
            };
            act(() => {
                realtimeClient.emit(change);
            });
        };

        await waitFor(() => expect(detailCalls()).toHaveLength(1));
        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Long-lived durable run",
            })
        ).toBeTruthy();
        await waitFor(() => expect(queryClient.isFetching()).toBe(0));
        expect(detailCalls()).toHaveLength(1);

        await user.click(screen.getByRole("button", { name: "Load older events" }));
        await waitFor(() => expect(historyCalls()).toHaveLength(1));
        expect(historyCalls()[0]?.input).toEqual({
            eventCursor: { sequence: 103 },
            eventLimit: 100,
            id: runId,
        });
        expect(
            await screen.findByRole("article", { name: "Event 3: queued" })
        ).toBeTruthy();

        const firstRealtimeRun = {
            ...initialRun,
            eventCount: 203,
            updatedAtMs: timestampMs + 1000,
        };
        transport.runDetails.set(runId, eventPage(firstRealtimeRun, 203, 100, 104));
        emitRunChange("42");
        await waitFor(() => expect(detailCalls()).toHaveLength(2));
        expect(historyCalls()).toHaveLength(1);
        expect(
            await screen.findByRole("article", { name: "Event 103: queued" })
        ).toBeTruthy();
        expect(screen.getByRole("article", { name: "Event 3: queued" })).toBeTruthy();

        const secondRealtimeRun = {
            ...firstRealtimeRun,
            eventCount: 204,
            updatedAtMs: timestampMs + 2000,
        };
        transport.runDetails.set(runId, eventPage(secondRealtimeRun, 204, 100, 105));
        emitRunChange("43");
        await waitFor(() => expect(detailCalls()).toHaveLength(3));
        await waitFor(() =>
            expect(
                within(
                    screen.getByRole("list", {
                        name: "Durable job run events",
                    })
                ).getAllByRole("article")
            ).toHaveLength(202)
        );

        expect(historyCalls()).toHaveLength(1);
        expect(historyCalls().map(({ input }) => input)).toEqual([
            {
                eventCursor: { sequence: 103 },
                eventLimit: 100,
                id: runId,
            },
        ]);
        expect(detailCalls().map(({ input }) => input)).toEqual([
            { eventLimit: 100, id: runId },
            { eventLimit: 100, id: runId },
            { eventLimit: 100, id: runId },
        ]);
        expect(screen.getByRole("article", { name: "Event 3: queued" })).toBeTruthy();
        expect(
            screen.getAllByRole("article", { name: "Event 103: queued" })
        ).toHaveLength(1);
        expect(
            screen.getAllByRole("article", { name: "Event 104: queued" })
        ).toHaveLength(1);
    });

    test("drops malformed selections without issuing exact-detail calls", async () => {
        const transport = new JobsRouteTransport();
        const { queryClient } = renderJobsRoute(
            "/jobs?runId=not-a-run&scheduleId=Bad%20Schedule",
            transport
        );

        expect(
            await screen.findByRole("heading", { level: 1, name: "Jobs" })
        ).toBeTruthy();
        await waitFor(() => expect(queryClient.isFetching()).toBe(0));
        expect(screen.getByRole("heading", { name: "Select a job run" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Select a schedule" })).toBeTruthy();
        expect(transport.callsFor("jobs.getRun")).toEqual([]);
        expect(transport.callsFor("schedules.get")).toEqual([]);
        expect(transport.callsFor("schedules.listRuns")).toEqual([]);
    });

    test("keeps exact details available when both directory requests fail", async () => {
        const transport = new JobsRouteTransport();
        transport.failJobList = true;
        transport.failScheduleList = true;
        const run = queuedRun({
            displayName: "Exact run despite list failure",
            id: runId,
            scheduledJobId: scheduleId,
        });
        const schedule = scheduleSummary(scheduleId, {
            name: "Exact schedule despite list failure",
        });
        transport.addRunDetail(run);
        transport.addScheduleDetail(schedule);
        renderJobsRoute(`/jobs?runId=${runId}&scheduleId=${scheduleId}`, transport);

        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Exact run despite list failure",
            })
        ).toBeTruthy();
        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Exact schedule despite list failure",
            })
        ).toBeTruthy();
        expect(
            await screen.findByRole("heading", { name: "Job history unavailable" })
        ).toBeTruthy();
        expect(
            await screen.findByRole("heading", {
                name: "Schedule directory unavailable",
            })
        ).toBeTruthy();
        expect(transport.callsFor("jobs.getRun")).toHaveLength(1);
        expect(transport.callsFor("schedules.get")).toHaveLength(1);
    });

    test("retains cached queue, directory, and exact details after transient refetch failures", async () => {
        const transport = new JobsRouteTransport();
        const run = queuedRun({
            displayName: "Cached durable run",
            id: runId,
            scheduledJobId: scheduleId,
        });
        const schedule = scheduleSummary(scheduleId, { name: "Cached schedule" });
        transport.runs = [run];
        transport.schedules = [schedule];
        transport.addRunDetail(run);
        transport.addScheduleDetail(schedule);
        const { queryClient } = renderJobsRoute(
            `/jobs?runId=${runId}&scheduleId=${scheduleId}`,
            transport
        );

        expect(
            await screen.findByRole("heading", { level: 2, name: "Cached durable run" })
        ).toBeTruthy();
        expect(
            await screen.findByRole("heading", { level: 2, name: "Cached schedule" })
        ).toBeTruthy();
        await waitFor(() => expect(queryClient.isFetching()).toBe(0));
        const applyFilters = screen.getByRole("button", { name: "Apply" });
        act(() => applyFilters.focus());
        expect(applyFilters).toHaveFocus();
        const paths = [
            "jobs.getRun",
            "jobs.listRuns",
            "schedules.get",
            "schedules.list",
            "schedules.listRuns",
        ] as const;
        const previousCallCounts = new Map(
            paths.map((path) => [path, transport.callsFor(path).length] as const)
        );
        for (const path of paths) {
            transport.failNextQueryCounts.set(
                path,
                path === "jobs.listRuns" ? (previousCallCounts.get(path) ?? 1) : 1
            );
        }

        await act(async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["jobs"] }),
                queryClient.invalidateQueries({ queryKey: ["schedules"] }),
            ]);
        });
        await waitFor(() => expect(queryClient.isFetching()).toBe(0));
        expect(applyFilters).toHaveFocus();

        for (const path of paths) {
            const expectedAdditionalCalls =
                path === "jobs.listRuns" ? (previousCallCounts.get(path) ?? 1) : 1;
            expect(transport.callsFor(path)).toHaveLength(
                (previousCallCounts.get(path) ?? 0) + expectedAdditionalCalls
            );
        }
        expect(screen.getByRole("heading", { name: "Queue and workers" })).toBeTruthy();
        expect(
            screen.getByRole("button", {
                name: `Open run Cached durable run; action system.worker-smoke; id ${runId}`,
            })
        ).toBeTruthy();
        expect(
            screen.getByRole("heading", { level: 2, name: "Cached durable run" })
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Cached schedule; system.worker-smoke" })
        ).toBeTruthy();
        expect(
            screen.getByRole("heading", { level: 2, name: "Cached schedule" })
        ).toBeTruthy();
        const nonBlockingErrors = screen
            .getAllByRole("alert")
            .filter((alert) =>
                alert.textContent?.includes(
                    "The request could not be completed. Try again."
                )
            );
        expect(nonBlockingErrors.length).toBeGreaterThanOrEqual(5);
        expect(
            screen.queryByRole("heading", { name: "Job history unavailable" })
        ).toBeNull();
        expect(
            screen.queryByRole("heading", { name: "Schedule directory unavailable" })
        ).toBeNull();
        expect(screen.queryByRole("heading", { name: "Job run unavailable" })).toBeNull();
        expect(
            screen.queryByRole("heading", { name: "Schedule unavailable" })
        ).toBeNull();
    });

    test("clears a schedule filter error while the draft is corrected", async () => {
        const transport = new JobsRouteTransport();
        const { queryClient } = renderJobsRoute("/jobs", transport);
        const user = userEvent.setup();
        const historyCalls = () =>
            transport
                .callsFor("jobs.listRuns")
                .filter(({ input }) => (input as ListJobRunsInput).limit === 100);

        expect(
            await screen.findByRole("heading", { level: 1, name: "Jobs" })
        ).toBeTruthy();
        await waitFor(() => expect(queryClient.isFetching()).toBe(0));
        const initialHistoryCallCount = historyCalls().length;
        const scheduleInput = screen.getByLabelText("Schedule id");
        const applyFilters = screen.getByRole("button", { name: "Apply" });

        await user.type(scheduleInput, "INVALID");
        await user.click(applyFilters);
        expect(screen.getByText("Use a canonical Dashboard schedule id.")).toBeTruthy();
        await waitFor(() => expect(scheduleInput).toHaveFocus());
        expect(scheduleInput).toHaveAccessibleDescription(
            "Use a canonical Dashboard schedule id."
        );
        expect(historyCalls()).toHaveLength(initialHistoryCallCount);

        await user.click(applyFilters);
        await waitFor(() => expect(scheduleInput).toHaveFocus());
        expect(historyCalls()).toHaveLength(initialHistoryCallCount);

        await user.clear(scheduleInput);
        await waitFor(() =>
            expect(
                screen.queryByText("Use a canonical Dashboard schedule id.")
            ).toBeNull()
        );
        expect(historyCalls()).toHaveLength(initialHistoryCallCount);
    });

    test("applies all run filter drafts as one global-history query", async () => {
        const transport = new JobsRouteTransport();
        const { queryClient } = renderJobsRoute("/jobs", transport);
        const user = userEvent.setup();
        const historyCalls = () =>
            transport
                .callsFor("jobs.listRuns")
                .filter(({ input }) => (input as ListJobRunsInput).limit === 100);

        expect(
            await screen.findByRole("heading", { level: 1, name: "Jobs" })
        ).toBeTruthy();
        await waitFor(() => expect(queryClient.isFetching()).toBe(0));
        const initialHistoryCallCount = historyCalls().length;
        expect(initialHistoryCallCount).toBe(1);
        const scheduleInput = screen.getByLabelText("Schedule id");

        await user.click(screen.getByLabelText("State"));
        await user.click(screen.getByRole("option", { name: "running" }));
        await user.click(screen.getByLabelText("Resource class"));
        await user.click(screen.getByRole("option", { name: "network" }));
        await user.click(screen.getByLabelText("Trigger"));
        await user.click(screen.getByRole("option", { name: "manual" }));
        await user.type(scheduleInput, scheduleId);
        expect(historyCalls()).toHaveLength(initialHistoryCallCount);

        await user.click(screen.getByRole("button", { name: "Apply" }));
        await waitFor(() =>
            expect(historyCalls()).toHaveLength(initialHistoryCallCount + 1)
        );
        expect(historyCalls().at(-1)?.input).toEqual({
            filters: {
                resourceClasses: ["network"],
                scheduleId,
                states: ["running"],
                triggerTypes: ["manual"],
            },
            limit: 100,
        });
    });

    test("deduplicates an overlapping older run page", async () => {
        const transport = new JobsRouteTransport();
        const newest = queuedRun({
            displayName: "Newest paged run",
            id: runId,
            queuedAtMs: timestampMs,
        });
        const older = queuedRun({
            displayName: "Older paged run",
            id: olderRunId,
            queuedAtMs: timestampMs - 1000,
        });
        transport.runs = [newest, older];
        transport.runPages = [[newest], [newest, older]];
        renderJobsRoute("/jobs", transport);
        const user = userEvent.setup();

        expect(
            await screen.findByRole("button", {
                name: `Open run Newest paged run; action system.worker-smoke; id ${runId}`,
            })
        ).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Load more runs" }));
        expect(
            await screen.findByRole("button", {
                name: `Open run Older paged run; action system.worker-smoke; id ${olderRunId}`,
            })
        ).toBeTruthy();
        expect(
            screen.getAllByRole("button", {
                name: `Open run Newest paged run; action system.worker-smoke; id ${runId}`,
            })
        ).toHaveLength(1);
        expect(
            transport
                .callsFor("jobs.listRuns")
                .find(({ input }) => (input as ListJobRunsInput).cursor?.id === runId)
                ?.input
        ).toEqual({
            cursor: { id: runId, queuedAtMs: timestampMs },
            limit: 100,
        });
    });

    test("executes versioned pause and confirmed run cancellation", async () => {
        const transport = new JobsRouteTransport();
        const run = queuedRun({
            displayName: "Cancellable queued run",
            id: runId,
        });
        transport.runs = [run];
        transport.addRunDetail(run);
        renderJobsRoute(`/jobs?runId=${runId}`, transport);
        const user = userEvent.setup();

        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Cancellable queued run",
            })
        ).toBeTruthy();
        await user.click(
            await screen.findByRole("button", {
                name: "Pause claiming for new job runs",
            })
        );
        await waitFor(() =>
            expect(transport.callsFor("jobs.setClaimingPaused")).toHaveLength(1)
        );
        expect(transport.callsFor("jobs.setClaimingPaused")[0]?.input).toEqual({
            expectedVersion: 1,
            paused: true,
        });
        expect(
            await screen.findByRole("button", {
                name: "Resume claiming for new job runs",
            })
        ).toBeTruthy();

        await user.click(
            screen.getByRole("button", {
                name: "Cancel queued run: Cancellable queued run",
            })
        );
        await user.click(screen.getByRole("button", { name: "Cancel run" }));
        await waitFor(() => expect(transport.callsFor("jobs.cancelRun")).toHaveLength(1));
        expect(transport.callsFor("jobs.cancelRun")[0]?.input).toEqual({ id: runId });
        const cancelledLabels = await screen.findAllByText("cancelled", {
            selector: "span",
        });
        expect(cancelledLabels.length).toBeGreaterThan(0);
        expect(
            screen.queryByRole("button", {
                name: "Cancel queued run: Cancellable queued run",
            })
        ).toBeNull();
    });

    test("focuses the global detail for a run selected from schedule history", async () => {
        const transport = new JobsRouteTransport();
        const run = queuedRun({
            displayName: "Schedule-history run",
            id: runId,
            scheduledJobId: scheduleId,
        });
        const schedule = scheduleSummary();
        transport.scheduleRuns = [run];
        transport.addRunDetail(run);
        transport.addScheduleDetail(schedule);
        renderJobsRoute(`/jobs?scheduleId=${scheduleId}`, transport);
        const user = userEvent.setup();

        await user.click(
            await screen.findByRole("button", {
                name: `Open run Schedule-history run; action system.worker-smoke; id ${runId}`,
            })
        );
        const heading = await screen.findByRole("heading", {
            level: 2,
            name: "Schedule-history run",
        });
        await waitFor(() => expect(heading).toHaveFocus());
    });

    test("focuses schedule detail selected from the directory", async () => {
        const transport = new JobsRouteTransport();
        const schedule = scheduleSummary();
        transport.schedules = [schedule];
        transport.addScheduleDetail(schedule);
        renderJobsRoute("/jobs", transport);
        const user = userEvent.setup();

        await user.click(
            await screen.findByRole("button", {
                name: "Worker smoke; system.worker-smoke",
            })
        );
        const heading = await screen.findByRole("heading", {
            level: 2,
            name: "Worker smoke",
        });
        await waitFor(() => expect(heading).toHaveFocus());
    });

    test("saves cadence through a versioned schedule update", async () => {
        const transport = new JobsRouteTransport();
        const schedule = scheduleSummary();
        transport.schedules = [schedule];
        transport.addScheduleDetail(schedule);
        const { queryClient } = renderJobsRoute(
            `/jobs?scheduleId=${scheduleId}`,
            transport
        );
        const user = userEvent.setup();

        expect(
            await screen.findByRole("heading", { level: 2, name: "Worker smoke" })
        ).toBeTruthy();
        const interval = screen.getByLabelText("Interval (seconds)");
        await user.clear(interval);
        await user.type(interval, "120");
        expect(interval).toHaveValue(120);
        fireEvent.submit(
            screen.getByRole("form", { name: "Edit Worker smoke schedule" })
        );
        await waitFor(() =>
            expect(transport.callsFor("schedules.update")).toHaveLength(1)
        );
        expect(transport.callsFor("schedules.update")[0]?.input).toEqual({
            expectedVersion: 1,
            id: scheduleId,
            patch: {
                schedule: { intervalMs: 120_000, kind: "interval" },
            },
        });

        await waitFor(() => expect(queryClient.isMutating()).toBe(0));
        expect(transport.scheduleDetails.get(scheduleId)?.schedule).toEqual({
            intervalMs: 120_000,
            kind: "interval",
        });
        await waitFor(() =>
            expect(
                screen.getByRole("heading", { level: 2, name: "Worker smoke" })
            ).toHaveFocus()
        );
    });

    test("creates, replaces, and clears a durable schedule disable intent", async () => {
        const transport = new JobsRouteTransport();
        const schedule = scheduleSummary();
        transport.schedules = [schedule];
        transport.addScheduleDetail(schedule);
        renderJobsRoute(`/jobs?scheduleId=${scheduleId}`, transport);
        const user = userEvent.setup();

        expect(
            await screen.findByRole("heading", { level: 2, name: "Worker smoke" })
        ).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Disable" }));
        await user.type(screen.getByLabelText("Reason"), "Planned maintenance");
        await user.click(screen.getByRole("button", { name: "Disable schedule" }));
        await waitFor(() =>
            expect(transport.callsFor("schedules.update")).toHaveLength(1)
        );
        expect(transport.callsFor("schedules.update")[0]?.input).toEqual({
            expectedVersion: 1,
            id: scheduleId,
            patch: {
                disableIntent: { reason: "Planned maintenance" },
                enabled: false,
            },
        });
        expect(await screen.findByText("Planned maintenance")).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "Update disable intent" }));
        const reason = screen.getByLabelText("Reason");
        await user.clear(reason);
        await user.type(reason, "Extended maintenance");
        await user.click(screen.getByRole("button", { name: "Save intent" }));
        await waitFor(() =>
            expect(transport.callsFor("schedules.update")).toHaveLength(2)
        );
        expect(transport.callsFor("schedules.update")[1]?.input).toEqual({
            expectedVersion: 2,
            id: scheduleId,
            patch: {
                disableIntent: { reason: "Extended maintenance" },
                enabled: false,
            },
        });
        expect(await screen.findByText("Extended maintenance")).toBeTruthy();
        expect(screen.queryByText("Planned maintenance")).toBeNull();

        await user.click(screen.getByRole("button", { name: "Enable" }));
        await waitFor(() =>
            expect(transport.callsFor("schedules.update")).toHaveLength(3)
        );
        expect(transport.callsFor("schedules.update")[2]?.input).toEqual({
            expectedVersion: 3,
            id: scheduleId,
            patch: { disableIntent: null, enabled: true },
        });
        const enabledLabels = await screen.findAllByText("enabled");
        expect(enabledLabels.length).toBeGreaterThan(0);
        await waitFor(() =>
            expect(
                screen.getByRole("heading", { level: 2, name: "Worker smoke" })
            ).toHaveFocus()
        );
        expect(screen.queryByText("Extended maintenance")).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Update disable intent" })
        ).toBeNull();
    });

    test("opens a lost-response-safe manual schedule run", async () => {
        const transport = new JobsRouteTransport();
        const schedule = scheduleSummary();
        transport.schedules = [schedule];
        transport.addScheduleDetail(schedule);
        renderJobsRoute(`/jobs?scheduleId=${scheduleId}`, transport);
        const user = userEvent.setup();

        expect(
            await screen.findByRole("heading", { level: 2, name: "Worker smoke" })
        ).toBeTruthy();
        await user.click(await screen.findByRole("button", { name: "Run now" }));
        await waitFor(() => expect(transport.callsFor("schedules.run")).toHaveLength(1));
        const manualRunInput = transport.callsFor("schedules.run")[0]?.input;
        expect(manualRunInput).toMatchObject({ id: scheduleId });
        expect((manualRunInput as RunScheduleInput).idempotencyKey).toMatch(
            /^[A-Fa-f0-9]{32}$/u
        );
        const heading = await screen.findByRole("heading", {
            level: 2,
            name: "Worker smoke manual run",
        });
        await waitFor(() => expect(heading).toHaveFocus());
        expect(transport.callsFor("jobs.getRun").at(-1)?.input).toEqual({
            eventLimit: 100,
            id: manualRunId,
        });
    });

    test("retries one committed manual run with the original idempotency key after a lost response", async () => {
        const transport = new JobsRouteTransport();
        const schedule = scheduleSummary();
        transport.schedules = [schedule];
        transport.addScheduleDetail(schedule);
        transport.failNextCommittedScheduleRunResponses = 1;
        renderJobsRoute(`/jobs?scheduleId=${scheduleId}`, transport);
        const user = userEvent.setup();

        expect(
            await screen.findByRole("heading", { level: 2, name: "Worker smoke" })
        ).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Run now" }));
        await waitFor(() => expect(transport.callsFor("schedules.run")).toHaveLength(1));

        const retry = await screen.findByRole("button", {
            name: "Retry run request",
        });
        expect(retry).toBeEnabled();
        expect(transport.scheduleDetails.get(scheduleId)?.activeRun?.id).toBe(
            manualRunId
        );
        expect(transport.runs.map(({ id }) => id)).toEqual([manualRunId]);
        expect(transport.scheduleRuns.map(({ id }) => id)).toEqual([manualRunId]);
        expect([...transport.runDetails.keys()]).toEqual([manualRunId]);

        await user.click(retry);
        await waitFor(() => expect(transport.callsFor("schedules.run")).toHaveLength(2));
        const [firstCall, retryCall] = transport.callsFor("schedules.run");
        if (firstCall === undefined || retryCall === undefined) {
            throw new Error("Expected the original and replayed schedule run calls");
        }
        expect((firstCall.input as RunScheduleInput).idempotencyKey).toBe(
            (retryCall.input as RunScheduleInput).idempotencyKey
        );
        expect(transport.runs.map(({ id }) => id)).toEqual([manualRunId]);
        expect(transport.scheduleRuns.map(({ id }) => id)).toEqual([manualRunId]);
        expect([...transport.runDetails.keys()]).toEqual([manualRunId]);

        const heading = await screen.findByRole("heading", {
            level: 2,
            name: "Worker smoke manual run",
        });
        await waitFor(() => expect(heading).toHaveFocus());
        expect(transport.callsFor("jobs.getRun").at(-1)?.input).toEqual({
            eventLimit: 100,
            id: manualRunId,
        });
    });

    test("clears a stale schedule-update error after a successful manual run", async () => {
        const transport = new JobsRouteTransport();
        const schedule = scheduleSummary();
        transport.schedules = [schedule];
        transport.addScheduleDetail(schedule);
        transport.failNextMutationCounts.set("schedules.update", 1);
        renderJobsRoute(`/jobs?scheduleId=${scheduleId}`, transport);
        const user = userEvent.setup();
        const failureMessage = "The request could not be completed. Try again.";

        expect(
            await screen.findByRole("heading", { level: 2, name: "Worker smoke" })
        ).toBeTruthy();
        const interval = screen.getByLabelText("Interval (seconds)");
        await user.clear(interval);
        await user.type(interval, "120");
        fireEvent.submit(
            screen.getByRole("form", { name: "Edit Worker smoke schedule" })
        );
        expect(await screen.findByText(failureMessage)).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "Run now" }));
        await waitFor(() => expect(transport.callsFor("schedules.run")).toHaveLength(1));
        await waitFor(() => expect(screen.queryByText(failureMessage)).toBeNull());
    });

    test("clears a stale manual-run error after a successful schedule update", async () => {
        const transport = new JobsRouteTransport();
        const schedule = scheduleSummary();
        transport.schedules = [schedule];
        transport.addScheduleDetail(schedule);
        transport.failNextMutationCounts.set("schedules.run", 1);
        renderJobsRoute(`/jobs?scheduleId=${scheduleId}`, transport);
        const user = userEvent.setup();
        const failureMessage = "The request could not be completed. Try again.";

        expect(
            await screen.findByRole("heading", { level: 2, name: "Worker smoke" })
        ).toBeTruthy();
        await user.click(await screen.findByRole("button", { name: "Run now" }));
        await waitFor(() => expect(transport.callsFor("schedules.run")).toHaveLength(1));
        expect(await screen.findByText(failureMessage)).toBeTruthy();

        const interval = screen.getByLabelText("Interval (seconds)");
        await user.clear(interval);
        await user.type(interval, "120");
        fireEvent.submit(
            screen.getByRole("form", { name: "Edit Worker smoke schedule" })
        );
        await waitFor(() =>
            expect(transport.callsFor("schedules.update")).toHaveLength(1)
        );
        await waitFor(() => expect(screen.queryByText(failureMessage)).toBeNull());
    });

    test("redirects anonymous sessions before jobs data or realtime is mounted", async () => {
        const transport = new JobsRouteTransport();
        transport.authStatus = { state: "anonymous" };
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const { queryClient, router } = renderJobsRoute(
            `/jobs?runId=${runId}`,
            transport,
            realtimeClient
        );

        expect(
            await screen.findByRole("heading", { level: 1, name: "Sign in" })
        ).toBeTruthy();
        await waitFor(() => expect(queryClient.isFetching()).toBe(0));
        expect(router.state.location.pathname).toBe("/login");
        expect(transport.calls.some(({ path }) => path.startsWith("jobs."))).toBeFalse();
        expect(
            transport.calls.some(({ path }) => path.startsWith("schedules."))
        ).toBeFalse();
        expect(realtimeClient.activeSubscriptionCount).toBe(0);
        expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    });
});
