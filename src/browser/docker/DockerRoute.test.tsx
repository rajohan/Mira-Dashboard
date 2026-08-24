import { describe, expect, jest, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";

import type {
    DockerGetContainerLogsResult,
    DockerOverview,
    DockerPreparePruneResult,
    DockerRequestOperationResult,
} from "../../contracts/docker.ts";
import { parseJobsRouteSearch } from "../jobs/jobRouteSearch.ts";
import { parseTerminalRouteSearch } from "../terminal/terminalRouteSearch.ts";
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
const firstContainerImageDigest = "@sha256:" + "5".repeat(64);
const queuedJobId = "019fdf70-0000-7000-8000-000000000040";

const freshOverview = {
    checkedAtMs: observedAtMs + 1000,
    containers: [
        {
            createdAtMs: observedAtMs - 8 * 60 * 60_000,
            health: "healthy",
            id: firstContainerId,
            image: `example/api:1.0.0${firstContainerImageDigest}`,
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
            startedAtMs: observedAtMs - 7 * 60 * 60_000,
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
    const rootRoute = createRootRoute();
    const dockerRoute = createRoute({
        component: () => <DockerRoute client={client} />,
        getParentRoute: () => rootRoute,
        path: "/docker",
    });
    const jobsRoute = createRoute({
        component: () => null,
        getParentRoute: () => rootRoute,
        path: "/jobs",
        validateSearch: parseJobsRouteSearch,
    });
    const terminalRoute = createRoute({
        component: () => null,
        getParentRoute: () => rootRoute,
        path: "/terminal",
        validateSearch: parseTerminalRouteSearch,
    });
    const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/docker"] }),
        routeTree: rootRoute.addChildren([dockerRoute, jobsRoute, terminalRoute]),
    });
    const view = render(
        <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
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

function getDesktopContainerActionTrigger(containerName: string): HTMLElement {
    const table = screen.getByRole("table", { name: "Docker containers" });
    return within(table).getByRole("button", {
        name: `Actions for ${containerName}`,
    });
}

function expectDecorativeAccentHeadingIcon(headingId: string, headingName: string): void {
    const heading = document.querySelector(`#${headingId}`);
    expect(heading).not.toBeNull();
    expect(heading).toHaveTextContent(headingName);
    const icon = heading?.previousElementSibling;
    expect(icon).not.toBeNull();
    expect(icon?.tagName.toLowerCase()).toBe("svg");
    expect(icon).toHaveClass("text-accent-300");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon?.parentElement).not.toHaveClass("bg-accent-500/10");
}

describe("DockerRoute", () => {
    test("starts with engine metrics without the Docker page or snapshot header", async () => {
        const harness = createClient();
        const view = renderDocker(harness.client);
        try {
            const summary = await screen.findByRole("region", {
                name: "Engine summary",
            });
            expect(summary).toBeVisible();
            const summaryHeading = within(summary).getByRole("heading", {
                name: "Engine summary",
            });
            const pageHeading = screen.getByRole("heading", { name: "Docker" });
            expect(summaryHeading).toHaveClass("sr-only");
            expect(pageHeading).toHaveClass("sr-only");
            expect(screen.queryByText("Operations")).toBeNull();
            expect(
                screen.queryByText(
                    "Inspect the bounded Docker Engine and Compose projection, then queue exact audited operations."
                )
            ).toBeNull();
            expect(screen.queryByRole("link", { name: "Open terminal" })).toBeNull();
            expect(screen.queryByRole("button", { name: "Refresh snapshot" })).toBeNull();
            expect(screen.queryByText("Fresh snapshot")).toBeNull();
            expect(screen.queryByText(/^Checked /u)).toBeNull();
            expect(screen.queryByText(/Docker state is fresh/iu)).toBeNull();
            expect(harness.mutation).not.toHaveBeenCalled();
        } finally {
            view.unmount();
        }
    });

    test("renders fresh summary, full updater/resource state, and searchable sortable containers", async () => {
        const harness = createClient();
        const view = renderDocker(harness.client);
        try {
            expect(
                await screen.findByRole("region", { name: "Engine summary" })
            ).toBeVisible();
            expectDecorativeAccentHeadingIcon("docker-updater-heading", "Updater");
            expectDecorativeAccentHeadingIcon(
                "docker-updater-services-heading",
                "Services"
            );
            expectDecorativeAccentHeadingIcon("docker-containers-heading", "Containers");
            expectDecorativeAccentHeadingIcon("docker-images-heading", "Images");
            expectDecorativeAccentHeadingIcon("docker-volumes-heading", "Volumes");

            const scanUpdates = screen.getByRole("button", {
                name: "Scan Docker services for updates",
            });
            const runUpdates = screen.getByRole("button", {
                name: "Run automatic Docker updates",
            });
            expect(scanUpdates.parentElement).toBe(runUpdates.parentElement);
            expect(scanUpdates.parentElement).toHaveClass(
                "grid",
                "w-full",
                "grid-cols-1",
                "min-[28rem]:grid-cols-2",
                "lg:flex",
                "lg:w-auto"
            );
            expect(scanUpdates).toHaveClass("w-full", "lg:w-auto");
            expect(runUpdates).toHaveClass("w-full", "lg:w-auto");

            expect(screen.queryByRole("heading", { name: "Compose stack" })).toBeNull();
            expect(
                screen.queryByRole("button", { name: "Start Docker stack" })
            ).toBeNull();
            expect(
                screen.queryByRole("button", { name: "Stop Docker stack" })
            ).toBeNull();
            expect(
                screen.queryByRole("button", { name: "Restart Docker stack" })
            ).toBeNull();

            const user = userEvent.setup();
            const stackActions = screen.getByRole("button", {
                name: "Docker stack actions",
            });
            const containerHeading = document.querySelector("#docker-containers-heading");
            const containerHeader =
                containerHeading?.parentElement?.parentElement?.parentElement;
            expect(containerHeader).toHaveClass(
                "grid",
                "grid-cols-[minmax(0,1fr)_auto]",
                "xl:grid-cols-[minmax(0,1fr)_24rem_auto]",
                "xl:items-end"
            );
            const containerSearch = screen.getByRole("searchbox", {
                name: "Search Docker containers",
            });
            expect(containerSearch).toHaveAttribute("placeholder", "Search containers");
            expect(containerSearch.parentElement).toHaveClass(
                "col-span-2",
                "row-start-2",
                "w-full",
                "xl:col-span-1",
                "xl:col-start-2",
                "xl:row-start-1",
                "xl:w-96"
            );
            expect(stackActions.parentElement?.parentElement).toHaveClass(
                "col-start-2",
                "row-start-1",
                "xl:col-start-3",
                "xl:self-end",
                "xl:pb-1"
            );
            await user.click(stackActions);
            const stackMenu = screen.getByRole("menu");
            expect(within(stackMenu).getAllByRole("menuitem")).toHaveLength(3);
            expect(
                within(stackMenu).getByRole("menuitem", { name: /^Start stack/u })
            ).toBeEnabled();
            expect(
                within(stackMenu).getByRole("menuitem", { name: /^Stop stack/u })
            ).toBeEnabled();
            const restartStackAction = within(stackMenu).getByRole("menuitem", {
                name: /^Restart stack/u,
            });
            expect(restartStackAction).toBeEnabled();
            await user.click(restartStackAction);
            const stackDialog = screen.getByRole("dialog", {
                name: "Restart Docker stack?",
            });
            expect(stackDialog).toHaveTextContent(
                "Restart the discovered root Compose stack at this exact source revision?"
            );
            expect(
                within(stackDialog).getByRole("button", {
                    name: "Queue stack restart",
                })
            ).toBeVisible();
            await user.click(within(stackDialog).getByRole("button", { name: "Cancel" }));
            await waitForDialogExit();

            const table = screen.getByRole("table", { name: "Docker containers" });
            expect(table.parentElement).toHaveClass("hidden", "@min-[66rem]:block");
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
            expect(within(table).getByText("127.0.0.1:3100 → 3000/tcp")).toBeVisible();
            expect(screen.getAllByText("example/api:1.0.0")).not.toHaveLength(0);
            expect(screen.getAllByText(firstContainerImageDigest)).not.toHaveLength(0);
            expect(table).toHaveClass("table-fixed");
            expect(table.querySelector("colgroup col")).toHaveClass("w-[22%]");

            const imagesTable = screen.getByRole("table", {
                name: "Docker images",
            });
            const volumesTable = screen.getByRole("table", {
                name: "Docker volumes",
            });
            const imagesMobileList = screen.getByRole("list", {
                name: "Docker images",
            });
            const volumesMobileList = screen.getByRole("list", {
                name: "Docker volumes",
            });
            expect(within(imagesTable).getByText(secondImageId)).toBeVisible();
            expect(within(volumesTable).getByText("example_old")).toBeVisible();

            const imagesCard = screen
                .getByRole("heading", { name: "Images" })
                .closest("section");
            const volumesCard = screen
                .getByRole("heading", { name: "Volumes" })
                .closest("section");
            expect(imagesCard).not.toBeNull();
            expect(volumesCard).not.toBeNull();
            expect(imagesCard).toHaveClass("@container", "min-w-0");
            expect(volumesCard).toHaveClass("@container", "min-w-0");
            expect(imagesCard?.parentElement).toBe(volumesCard?.parentElement);
            expect(imagesCard?.parentElement).toHaveClass(
                "grid",
                "min-w-0",
                "xl:grid-cols-2",
                "@min-[66rem]:grid-cols-2"
            );

            expect(imagesMobileList).toHaveClass("@min-[30rem]:hidden");
            expect(volumesMobileList).toHaveClass("@min-[30rem]:hidden");
            expect(imagesTable.parentElement).toHaveClass(
                "hidden",
                "overflow-hidden",
                "@min-[30rem]:block"
            );
            expect(volumesTable.parentElement).toHaveClass(
                "hidden",
                "overflow-hidden",
                "@min-[30rem]:block"
            );
            expect(imagesTable.parentElement).not.toHaveClass("overflow-x-auto");
            expect(volumesTable.parentElement).not.toHaveClass("overflow-x-auto");
            for (const resourceTable of [imagesTable, volumesTable]) {
                expect(resourceTable).toHaveClass(
                    "bg-primary-950/40",
                    "w-full",
                    "table-fixed"
                );
                expect(resourceTable.className).not.toMatch(/\bmin-w-/u);
                expect(resourceTable.querySelector("thead")).toHaveClass(
                    "bg-primary-950"
                );
            }

            const pruneImages = screen.getByRole("button", {
                name: "Prune unused images",
            });
            const pruneVolumes = screen.getByRole("button", {
                name: "Prune unused volumes",
            });
            expect(pruneImages).toHaveTextContent("Prune unused (1)");
            expect(pruneVolumes).toHaveTextContent("Prune unused (1)");

            const mobileImageDelete = within(imagesMobileList).getByRole("button", {
                name: `Delete exact image ${secondImageId}`,
            });
            const desktopImageDelete = within(imagesTable).getByRole("button", {
                name: `Delete exact image ${secondImageId}`,
            });
            const mobileVolumeDelete = within(volumesMobileList).getByRole("button", {
                name: "Delete exact volume example_old",
            });
            const desktopVolumeDelete = within(volumesTable).getByRole("button", {
                name: "Delete exact volume example_old",
            });
            for (const deleteButton of [
                mobileImageDelete,
                desktopImageDelete,
                mobileVolumeDelete,
                desktopVolumeDelete,
            ]) {
                expect(deleteButton).toBeEnabled();
                expect(deleteButton.textContent?.trim()).toBe("");
                expect(deleteButton.querySelector("svg")).not.toBeNull();
            }

            const alphaRow = within(table).getByRole("row", {
                name: "Open details for alpha-api",
            });
            expect(alphaRow).toHaveClass("hover:bg-primary-700/30");
            expect(within(alphaRow).getByText("running")).toBeVisible();
            expect(within(alphaRow).getByText("Up 7 hours")).toBeVisible();
            expect(within(alphaRow).getByText("healthy")).toBeVisible();
            expect(within(alphaRow).getByText("restarts: 2")).toBeVisible();
            expect(within(alphaRow).getByText("256 MiB")).toBeVisible();
            expect(within(alphaRow).getByText("service: api")).toBeVisible();
            expect(within(alphaRow).getByText("project: example")).toBeVisible();
            expect(alphaRow).not.toHaveTextContent("256 MiB / 1 GiB (25%)");
            expect(alphaRow).not.toHaveTextContent(firstContainerId.slice(0, 12));

            const alphaActions = within(table).getByRole("button", {
                name: "Actions for alpha-api",
            });
            await user.click(alphaActions);
            const alphaMenu = screen.getByRole("menu");
            expect(within(alphaMenu).getAllByRole("menuitem")).toHaveLength(4);
            expect(
                within(alphaMenu).getByRole("menuitem", { name: /^Console/u })
            ).toBeEnabled();
            expect(
                within(alphaMenu).getByRole("menuitem", { name: /^Stop/u })
            ).toBeEnabled();
            expect(
                within(alphaMenu).queryByRole("menuitem", { name: /^Start/u })
            ).toBeNull();
            expect(
                within(alphaMenu).queryByRole("menuitem", { name: /^Details/u })
            ).toBeNull();
            await user.keyboard("{Escape}");

            await user.click(alphaRow);
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
            expect(
                screen.queryByRole("heading", {
                    hidden: true,
                    name: "Container details",
                })
            ).toBeNull();
            await waitForDialogExit();
            expect(screen.queryByText("Container details")).toBeNull();
            await waitFor(() => expect(alphaRow).toHaveFocus());

            let rows = within(table).getAllByRole("row").slice(1);
            expect(rows[0]).toHaveTextContent("alpha-api");
            await user.click(
                screen.getByRole("button", {
                    name: "Sort by Container ascending",
                })
            );
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

    test("renders compact mobile cards with separate details and action targets", async () => {
        const harness = createClient();
        const view = renderDocker(harness.client);
        try {
            expect(
                await screen.findByRole("region", { name: "Engine summary" })
            ).toBeVisible();
            const mobileList = screen.getByRole("list", {
                name: "Docker containers",
            });
            expect(mobileList).toHaveClass("@min-[66rem]:hidden");
            const card = within(mobileList).getByRole("listitem", {
                name: "alpha-api container",
            });
            expect(within(card).getByText("service: api")).toBeVisible();
            expect(within(card).getByText("project: example")).toBeVisible();
            expect(within(card).getByText("running")).toBeVisible();
            expect(within(card).getByText("Up 7 hours")).toHaveClass("block");
            expect(within(card).getByText("healthy")).toBeVisible();
            expect(within(card).getByText("2 restarts")).toHaveClass("block");
            expect(within(card).getByText("1.5%")).toBeVisible();
            expect(within(card).getByText("256 MiB")).toBeVisible();
            expect(card).toHaveTextContent("Ports: 127.0.0.1:3100 → 3000/tcp");
            expect(card).not.toHaveTextContent(firstContainerId.slice(0, 12));
            expect(within(card).queryByText("I/O and processes")).toBeNull();
            const stateTerm = within(card).getByText("State", { selector: "dt" });
            expect(stateTerm.closest("dl")).toHaveClass("grid-cols-2");

            const user = userEvent.setup();
            await user.click(
                within(card).getByRole("button", {
                    name: "Actions for alpha-api",
                })
            );
            expect(screen.getByRole("menu")).toBeVisible();
            expect(screen.queryByRole("dialog")).toBeNull();
            await user.keyboard("{Escape}");

            const detailsTrigger = within(card).getByRole("button", {
                name: "Open details for alpha-api",
            });
            await user.click(detailsTrigger);
            const detailsDialog = screen.getByRole("dialog");
            expect(
                within(detailsDialog).getByRole("heading", {
                    name: "alpha-api details",
                })
            ).toBeVisible();
            await user.click(
                within(detailsDialog).getByRole("button", { name: "Close dialog" })
            );
            expect(
                screen.queryByRole("heading", {
                    hidden: true,
                    name: "Container details",
                })
            ).toBeNull();
            await waitForDialogExit();
            expect(screen.queryByText("Container details")).toBeNull();
            await waitFor(() => expect(detailsTrigger).toHaveFocus());
        } finally {
            view.unmount();
        }
    });

    test("keeps exact resource confirmation copy while delete dialogs close", async () => {
        const harness = createClient();
        const view = renderDocker(harness.client);
        try {
            await screen.findByRole("region", { name: "Engine summary" });
            const user = userEvent.setup();
            const imagesTable = screen.getByRole("table", {
                name: "Docker images",
            });
            const volumesTable = screen.getByRole("table", {
                name: "Docker volumes",
            });

            await user.click(
                within(imagesTable).getByRole("button", {
                    name: `Delete exact image ${secondImageId}`,
                })
            );
            let dialog = screen.getByRole("dialog");
            expect(
                within(dialog).getByRole("heading", { name: "Delete Docker image?" })
            ).toBeVisible();
            expect(dialog).toHaveTextContent(secondImageId);
            expect(screen.queryByText("No Docker operation is selected.")).toBeNull();
            await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
            expect(screen.queryByText("No Docker operation is selected.")).toBeNull();
            await waitForDialogExit();

            await user.click(
                within(volumesTable).getByRole("button", {
                    name: "Delete exact volume example_old",
                })
            );
            dialog = screen.getByRole("dialog");
            expect(
                within(dialog).getByRole("heading", { name: "Delete Docker volume?" })
            ).toBeVisible();
            expect(dialog).toHaveTextContent("example_old");
            expect(screen.queryByText("No Docker operation is selected.")).toBeNull();
            await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
            expect(screen.queryByText("No Docker operation is selected.")).toBeNull();
            await waitForDialogExit();
        } finally {
            view.unmount();
        }
    });

    test("disables Console for non-running containers in a fresh snapshot", async () => {
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
            expect(
                await screen.findByRole("region", { name: "Engine summary" })
            ).toBeVisible();
            const user = userEvent.setup();
            await user.click(getDesktopContainerActionTrigger("alpha-api"));
            expect(screen.getByRole("menuitem", { name: /^Console/u })).toBeDisabled();
            expect(screen.getByRole("menuitem", { name: /^Stop/u })).toBeEnabled();
            expect(screen.queryByRole("menuitem", { name: /^Start/u })).toBeNull();
            await user.keyboard("{Escape}");

            await user.click(getDesktopContainerActionTrigger("zulu-worker"));
            expect(screen.getByRole("menuitem", { name: /^Console/u })).toBeDisabled();
            expect(screen.getByRole("menuitem", { name: /^Start/u })).toBeEnabled();
            expect(screen.queryByRole("menuitem", { name: /^Stop/u })).toBeNull();
            expect(screen.getByRole("menuitem", { name: /^Restart/u })).toBeDisabled();
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
            expect(
                await screen.findByRole("region", { name: "Engine summary" })
            ).toBeVisible();
            expect(screen.queryByText("Last-known-good snapshot")).toBeNull();
            expect(screen.queryByText(/live logs are disabled/u)).toBeNull();
            const user = userEvent.setup();
            await user.click(getDesktopContainerActionTrigger("alpha-api"));
            expect(screen.getByRole("menuitem", { name: /^Logs/u })).toBeDisabled();
            expect(screen.getByRole("menuitem", { name: /^Console/u })).toBeDisabled();
            expect(screen.getByRole("menuitem", { name: /^Stop/u })).toBeDisabled();
            await user.keyboard("{Escape}");
            expect(
                screen.getByRole("button", {
                    name: "Run automatic Docker updates",
                })
            ).toBeDisabled();
            expect(
                screen.getByRole("button", { name: "Prune unused images" })
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
            expect(
                await screen.findByRole("heading", {
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
            await screen.findByRole("region", { name: "Engine summary" });
            const overviewReadsBeforeOperation = harness.overviewReadCount;
            const user = userEvent.setup();
            await user.click(getDesktopContainerActionTrigger("alpha-api"));
            await user.click(screen.getByRole("menuitem", { name: /^Stop/u }));
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
            await screen.findByRole("region", { name: "Engine summary" });
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
            await screen.findByRole("region", { name: "Engine summary" });
            const user = userEvent.setup();
            await user.click(getDesktopContainerActionTrigger("alpha-api"));
            await user.click(screen.getByRole("menuitem", { name: /^Logs/u }));
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
            await screen.findByRole("region", { name: "Engine summary" });
            const user = userEvent.setup();
            await user.click(screen.getByRole("button", { name: "Prune unused images" }));
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

            await user.click(screen.getByRole("button", { name: "Queue prune" }));
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
            await screen.findByRole("region", { name: "Engine summary" });
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
