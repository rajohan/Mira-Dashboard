import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";

import {
    notifyManager,
    onlineManager,
    QueryClient,
    QueryClientProvider,
} from "@tanstack/react-query";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import type { JobRunSummary } from "../../contracts/jobModel.ts";
import { jobRealtimeTopics } from "../../contracts/jobRealtime.ts";
import type { JobRunDetail } from "../../contracts/jobs.ts";
import type {
    ListLogSourcesOutput,
    LogMaintenanceStatusOutput,
    LogSnapshotOutput,
} from "../../contracts/logs.ts";
import { logMaintenanceAvailabilityMaximumAgeMs } from "../../shared/logMaintenanceAvailabilityProjection.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import {
    ControlledDashboardRealtimeClient,
    noOpDashboardRealtimeClient,
} from "../test/realtime.ts";
import {
    logMaintenanceQueryKey,
    logMaintenanceRealtimeFallbackRefreshIntervalMs,
} from "./logQueries.ts";
import { LogsBrowser } from "./LogsBrowser.tsx";

const { act, fireEvent, render, screen, waitFor } =
    await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const hadOwnResizeObserver = Object.hasOwn(globalThis, "ResizeObserver");
const originalResizeObserver = Reflect.get(globalThis, "ResizeObserver");

beforeAll(() => {
    notifyManager.setNotifyFunction((callback) => act(callback));
    Reflect.set(
        globalThis,
        "ResizeObserver",
        class {
            disconnect(): void {}
            observe(): void {}
            unobserve(): void {}
        }
    );
});
afterAll(() => {
    notifyManager.setNotifyFunction((callback) => callback());
    if (hadOwnResizeObserver)
        Reflect.set(globalThis, "ResizeObserver", originalResizeObserver);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
});

function deferred<T>() {
    let resolveDeferred!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        resolveDeferred = resolve;
    });
    return { promise, resolve: resolveDeferred };
}

const observedAtMs = 1_800_000_000_000;
const maintenanceRunId = "019fdf70-0000-7000-8000-000000000020";
const authenticatedStatus = Object.freeze({
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
        email: "operator@example.com",
        username: "operator",
    },
} satisfies AuthStatus);
const sourceCatalog = Object.freeze({
    observedAtMs,
    sources: [
        {
            availability: "missing",
            group: "host",
            id: "host.auth",
            label: "Host authentication",
        },
        {
            availability: "available",
            group: "dashboard",
            id: "dashboard.web.stderr",
            label: "Dashboard web stderr",
            modifiedAtMs: observedAtMs,
            sizeBytes: 2048,
        },
        {
            availability: "available",
            group: "openclaw",
            id: "openclaw.gateway",
            label: "OpenClaw gateway",
            modifiedAtMs: observedAtMs,
            sizeBytes: 4096,
        },
    ],
} satisfies ListLogSourcesOutput);
const maintenanceStatus = Object.freeze({
    observedAtMs,
    policies: [
        {
            id: "docker-managed",
            label: "Managed application and container logs",
            scope: "docker",
            state: "queueable",
        },
        {
            id: "host-alternatives",
            label: "Host alternatives log",
            scope: "host",
            state: "unavailable",
        },
        {
            id: "host-apport",
            label: "Host Apport log",
            scope: "host",
            state: "unavailable",
        },
        {
            id: "host-dpkg",
            label: "Host package log",
            scope: "host",
            state: "unavailable",
        },
        {
            id: "host-rsyslog",
            label: "Host system logs",
            scope: "host",
            state: "unavailable",
        },
    ],
} satisfies LogMaintenanceStatusOutput);

function snapshot(sourceId: string): LogSnapshotOutput {
    return {
        hasEarlier: false,
        lines: [],
        observedAtMs,
        revision: sourceId.startsWith("openclaw") ? "d".repeat(64) : "e".repeat(64),
        scannedBytes: 1024,
        sourceId,
    };
}

function maintenanceRun(state: "queued" | "succeeded"): JobRunSummary {
    const terminal = state === "succeeded";
    return {
        actionKey: "maintenance.rotate-logs",
        attemptCount: terminal ? 1 : 0,
        attemptLimit: 1,
        availableAtMs: observedAtMs,
        cancellationPolicy: "cooperative",
        displayName: "Managed log maintenance dry-run",
        eventCount: terminal ? 3 : 1,
        ...(terminal ? { finishedAtMs: observedAtMs + 2000 } : {}),
        ...(terminal ? { firstStartedAtMs: observedAtMs + 1000 } : {}),
        id: maintenanceRunId,
        ...(terminal ? { lastAttemptStartedAtMs: observedAtMs + 1000 } : {}),
        priority: 0,
        queuedAtMs: observedAtMs,
        resourceClass: "host-heavy",
        resourceKeys: ["host.logs"],
        retrySafe: false,
        state,
        stateVersion: terminal ? 3 : 1,
        timeoutMs: 300_000,
        triggerType: "system",
        updatedAtMs: observedAtMs + (terminal ? 2000 : 0),
    };
}

function maintenanceRunDetail(state: "queued" | "succeeded"): JobRunDetail {
    return {
        events: [],
        ...(state === "succeeded"
            ? {
                  result: {
                      completedAtMs: observedAtMs + 2000,
                      dryRun: true,
                      policyId: "docker-managed",
                      status: "completed",
                      summary: {
                          actionCounts: {
                              compressed: 1,
                              deleted: 2,
                              error: 0,
                              missing: 1,
                              rotated: 3,
                              skipped: 4,
                          },
                          checkedTargets: 11,
                          dryRun: true,
                          finishedAtMs: observedAtMs + 2000,
                          ok: true,
                          startedAtMs: observedAtMs + 1000,
                      },
                  },
              }
            : {}),
        run: maintenanceRun(state),
    };
}

function runChange(): RealtimeStreamOutput {
    return {
        data: {
            event: {
                entityId: maintenanceRunId,
                entityType: "job-run",
                occurredAtMs: observedAtMs + 2000,
                operation: "updated",
                payload: { id: maintenanceRunId },
                topic: jobRealtimeTopics.runs,
            },
            kind: "change",
        },
        id: "21",
    };
}

function renderBrowser(
    client: DashboardTrpcClient,
    realtimeClient = noOpDashboardRealtimeClient,
    prepareQueryClient?: (queryClient: QueryClient) => void
) {
    const queryClient = new QueryClient({
        defaultOptions: {
            mutations: { retry: false },
            queries: { refetchOnWindowFocus: false, retry: false },
        },
    });
    queryClient.setQueryData(authStatusQueryKey, authenticatedStatus);
    prepareQueryClient?.(queryClient);
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardRealtimeProvider client={realtimeClient}>
                <DashboardTrpcProvider client={client}>
                    <LogsBrowser />
                </DashboardTrpcProvider>
            </DashboardRealtimeProvider>
        </QueryClientProvider>
    );
    return { queryClient, view };
}

async function cleanupBrowser(
    queryClient: QueryClient,
    view: Readonly<{ unmount: () => void }>
): Promise<void> {
    await act(async () => {
        await queryClient.cancelQueries();
        view.unmount();
        queryClient.clear();
    });
}

describe("LogsBrowser", () => {
    test("selects an available source and drives search, source, and maintenance requests", async () => {
        const query = jest.fn((name: string, input: unknown) => {
            switch (name) {
                case "logs.listSources": {
                    return Promise.resolve(sourceCatalog);
                }
                case "logs.maintenanceStatus": {
                    return Promise.resolve(maintenanceStatus);
                }
                case "logs.tail": {
                    const { sourceId } = input as { readonly sourceId: string };
                    return Promise.resolve(snapshot(sourceId));
                }
                case "logs.search": {
                    const { sourceId } = input as {
                        readonly sourceId: string;
                    };
                    return Promise.resolve(snapshot(sourceId));
                }
                case "jobs.getRun": {
                    return Promise.resolve(maintenanceRunDetail("queued"));
                }
                default: {
                    return Promise.reject(new Error(`Unexpected query: ${name}`));
                }
            }
        });
        const mutation = jest.fn(() =>
            Promise.resolve({
                dryRun: false,
                jobRunId: maintenanceRunId,
                policyId: "docker-managed" as const,
                queued: true as const,
            })
        );
        const client = { mutation, query } as unknown as DashboardTrpcClient;
        const { queryClient, view } = renderBrowser(client);

        try {
            expect(
                await screen.findByRole("region", { name: "Log viewer" })
            ).toBeVisible();
            await waitFor(() =>
                expect(query).toHaveBeenCalledWith(
                    "logs.tail",
                    { limit: 200, sourceId: "dashboard.web.stderr" },
                    expect.objectContaining({ signal: expect.any(AbortSignal) })
                )
            );

            const user = userEvent.setup();
            await act(() => {
                fireEvent.click(screen.getByRole("button", { name: /Log rows/u }));
                return new Promise((resolve) => setTimeout(resolve, 0));
            });
            await act(() => {
                fireEvent.click(screen.getByRole("option", { name: "500 lines" }));
                return new Promise((resolve) => setTimeout(resolve, 0));
            });
            await waitFor(() =>
                expect(query).toHaveBeenCalledWith(
                    "logs.tail",
                    { limit: 500, sourceId: "dashboard.web.stderr" },
                    expect.objectContaining({ signal: expect.any(AbortSignal) })
                )
            );
            await user.type(
                screen.getByRole("searchbox", { name: "Search logs" }),
                "request-42"
            );
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 350));
            });
            await waitFor(() =>
                expect(query).toHaveBeenCalledWith(
                    "logs.search",
                    {
                        limit: 500,
                        query: "request-42",
                        sourceId: "dashboard.web.stderr",
                    },
                    expect.objectContaining({ signal: expect.any(AbortSignal) })
                )
            );
            expect(screen.queryByText("Query: request-42")).toBeNull();
            expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
            expect(
                screen.getByRole("button", { name: "Clear log search" })
            ).toBeVisible();

            await act(() => {
                fireEvent.click(screen.getByRole("button", { name: /Log source/u }));
                return new Promise((resolve) => setTimeout(resolve, 0));
            });
            await act(() => {
                fireEvent.click(
                    screen.getByRole("option", { name: /OpenClaw gateway/u })
                );
                return new Promise((resolve) => setTimeout(resolve, 0));
            });
            await waitFor(() =>
                expect(query).toHaveBeenCalledWith(
                    "logs.tail",
                    { limit: 500, sourceId: "openclaw.gateway" },
                    expect.objectContaining({ signal: expect.any(AbortSignal) })
                )
            );
            expect(screen.getByRole("button", { name: /Log source/u })).toHaveTextContent(
                "OpenClaw gateway"
            );
            expect(screen.queryByRole("button", { name: "Clear log search" })).toBeNull();

            expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();

            await user.click(
                screen.getByRole("button", {
                    name: "Run Managed application and container logs",
                })
            );
            await user.click(screen.getByRole("button", { name: "Add to queue" }));
            await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
            expect(mutation).toHaveBeenCalledWith(
                "logs.requestMaintenance",
                {
                    dryRun: false,
                    idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/u),
                    policyId: "docker-managed",
                },
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
            expect(
                await screen.findByText(
                    new RegExp(`was added to the queue as job ${maintenanceRunId}`, "u")
                )
            ).toBeVisible();
            await waitFor(() =>
                expect(
                    query.mock.calls.filter(([name]) => name === "logs.maintenanceStatus")
                        .length
                ).toBeGreaterThanOrEqual(2)
            );
        } finally {
            await cleanupBrowser(queryClient, view);
        }
    });

    test("follows a queued dry-run through realtime completion and renders its bounded summary", async () => {
        let requested = false;
        let succeeded = false;
        const query = jest.fn((name: string) => {
            switch (name) {
                case "logs.listSources": {
                    return Promise.resolve(sourceCatalog);
                }
                case "logs.maintenanceStatus": {
                    return Promise.resolve(
                        requested && !succeeded
                            ? {
                                  ...maintenanceStatus,
                                  policies: maintenanceStatus.policies.map((policy) =>
                                      policy.id === "docker-managed"
                                          ? {
                                                ...policy,
                                                activeRun: maintenanceRun("queued"),
                                            }
                                          : policy
                                  ),
                              }
                            : maintenanceStatus
                    );
                }
                case "logs.tail": {
                    return Promise.resolve(snapshot("dashboard.web.stderr"));
                }
                case "jobs.getRun": {
                    return Promise.resolve(
                        maintenanceRunDetail(succeeded ? "succeeded" : "queued")
                    );
                }
                default: {
                    return Promise.reject(new Error(`Unexpected query: ${name}`));
                }
            }
        });
        const mutation = jest.fn(() => {
            requested = true;
            return Promise.resolve({
                dryRun: true,
                jobRunId: maintenanceRunId,
                policyId: "docker-managed" as const,
                queued: true as const,
            });
        });
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const { queryClient, view } = renderBrowser({ mutation, query }, realtimeClient);

        try {
            await screen.findByRole("region", { name: "Log viewer" });
            expect(realtimeClient.input).toEqual({
                topics: [jobRealtimeTopics.runs],
            });
            const user = userEvent.setup();
            await user.click(
                screen.getByRole("button", {
                    name: "Dry run Managed application and container logs",
                })
            );
            await user.click(screen.getByRole("button", { name: "Queue dry run" }));

            await waitFor(() =>
                expect(mutation).toHaveBeenCalledWith(
                    "logs.requestMaintenance",
                    {
                        dryRun: true,
                        idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/u),
                        policyId: "docker-managed",
                    },
                    expect.objectContaining({ signal: expect.any(AbortSignal) })
                )
            );
            expect(
                await screen.findByRole("status", { name: "Dry-run lifecycle" })
            ).toHaveTextContent("queued");
            expect(
                screen.getByRole("button", {
                    name: "Dry run Managed application and container logs",
                })
            ).toBeDisabled();
            expect(query).toHaveBeenCalledWith(
                "jobs.getRun",
                { eventLimit: 100, id: maintenanceRunId },
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
            const maintenanceReadsBeforeChange = query.mock.calls.filter(
                ([name]) => name === "logs.maintenanceStatus"
            ).length;

            succeeded = true;
            await act(() => {
                realtimeClient.emit(runChange());
                return Promise.resolve();
            });

            await waitFor(() =>
                expect(
                    screen.getByRole("status", { name: "Dry-run lifecycle" })
                ).toHaveTextContent("succeeded")
            );
            const summary = screen.getByLabelText("Dry-run result summary");
            expect(summary).toHaveTextContent("Checked11");
            expect(summary).toHaveTextContent("Rotated3");
            expect(summary).toHaveTextContent("Skipped4");
            expect(
                screen.getByRole("button", {
                    name: "Dry run Managed application and container logs",
                })
            ).toBeEnabled();
            await waitFor(() =>
                expect(
                    query.mock.calls.filter(([name]) => name === "logs.maintenanceStatus")
                        .length
                ).toBeGreaterThan(maintenanceReadsBeforeChange)
            );
        } finally {
            await cleanupBrowser(queryClient, view);
        }
    });

    test("starts the maintenance fallback cadence when realtime becomes unavailable", async () => {
        const query = jest.fn((name: string) => {
            switch (name) {
                case "logs.listSources": {
                    return Promise.resolve(sourceCatalog);
                }
                case "logs.maintenanceStatus": {
                    return Promise.resolve(maintenanceStatus);
                }
                case "logs.tail": {
                    return Promise.resolve(snapshot("dashboard.web.stderr"));
                }
                default: {
                    return Promise.reject(new Error(`Unexpected query: ${name}`));
                }
            }
        });
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const setInterval = jest.spyOn(globalThis, "setInterval");

        try {
            const { queryClient, view } = renderBrowser(
                {
                    mutation: () => Promise.reject(new Error("Unexpected mutation")),
                    query,
                },
                realtimeClient
            );

            try {
                await screen.findByRole("region", { name: "Log viewer" });
                const intervalCallsBeforeFailure = setInterval.mock.calls.length;

                await act(() => {
                    realtimeClient.fail();
                    return Promise.resolve();
                });

                await waitFor(() =>
                    expect(
                        setInterval.mock.calls
                            .slice(intervalCallsBeforeFailure)
                            .some(
                                ([, delay]) =>
                                    delay ===
                                    logMaintenanceRealtimeFallbackRefreshIntervalMs
                            )
                    ).toBeTrue()
                );
            } finally {
                await cleanupBrowser(queryClient, view);
            }
        } finally {
            setInterval.mockRestore();
        }
    });

    test("takes the inactivity baseline from cache after the maintenance mutation resolves", async () => {
        const requestedRun = {
            dryRun: true,
            jobRunId: maintenanceRunId,
            policyId: "docker-managed" as const,
            queued: true as const,
        };
        const mutationResult = deferred<typeof requestedRun>();
        const query = jest.fn((name: string) => {
            switch (name) {
                case "logs.listSources": {
                    return Promise.resolve(sourceCatalog);
                }
                case "logs.maintenanceStatus": {
                    return Promise.resolve(maintenanceStatus);
                }
                case "logs.tail": {
                    return Promise.resolve(snapshot("dashboard.web.stderr"));
                }
                case "jobs.getRun": {
                    return Promise.resolve(maintenanceRunDetail("queued"));
                }
                default: {
                    return Promise.reject(new Error(`Unexpected query: ${name}`));
                }
            }
        });
        const mutation = jest.fn(() => mutationResult.promise);
        const { queryClient, view } = renderBrowser({ mutation, query });

        try {
            await screen.findByRole("region", { name: "Log viewer" });
            const invalidate = jest
                .spyOn(queryClient, "invalidateQueries")
                .mockResolvedValue();
            const user = userEvent.setup();
            await user.click(
                screen.getByRole("button", {
                    name: "Dry run Managed application and container logs",
                })
            );
            await user.click(screen.getByRole("button", { name: "Queue dry run" }));
            await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));

            await act(() => {
                queryClient.setQueryData(logMaintenanceQueryKey, {
                    ...maintenanceStatus,
                    observedAtMs: observedAtMs + 1,
                });
                return Promise.resolve();
            });
            await act(async () => {
                mutationResult.resolve(requestedRun);
                await mutationResult.promise;
            });

            expect(
                await screen.findByText(
                    new RegExp(`was added to the queue as job ${maintenanceRunId}`, "u")
                )
            ).toBeVisible();
            const dryRunButton = screen.getByRole("button", {
                name: "Dry run Managed application and container logs",
            });
            expect(dryRunButton).toBeDisabled();
            invalidate.mockRestore();
        } finally {
            await cleanupBrowser(queryClient, view);
        }
    }, 20_000);

    test("fails maintenance controls closed for an expired cached authority", async () => {
        const pendingMaintenance = new Promise<LogMaintenanceStatusOutput>(() => {});
        const query = jest.fn((name: string) => {
            if (name === "logs.maintenanceStatus") return pendingMaintenance;
            if (name === "logs.listSources") return new Promise(() => {});
            return Promise.reject(new Error(`Unexpected query: ${name}`));
        });
        const client = {
            mutation: () => Promise.reject(new Error("Unexpected mutation")),
            query,
        } as unknown as DashboardTrpcClient;
        const { queryClient, view } = renderBrowser(
            client,
            noOpDashboardRealtimeClient,
            (cache) => {
                cache.setQueryData(logMaintenanceQueryKey, maintenanceStatus, {
                    updatedAt: Date.now() - logMaintenanceAvailabilityMaximumAgeMs - 1,
                });
            }
        );

        try {
            expect(
                await screen.findByRole("button", {
                    name: "Run Managed application and container logs",
                })
            ).toBeDisabled();
            expect(
                screen.getByText("Maintenance status is temporarily unavailable.")
            ).toBeVisible();
        } finally {
            await cleanupBrowser(queryClient, view);
        }
    });

    test("fails maintenance controls closed while the authority query is offline-paused", async () => {
        const query = jest.fn((name: string) => {
            if (name === "logs.maintenanceStatus") {
                return Promise.resolve(maintenanceStatus);
            }
            return Promise.reject(new Error(`Unexpected query: ${name}`));
        });
        const client = {
            mutation: () => Promise.reject(new Error("Unexpected mutation")),
            query,
        } as unknown as DashboardTrpcClient;
        try {
            onlineManager.setOnline(false);
            const { queryClient, view } = renderBrowser(
                client,
                noOpDashboardRealtimeClient,
                (cache) => {
                    cache.setQueryData(logMaintenanceQueryKey, maintenanceStatus, {
                        updatedAt: Date.now() - 11_000,
                    });
                }
            );

            try {
                expect(
                    await screen.findByRole("button", {
                        name: "Run Managed application and container logs",
                    })
                ).toBeDisabled();
                expect(
                    screen.getByText("Maintenance status is temporarily unavailable.")
                ).toBeVisible();
            } finally {
                await cleanupBrowser(queryClient, view);
            }
        } finally {
            onlineManager.setOnline(true);
        }
    });

    test("offers an explicit retry when the source catalog request fails", async () => {
        let sourceRequestCount = 0;
        const query = jest.fn((name: string) => {
            if (name === "logs.listSources") {
                sourceRequestCount += 1;
                return sourceRequestCount === 1
                    ? Promise.reject(new Error("private adapter failure"))
                    : Promise.resolve({ observedAtMs, sources: [] });
            }
            if (name === "logs.maintenanceStatus") {
                return Promise.resolve(maintenanceStatus);
            }
            return Promise.reject(new Error(`Unexpected query: ${name}`));
        });
        const client = {
            mutation: () => Promise.reject(new Error("Unexpected mutation")),
            query,
        } as unknown as DashboardTrpcClient;
        const { queryClient, view } = renderBrowser(client);

        try {
            expect(
                await screen.findByRole("heading", { name: "Log sources unavailable" })
            ).toBeVisible();
            expect(
                screen.getByRole("heading", { name: "Log maintenance" })
            ).toBeVisible();
            expect(screen.queryByText("private adapter failure")).toBeNull();

            await userEvent
                .setup()
                .click(screen.getByRole("button", { name: "Try again" }));

            expect(
                await screen.findByRole("heading", { name: "No log sources" })
            ).toBeVisible();
            expect(sourceRequestCount).toBe(2);
        } finally {
            await cleanupBrowser(queryClient, view);
        }
    });

    test("hides cached snapshots when a selected source becomes unavailable", async () => {
        let sourceUnavailable = false;
        const unavailableCatalog: ListLogSourcesOutput = {
            ...sourceCatalog,
            observedAtMs: observedAtMs + 1,
            sources: sourceCatalog.sources.map((source) =>
                source.id === "openclaw.gateway"
                    ? { ...source, availability: "unreadable" as const }
                    : source
            ),
        };
        const query = jest.fn((name: string, input: unknown) => {
            if (name === "logs.listSources") {
                return Promise.resolve(
                    sourceUnavailable ? unavailableCatalog : sourceCatalog
                );
            }
            if (name === "logs.maintenanceStatus") {
                return Promise.resolve(maintenanceStatus);
            }
            if (name === "logs.tail") {
                const { sourceId } = input as { readonly sourceId: string };
                const result = snapshot(sourceId);
                return Promise.resolve(
                    sourceId === "openclaw.gateway"
                        ? {
                              ...result,
                              lines: [
                                  {
                                      id: "a".repeat(64),
                                      line: "sensitive cached line",
                                      severity: "info" as const,
                                  },
                              ],
                          }
                        : result
                );
            }
            return Promise.reject(new Error(`Unexpected query: ${name}`));
        });
        const client = {
            mutation: () => Promise.reject(new Error("Unexpected mutation")),
            query,
        } as unknown as DashboardTrpcClient;
        const { queryClient, view } = renderBrowser(client);

        try {
            const user = userEvent.setup();
            await screen.findByRole("region", { name: "Log viewer" });
            await user.click(screen.getByRole("button", { name: /Log source/u }));
            await user.click(screen.getByRole("option", { name: /OpenClaw gateway/u }));
            expect(await screen.findByText("1 line")).toBeVisible();
            expect(
                queryClient.getQueryData([
                    "logs",
                    "snapshot",
                    "openclaw.gateway",
                    "tail",
                    null,
                    200,
                ])
            ).toMatchObject({
                lines: [{ line: "sensitive cached line" }],
            });
            sourceUnavailable = true;
            await act(async () => {
                await queryClient.refetchQueries({
                    queryKey: ["logs"],
                    type: "active",
                });
            });

            expect(
                await screen.findByText(
                    "This log source is missing or cannot be read safely."
                )
            ).toBeVisible();
            await waitFor(() => expect(screen.queryByText("1 line")).toBeNull());
            expect(
                screen.queryByRole("log", {
                    name: "Log lines with sensitive values removed",
                })
            ).toBeNull();
            expect(screen.queryByText(/Query:/u)).toBeNull();
            expect(
                queryClient.getQueryData([
                    "logs",
                    "snapshot",
                    "openclaw.gateway",
                    "tail",
                    null,
                    200,
                ])
            ).toMatchObject({
                lines: [{ line: "sensitive cached line" }],
            });
        } finally {
            await cleanupBrowser(queryClient, view);
        }
    });

    test("hides cached snapshots after a snapshot refresh fails", async () => {
        let snapshotUnavailable = false;
        const query = jest.fn((name: string, input: unknown) => {
            if (name === "logs.listSources") return Promise.resolve(sourceCatalog);
            if (name === "logs.maintenanceStatus") {
                return Promise.resolve(maintenanceStatus);
            }
            if (name === "logs.tail") {
                if (snapshotUnavailable) {
                    return Promise.reject(new Error("private log adapter failure"));
                }
                const { sourceId } = input as { readonly sourceId: string };
                return Promise.resolve({
                    ...snapshot(sourceId),
                    lines: [
                        {
                            id: "f".repeat(64),
                            line: "sensitive cached line",
                            severity: "info" as const,
                        },
                    ],
                });
            }
            return Promise.reject(new Error(`Unexpected query: ${name}`));
        });
        const client = {
            mutation: () => Promise.reject(new Error("Unexpected mutation")),
            query,
        } as unknown as DashboardTrpcClient;
        const { queryClient, view } = renderBrowser(client);

        try {
            expect(await screen.findByText("1 line")).toBeVisible();
            snapshotUnavailable = true;
            await act(async () => {
                await queryClient.refetchQueries({
                    queryKey: ["logs"],
                    type: "active",
                });
            });

            expect(
                await screen.findByText("The request could not be completed. Try again.")
            ).toBeVisible();
            await waitFor(() => expect(screen.queryByText("1 line")).toBeNull());
            expect(
                screen.queryByRole("log", {
                    name: "Log lines with sensitive values removed",
                })
            ).toBeNull();
            expect(
                queryClient.getQueryData([
                    "logs",
                    "snapshot",
                    "dashboard.web.stderr",
                    "tail",
                    null,
                    200,
                ])
            ).toMatchObject({ lines: [{ line: "sensitive cached line" }] });
        } finally {
            await cleanupBrowser(queryClient, view);
        }
    });
});
