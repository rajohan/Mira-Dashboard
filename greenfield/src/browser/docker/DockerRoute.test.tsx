import { describe, expect, jest, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

import type {
    DockerGetContainerLogsResult,
    DockerOverview,
    DockerPreparePruneResult,
    DockerRequestOperationResult,
} from "../../contracts/docker.ts";
import type { JobRunSummary } from "../../contracts/jobModel.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import type { DockerClient } from "./dockerClient.ts";
import { dockerOverviewQueryKey } from "./dockerQueries.ts";
import { DockerRoute } from "./DockerRoute.tsx";

const { render, screen, waitFor, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const observedAtMs = 1_800_000_000_000;
const sourceRevision = "a".repeat(64);
const firstContainerId = "1".repeat(64);
const secondContainerId = "2".repeat(64);
const firstImageId = "sha256:" + "3".repeat(64);
const secondImageId = "sha256:" + "4".repeat(64);
const queuedJobId = "019fdf70-0000-7000-8000-000000000040";

const freshOverview = {
    checkedAtMs: observedAtMs + 1000,
    containers: [
        {
            createdAtMs: observedAtMs - 20_000,
            health: "healthy",
            id: firstContainerId,
            image: "example/api:1.0.0",
            imageId: firstImageId,
            mounts: [
                {
                    destination: "/config",
                    name: "example_data",
                    readOnly: false,
                    type: "volume",
                },
                {
                    destination: "/run/secrets",
                    readOnly: true,
                    type: "tmpfs",
                },
            ],
            name: "alpha-api",
            networks: [
                {
                    addresses: ["172.20.0.2", "2001:db8::2"],
                    name: "example-default",
                },
            ],
            ports: [
                {
                    containerPort: 3000,
                    hostPort: 3100,
                    hostScope: "loopback",
                    protocol: "tcp",
                },
            ],
            project: "example",
            restartCount: 2,
            service: "api",
            startedAtMs: observedAtMs - 10_000,
            state: "running",
            stats: {
                blockReadBytes: 1024,
                blockWrittenBytes: 2048,
                cpuPercent: 1.5,
                memoryLimitBytes: 1024 * 1024 * 1024,
                memoryPercent: 25,
                memoryUsedBytes: 256 * 1024 * 1024,
                networkReceivedBytes: 4096,
                networkSentBytes: 8192,
                pids: 12,
            },
        },
        {
            createdAtMs: observedAtMs - 30_000,
            finishedAtMs: observedAtMs - 5000,
            health: "unhealthy",
            id: secondContainerId,
            image: "example/worker:1.0.0",
            imageId: firstImageId,
            mounts: [],
            name: "zulu-worker",
            networks: [],
            ports: [],
            project: "example",
            restartCount: 0,
            service: "worker",
            startedAtMs: observedAtMs - 20_000,
            state: "exited",
        },
    ],
    images: [
        {
            createdAtMs: observedAtMs - 40_000,
            id: firstImageId,
            references: ["example/api:1.0.0", "example/worker:1.0.0"],
            sizeBytes: 200 * 1024 * 1024,
            usedByContainerIds: [firstContainerId, secondContainerId],
        },
        {
            createdAtMs: observedAtMs - 50_000,
            id: secondImageId,
            references: ["example/old:0.9.0"],
            sizeBytes: 100 * 1024 * 1024,
            usedByContainerIds: [],
        },
    ],
    observedAtMs,
    sourceRevision,
    state: "fresh",
    updaterEvents: [
        {
            atMs: observedAtMs - 500,
            id: "019fdf70-0000-7000-8000-000000000002",
            kind: "update-failed",
            serviceId: "7".repeat(64),
            summary: "The worker update failed.",
        },
        {
            atMs: observedAtMs - 1000,
            id: "019fdf70-0000-7000-8000-000000000001",
            jobRunId: "019fdf70-0000-7000-8000-000000000039",
            kind: "update-available",
            serviceId: "5".repeat(64),
            summary: "A newer API image is available.",
        },
    ],
    updaterServices: [
        {
            currentImage: "example/api:1.0.0",
            id: "5".repeat(64),
            policy: { automatic: false, state: "managed", track: "tag" },
            project: "example",
            service: "api",
            status: {
                candidateImage: "example/api:1.1.0",
                state: "update-available",
            },
        },
        {
            currentImage: "example/web:2.0.0",
            id: "6".repeat(64),
            policy: { automatic: true, state: "managed", track: "digest" },
            project: "example",
            service: "web",
            status: { state: "current" },
        },
        {
            currentImage: "example/worker:1.0.0",
            id: "7".repeat(64),
            policy: { automatic: false, state: "managed", track: "tag" },
            project: "example",
            service: "worker",
            status: { state: "unavailable" },
        },
        {
            currentImage: "example/archive:latest",
            id: "8".repeat(64),
            policy: { reason: "missing-opt-in", state: "inventory-only" },
            project: "example",
            service: "archive",
            status: { state: "current" },
        },
    ],
    volumes: [
        {
            createdAtMs: observedAtMs - 40_000,
            driver: "local",
            name: "example_data",
            scope: "local",
            sizeBytes: 20 * 1024 * 1024,
            usedByContainerIds: [firstContainerId],
        },
        {
            driver: "local",
            name: "example_old",
            scope: "local",
            sizeBytes: 10 * 1024 * 1024,
            usedByContainerIds: [],
        },
    ],
} as const satisfies DockerOverview;

const minimalRefreshOverview = {
    ...freshOverview,
    containers: [],
    images: [],
    updaterEvents: [],
    updaterServices: [],
    volumes: [],
} as const satisfies DockerOverview;

const minimalRefreshedOverview = {
    ...minimalRefreshOverview,
    checkedAtMs: freshOverview.checkedAtMs + 60_000,
} as const satisfies DockerOverview;

const refreshedOverview = {
    ...freshOverview,
    checkedAtMs: freshOverview.checkedAtMs + 60_000,
} as const satisfies DockerOverview;

const serviceUpdateOverview = {
    ...minimalRefreshOverview,
    updaterServices: [freshOverview.updaterServices[0]],
} as const satisfies DockerOverview;

const refreshedServiceUpdateOverview = {
    ...serviceUpdateOverview,
    checkedAtMs: freshOverview.checkedAtMs + 60_000,
} as const satisfies DockerOverview;

const logsResult = {
    containerId: firstContainerId,
    lines: ["request accepted", "token=[redacted]"],
    observedAtMs,
    redacted: true,
    sourceRevision,
    truncated: true,
} as const satisfies DockerGetContainerLogsResult;

const longerLogsResult = {
    ...logsResult,
    lines: [...logsResult.lines, "500-line request complete"],
    observedAtMs: observedAtMs + 1,
} as const satisfies DockerGetContainerLogsResult;

const prunePreview = {
    estimatedReclaimableBytes: 100 * 1024 * 1024,
    expiresAtMs: observedAtMs + 300_000,
    issuedAtMs: observedAtMs,
    items: [
        {
            id: secondImageId,
            references: ["example/old:0.9.0"],
            sizeBytes: 100 * 1024 * 1024,
        },
    ],
    sourceRevision,
    target: "images",
    ticketId: "019fdf70-0000-7000-8000-000000000041",
} as const satisfies DockerPreparePruneResult;

const queuedResult = {
    jobRunId: queuedJobId,
    operation: "container-stop",
    queued: true,
} as const satisfies DockerRequestOperationResult;

const refreshRun = {
    actionKey: "cache.refresh.docker-overview",
    attemptCount: 0,
    attemptLimit: 3,
    availableAtMs: observedAtMs,
    cancellationPolicy: "cooperative",
    displayName: "Docker overview cache",
    eventCount: 1,
    id: "019fdf70-0000-7000-8000-000000000042",
    priority: 0,
    queuedAtMs: observedAtMs,
    resourceClass: "host-heavy",
    resourceKeys: ["docker.engine"],
    retrySafe: true,
    state: "queued",
    stateVersion: 1,
    timeoutMs: 45_000,
    triggerType: "manual",
    updatedAtMs: observedAtMs,
} as const satisfies JobRunSummary;

function deferred<T>() {
    let resolveDeferred!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        resolveDeferred = resolve;
    });
    return { promise, resolve: resolveDeferred };
}

async function waitForDialogExit(): Promise<void> {
    await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
}

interface ClientOverrides {
    readonly mutation?: DockerClient["mutation"];
    readonly overview?: DockerOverview;
    readonly overviewAfterFirstRead?: DockerOverview;
    readonly query?: DockerClient["query"];
}

function createClient(overrides: ClientOverrides = {}) {
    let overviewReadCount = 0;
    const query =
        overrides.query ??
        (jest.fn((name: string) => {
            if (name === "docker.overview") {
                overviewReadCount += 1;
                return Promise.resolve(
                    overviewReadCount > 1 &&
                        overrides.overviewAfterFirstRead !== undefined
                        ? overrides.overviewAfterFirstRead
                        : (overrides.overview ?? freshOverview)
                );
            }
            if (name === "docker.getContainerLogs") return Promise.resolve(logsResult);
            if (name === "docker.preparePrune") return Promise.resolve(prunePreview);
            return Promise.reject(new Error("Unexpected Docker query"));
        }) as unknown as DockerClient["query"]);
    const mutation =
        overrides.mutation ??
        (jest.fn(() =>
            Promise.resolve(queuedResult)
        ) as unknown as DockerClient["mutation"]);
    return {
        client: { mutation, query } satisfies DockerClient,
        mutation,
        get overviewReadCount() {
            return overviewReadCount;
        },
        query,
    };
}

function renderDocker(client: DockerClient) {
    const queryClient = new QueryClient({
        defaultOptions: {
            mutations: { retry: false },
            queries: { refetchOnWindowFocus: false, retry: false },
        },
    });
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DockerRoute client={client} />
        </QueryClientProvider>
    );
    return {
        queryClient,
        unmount(): void {
            view.unmount();
            queryClient.clear();
        },
    };
}

describe("DockerRoute", () => {
    test("queues an actual worker snapshot refresh and links its durable job", async () => {
        const mutation = jest.fn((name: string) => {
            if (name === "cache.refreshEntry") return Promise.resolve(refreshRun);
            return Promise.resolve(queuedResult);
        }) as unknown as DockerClient["mutation"];
        const harness = createClient({
            mutation,
            overview: minimalRefreshOverview,
            overviewAfterFirstRead: minimalRefreshedOverview,
        });
        const view = renderDocker(harness.client);
        try {
            await screen.findByText("Fresh snapshot");
            const overviewReadsBeforeRefresh = harness.overviewReadCount;
            const user = userEvent.setup();
            await user.click(screen.getByRole("button", { name: "Refresh snapshot" }));
            expect(
                await screen.findByText("Docker snapshot refresh queued.")
            ).toBeVisible();
            expect(mutation).toHaveBeenCalledWith(
                "cache.refreshEntry",
                {
                    idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/u),
                    key: "docker.overview",
                },
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
            expect(
                screen.getByRole("link", { name: "View refresh job" })
            ).toHaveAttribute("href", "/jobs?runId=" + refreshRun.id);
            expect(
                await screen.findByText(
                    "Checked " +
                        formatDashboardDateTime(minimalRefreshedOverview.checkedAtMs)
                )
            ).toBeVisible();
            await waitFor(() => {
                expect(harness.overviewReadCount).toBeGreaterThan(
                    overviewReadsBeforeRefresh
                );
                expect(
                    view.queryClient.isFetching({ queryKey: dockerOverviewQueryKey })
                ).toBe(0);
            });
        } finally {
            view.unmount();
        }
    });

    test("renders fresh summary, full updater/resource state, and searchable sortable containers", async () => {
        const harness = createClient();
        const view = renderDocker(harness.client);
        try {
            expect(await screen.findByText("Fresh snapshot")).toBeVisible();
            expect(screen.getByRole("link", { name: "Open terminal" })).toHaveAttribute(
                "href",
                "/terminal"
            );
            expect(
                screen.getByRole("link", { name: "Open console for alpha-api" })
            ).toHaveAttribute("href", `/terminal?dockerContainerId=${firstContainerId}`);
            expect(
                screen.queryByRole("link", { name: "Open console for zulu-worker" })
            ).toBeNull();
            expect(
                screen.queryByRole("button", { name: "Open console for zulu-worker" })
            ).toBeNull();
            expect(screen.getByText("2 discovered in total")).toBeVisible();
            const composeSummary = screen
                .getByRole("heading", { name: "Compose managed" })
                .closest("section");
            expect(composeSummary).not.toBeNull();
            expect(within(composeSummary!).getByText("2")).toBeVisible();
            const automaticSummary = screen
                .getByText("Automatic", { selector: "dt" })
                .closest("div");
            const notifySummary = screen
                .getByText("Notify / manual", { selector: "dt" })
                .closest("div");
            const failureSummary = screen
                .getByText("Recent failures", { selector: "dt" })
                .closest("div");
            expect(automaticSummary).not.toBeNull();
            expect(notifySummary).not.toBeNull();
            expect(failureSummary).not.toBeNull();
            expect(within(automaticSummary!).getByText("1")).toBeVisible();
            expect(within(notifySummary!).getByText("2")).toBeVisible();
            expect(within(failureSummary!).getByText("1")).toBeVisible();
            expect(screen.getByText("Update available")).toBeVisible();
            expect(screen.getAllByText("Current", { selector: "span" })).not.toHaveLength(
                0
            );
            expect(screen.getAllByText("Registry unavailable")).not.toHaveLength(0);
            expect(screen.getByText(/Inventory only · not opted in/u)).toBeVisible();
            expect(screen.getByText("A newer API image is available.")).toBeVisible();
            expect(screen.getByText("127.0.0.1:3100 → 3000/tcp")).toBeVisible();
            expect(screen.getByText("example_old")).toBeVisible();
            expect(screen.getByText(secondImageId)).toBeVisible();

            const user = userEvent.setup();
            await user.click(
                screen.getByRole("button", { name: "Show details for alpha-api" })
            );
            const detailsDialog = screen.getByRole("dialog");
            expect(
                within(detailsDialog).getByRole("heading", {
                    name: "alpha-api details",
                })
            ).toBeVisible();
            expect(within(detailsDialog).getByText("example-default")).toBeVisible();
            expect(within(detailsDialog).getByText(/172\.20\.0\.2/u)).toBeVisible();
            expect(within(detailsDialog).getByText("example_data")).toBeVisible();
            expect(within(detailsDialog).getByText("Destination /config")).toBeVisible();
            expect(within(detailsDialog).getByText("Read/write")).toBeVisible();
            expect(within(detailsDialog).getByText("Read-only")).toBeVisible();
            expect(detailsDialog).not.toHaveTextContent("/var/lib/docker");
            await user.click(
                within(detailsDialog).getByRole("button", { name: "Close dialog" })
            );
            await waitForDialogExit();

            const table = screen.getByRole("table", { name: "Docker containers" });
            let rows = within(table).getAllByRole("row").slice(1);
            expect(rows[0]).toHaveTextContent("alpha-api");
            await user.click(
                screen.getByRole("button", {
                    name: "Sort by Container descending",
                })
            );
            rows = within(table).getAllByRole("row").slice(1);
            expect(rows[0]).toHaveTextContent("zulu-worker");

            await user.type(
                screen.getByRole("searchbox", { name: "Search Docker containers" }),
                "api"
            );
            expect(within(table).getByText("alpha-api")).toBeVisible();
            expect(within(table).queryByText("zulu-worker")).toBeNull();
        } finally {
            view.unmount();
        }
    });

    test("shows Console only for running containers in a fresh snapshot", async () => {
        const pausedOverview = {
            ...freshOverview,
            containers: [
                {
                    ...freshOverview.containers[0],
                    state: "paused",
                },
                freshOverview.containers[1],
            ],
        } as const satisfies DockerOverview;
        const harness = createClient({ overview: pausedOverview });
        const view = renderDocker(harness.client);
        try {
            expect(await screen.findByText("Fresh snapshot")).toBeVisible();
            expect(
                screen.queryByRole("link", { name: "Open console for alpha-api" })
            ).toBeNull();
            expect(
                screen.queryByRole("button", { name: "Open console for alpha-api" })
            ).toBeNull();
            expect(
                screen.queryByRole("link", { name: "Open console for zulu-worker" })
            ).toBeNull();
        } finally {
            view.unmount();
        }
    });

    test("renders last-known-good and unavailable states fail closed", async () => {
        const retained = {
            ...freshOverview,
            checkedAtMs: observedAtMs + 2000,
            staleSinceMs: observedAtMs + 1000,
            state: "last-known-good",
        } as const satisfies DockerOverview;
        const retainedHarness = createClient({ overview: retained });
        const retainedView = renderDocker(retainedHarness.client);
        try {
            expect(await screen.findByText("Last-known-good snapshot")).toBeVisible();
            expect(screen.getByText(/live logs are disabled/u)).toBeVisible();
            expect(screen.getByRole("button", { name: "Stop alpha-api" })).toBeDisabled();
            expect(
                screen.queryByRole("link", { name: "Open console for alpha-api" })
            ).toBeNull();
            expect(
                screen.queryByRole("button", { name: "Open console for alpha-api" })
            ).toBeNull();
            expect(
                screen.getByRole("button", {
                    name: "Run automatic Docker updates",
                })
            ).toBeDisabled();
            expect(
                screen.getByRole("button", { name: "Preview unused image prune" })
            ).toBeDisabled();
            expect(retainedHarness.mutation).not.toHaveBeenCalled();
        } finally {
            retainedView.unmount();
        }

        const unavailableHarness = createClient({
            overview: {
                checkedAtMs: observedAtMs + 3000,
                state: "unavailable",
            },
        });
        const unavailableView = renderDocker(unavailableHarness.client);
        try {
            expect(await screen.findByText("Snapshot unavailable")).toBeVisible();
            expect(
                screen.getByRole("heading", {
                    name: "Docker inventory unavailable",
                })
            ).toBeVisible();
            expect(screen.queryByRole("table", { name: "Docker containers" })).toBeNull();
        } finally {
            unavailableView.unmount();
        }
    });

    test("queues an exact container action only after confirmation and links the job", async () => {
        const pending = deferred<DockerRequestOperationResult>();
        const mutation = jest.fn(
            () => pending.promise
        ) as unknown as DockerClient["mutation"];
        const harness = createClient({
            mutation,
            overviewAfterFirstRead: refreshedOverview,
        });
        const view = renderDocker(harness.client);
        try {
            await screen.findByText("Fresh snapshot");
            const overviewReadsBeforeOperation = harness.overviewReadCount;
            const user = userEvent.setup();
            await user.click(screen.getByRole("button", { name: "Stop alpha-api" }));
            expect(screen.getByRole("dialog")).toHaveTextContent(firstContainerId);
            await user.click(screen.getByRole("button", { name: "Queue stop" }));
            expect(screen.queryByText("Docker operation queued")).toBeNull();

            await act(async () => {
                pending.resolve(queuedResult);
                await pending.promise;
            });
            expect(
                await screen.findByRole("heading", {
                    name: "Docker operation queued",
                })
            ).toBeVisible();
            expect(mutation).toHaveBeenCalledWith(
                "docker.requestOperation",
                {
                    confirmation: "stop-docker-container",
                    containerId: firstContainerId,
                    idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/u),
                    operation: "container-stop",
                    sourceRevision,
                },
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
            expect(screen.getByRole("link", { name: "View job" })).toHaveAttribute(
                "href",
                "/jobs?runId=" + queuedJobId
            );
            expect(screen.getByText(/No runtime success is assumed/u)).toBeVisible();
            expect(
                await screen.findByText(
                    "Checked " + formatDashboardDateTime(refreshedOverview.checkedAtMs)
                )
            ).toBeVisible();
            await waitForDialogExit();
            await waitFor(() => {
                expect(
                    view.queryClient.isFetching({ queryKey: dockerOverviewQueryKey })
                ).toBe(0);
            });
            expect(harness.overviewReadCount).toBeGreaterThan(
                overviewReadsBeforeOperation
            );
        } finally {
            view.unmount();
        }
    });

    test("carries the exact confirmed current and candidate images into a service update", async () => {
        const result = {
            ...queuedResult,
            operation: "updater-update-service" as const,
        };
        const pending = deferred<DockerRequestOperationResult>();
        const mutation = jest.fn(
            () => pending.promise
        ) as unknown as DockerClient["mutation"];
        const harness = createClient({
            mutation,
            overview: serviceUpdateOverview,
            overviewAfterFirstRead: refreshedServiceUpdateOverview,
        });
        const view = renderDocker(harness.client);
        try {
            await screen.findByText("Fresh snapshot");
            const overviewReadsBeforeOperation = harness.overviewReadCount;
            const user = userEvent.setup();
            await user.click(
                screen.getByRole("button", {
                    name: "Update Docker service example api",
                })
            );
            expect(screen.getByRole("dialog")).toHaveTextContent("example/api:1.0.0");
            expect(screen.getByRole("dialog")).toHaveTextContent("example/api:1.1.0");
            await user.click(
                screen.getByRole("button", { name: "Queue service update" })
            );

            expect(mutation).toHaveBeenCalledWith(
                "docker.requestOperation",
                {
                    candidateImage: "example/api:1.1.0",
                    confirmation: "update-docker-service",
                    currentImage: "example/api:1.0.0",
                    idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/u),
                    operation: "updater-update-service",
                    serviceId: "5".repeat(64),
                    sourceRevision,
                },
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
            await act(async () => {
                pending.resolve(result);
                await pending.promise;
            });
            expect(
                await screen.findByRole("heading", {
                    name: "Docker operation queued",
                })
            ).toBeVisible();
            expect(
                await screen.findByText(
                    "Checked " +
                        formatDashboardDateTime(
                            refreshedServiceUpdateOverview.checkedAtMs
                        )
                )
            ).toBeVisible();
            await waitForDialogExit();
            await waitFor(() => {
                expect(harness.overviewReadCount).toBeGreaterThan(
                    overviewReadsBeforeOperation
                );
                expect(
                    view.queryClient.isFetching({ queryKey: dockerOverviewQueryKey })
                ).toBe(0);
            });
        } finally {
            view.unmount();
        }
    });

    test("reads bounded exact-container logs and changes the requested tail", async () => {
        const query = jest.fn((name: string, input: { tail?: number }) => {
            if (name === "docker.overview") return Promise.resolve(freshOverview);
            if (name === "docker.getContainerLogs") {
                return Promise.resolve(
                    input.tail === 500 ? longerLogsResult : logsResult
                );
            }
            return Promise.reject(new Error("Unexpected Docker query"));
        }) as unknown as DockerClient["query"];
        const harness = createClient({ query });
        const view = renderDocker(harness.client);
        try {
            await screen.findByText("Fresh snapshot");
            const user = userEvent.setup();
            await user.click(
                screen.getByRole("button", { name: "Show logs for alpha-api" })
            );
            const output = await screen.findByLabelText("Docker container log output");
            expect(output).toHaveTextContent("token=[redacted]");
            expect(screen.getByText("Redacted")).toBeVisible();
            expect(screen.getByText("Truncated")).toBeVisible();
            await waitFor(() =>
                expect(query).toHaveBeenCalledWith(
                    "docker.getContainerLogs",
                    {
                        containerId: firstContainerId,
                        sourceRevision,
                        tail: 200,
                    },
                    expect.objectContaining({ signal: expect.any(AbortSignal) })
                )
            );
            await user.click(
                screen.getByRole("button", { name: "Docker log line count" })
            );
            await user.click(screen.getByRole("option", { name: "500 lines" }));
            await waitFor(() =>
                expect(query).toHaveBeenCalledWith(
                    "docker.getContainerLogs",
                    {
                        containerId: firstContainerId,
                        sourceRevision,
                        tail: 500,
                    },
                    expect.objectContaining({ signal: expect.any(AbortSignal) })
                )
            );
            await waitFor(() => {
                expect(
                    screen.getByLabelText("Docker container log output")
                ).toHaveTextContent("500-line request complete");
                expect(view.queryClient.isFetching()).toBe(0);
            });
        } finally {
            view.unmount();
        }
    });

    test("previews exact prune candidates before queueing the one-time ticket", async () => {
        const harness = createClient({
            overviewAfterFirstRead: refreshedOverview,
        });
        const view = renderDocker(harness.client);
        try {
            await screen.findByText("Fresh snapshot");
            const user = userEvent.setup();
            await user.click(
                screen.getByRole("button", { name: "Preview unused image prune" })
            );
            expect(
                await screen.findByRole("heading", {
                    name: "Prune unused Docker images?",
                })
            ).toBeVisible();
            const dialog = screen.getByRole("dialog");
            expect(dialog).toHaveTextContent(secondImageId);
            expect(dialog).toHaveTextContent("example/old:0.9.0");
            expect(harness.query).toHaveBeenCalledWith(
                "docker.preparePrune",
                { sourceRevision, target: "images" },
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
            const overviewReadsBeforeOperation = harness.overviewReadCount;

            await user.click(screen.getByRole("button", { name: "Queue exact prune" }));
            await waitFor(() => expect(harness.mutation).toHaveBeenCalledTimes(1));
            expect(harness.mutation).toHaveBeenCalledWith(
                "docker.requestOperation",
                {
                    confirmation: "prune-docker-images",
                    idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/u),
                    operation: "prune-execute",
                    sourceRevision,
                    target: "images",
                    ticketId: prunePreview.ticketId,
                },
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
            expect(
                await screen.findByRole("heading", {
                    name: "Docker operation queued",
                })
            ).toBeVisible();
            expect(
                await screen.findByText(
                    "Checked " + formatDashboardDateTime(refreshedOverview.checkedAtMs)
                )
            ).toBeVisible();
            await waitForDialogExit();
            await waitFor(() => {
                expect(harness.overviewReadCount).toBeGreaterThan(
                    overviewReadsBeforeOperation
                );
                expect(
                    view.queryClient.isFetching({ queryKey: dockerOverviewQueryKey })
                ).toBe(0);
            });
        } finally {
            view.unmount();
        }
    });

    test("surfaces API recent-MFA errors without claiming success", async () => {
        const stepUpError = Object.assign(new Error("private server message"), {
            data: {
                code: "PRECONDITION_FAILED",
                reason: "step_up_required",
            },
        });
        const mutation = jest.fn(() => Promise.reject(stepUpError));
        const harness = createClient({ mutation });
        const view = renderDocker(harness.client);
        try {
            await screen.findByText("Fresh snapshot");
            const user = userEvent.setup();
            await user.click(
                screen.getByRole("button", {
                    name: "Scan Docker services for updates",
                })
            );
            await user.click(screen.getByRole("button", { name: "Queue scan" }));
            expect(
                await screen.findByText("Verify your identity again before continuing.")
            ).toBeVisible();
            expect(screen.getByRole("dialog")).toBeVisible();
            expect(screen.queryByText("Docker operation queued")).toBeNull();
        } finally {
            view.unmount();
        }
    });
});
