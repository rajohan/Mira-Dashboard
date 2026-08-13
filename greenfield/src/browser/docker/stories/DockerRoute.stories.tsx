import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type {
    DockerGetContainerLogsResult,
    DockerOverview,
    DockerPreparePruneResult,
    DockerRequestOperationResult,
} from "../../../contracts/docker.ts";
import type { JobRunSummary } from "../../../contracts/jobModel.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtureValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";

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

const logsResult = {
    containerId: firstContainerId,
    lines: ["request accepted", "token=[redacted]"],
    observedAtMs,
    redacted: true,
    sourceRevision,
    truncated: true,
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
    operation: "updater-scan",
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

const notifications = {
    notifications: [],
    readCount: 0,
    unreadCount: 0,
} as const;

function dockerFixtures(
    options: {
        readonly mutation?: DashboardStoryFixtureValue;
        readonly overview?: DashboardStoryFixtureValue;
    } = {}
): DashboardStoryFixtures {
    return {
        mutations: {
            "cache.refreshEntry": dashboardStoryValue(refreshRun),
            "docker.requestOperation":
                options.mutation ?? dashboardStoryValue(queuedResult),
        },
        queries: {
            "docker.getContainerLogs": dashboardStoryValue(logsResult),
            "docker.overview": options.overview ?? dashboardStoryValue(freshOverview),
            "docker.preparePrune": dashboardStoryValue(prunePreview),
            "notifications.list": dashboardStoryValue(notifications),
        },
    };
}

const pending = dashboardStoryResolver(
    () =>
        new Promise<never>(() => {
            // Intentionally pending to render the route loading state.
        })
);

const operationOutcomeUnknown = Object.assign(new TypeError("Private provider detail"), {
    data: {
        code: "INTERNAL_SERVER_ERROR",
        reason: "operation_outcome_unknown",
    },
});

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    title: "Pages/Docker",
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: { fixtures: dockerFixtures({ overview: pending }), route: "/docker" },
};

export const Fresh: Story = {
    args: { fixtures: dockerFixtures(), route: "/docker" },
};

export const Empty: Story = {
    args: {
        fixtures: dockerFixtures({
            overview: dashboardStoryValue({
                ...freshOverview,
                containers: [],
                images: [],
                updaterEvents: [],
                updaterServices: [],
                volumes: [],
            } satisfies DockerOverview),
        }),
        route: "/docker",
    },
};

export const LastKnownGood: Story = {
    args: {
        fixtures: dockerFixtures({
            overview: dashboardStoryValue({
                ...freshOverview,
                staleSinceMs: observedAtMs + 500,
                state: "last-known-good",
            } satisfies DockerOverview),
        }),
        route: "/docker",
    },
};

export const BrowserRetained: Story = {
    args: {
        fixtures: dockerFixtures({
            overview: dashboardStoryResolver((_input, callIndex) =>
                callIndex === 0
                    ? freshOverview
                    : Promise.reject(new TypeError("Safe retained refresh failure"))
            ),
        }),
        route: "/docker",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByText("Fresh snapshot")).toBeVisible();
        const refresh = canvas.getByRole("button", { name: "Refresh snapshot" });
        await expect(refresh).toBeEnabled();
        await userEvent.click(refresh);
        await expect(
            await canvas.findByText(
                /Docker controls remain disabled until refresh succeeds/iu,
                {},
                { timeout: 5000 }
            )
        ).toBeVisible();
    },
};

export const Unavailable: Story = {
    args: {
        fixtures: dockerFixtures({
            overview: dashboardStoryValue({
                checkedAtMs: observedAtMs,
                state: "unavailable",
            } satisfies DockerOverview),
        }),
        route: "/docker",
    },
};

export const UpdatesAvailable: Story = {
    args: { fixtures: dockerFixtures(), route: "/docker" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByText("example/api:1.1.0")).toBeVisible();
        await expect(canvas.getByText("A newer API image is available.")).toBeVisible();
    },
};

export const Confirmation: Story = {
    args: { fixtures: dockerFixtures(), route: "/docker" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", {
                name: "Scan Docker services for updates",
            })
        );
        const page = within(canvasElement.ownerDocument.body);
        await expect(
            await page.findByRole("dialog", { name: "Scan Docker updates?" })
        ).toBeVisible();
    },
};

export const PrunePreview: Story = {
    args: { fixtures: dockerFixtures(), route: "/docker" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Preview unused image prune" })
        );
        const page = within(canvasElement.ownerDocument.body);
        await waitFor(async () => {
            await expect(
                page.getByRole("heading", { name: "Prune unused Docker images?" })
            ).toBeVisible();
        });
        await waitFor(async () => {
            await expect(page.getByText("example/old:0.9.0")).toBeVisible();
        });
    },
};

export const Logs: Story = {
    args: { fixtures: dockerFixtures(), route: "/docker" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Show logs for alpha-api" })
        );
        const page = within(canvasElement.ownerDocument.body);
        await expect(
            await page.findByLabelText("Docker container log output")
        ).toHaveTextContent("token=[redacted]");
    },
};

export const Queued: Story = {
    args: {
        fixtures: dockerFixtures({
            overview: dashboardStoryValue({
                ...freshOverview,
                updaterEvents: [],
                updaterServices: [],
            } satisfies DockerOverview),
        }),
        route: "/docker",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", {
                name: "Scan Docker services for updates",
            })
        );
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(await page.findByRole("button", { name: "Queue scan" }));
        await expect(
            await canvas.findByRole("heading", { name: "Docker operation queued" })
        ).toBeVisible();
    },
};

export const UnknownOutcome: Story = {
    args: {
        fixtures: dockerFixtures({
            mutation: dashboardStoryFailure(operationOutcomeUnknown),
        }),
        route: "/docker",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", {
                name: "Scan Docker services for updates",
            })
        );
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(await page.findByRole("button", { name: "Queue scan" }));
        await expect(
            await page.findByText(/queue outcome could not be confirmed/iu)
        ).toBeVisible();
    },
};

export const Error: Story = {
    args: {
        fixtures: dockerFixtures({
            mutation: dashboardStoryFailure(
                new TypeError("Safe Docker operation failure")
            ),
        }),
        route: "/docker",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", {
                name: "Scan Docker services for updates",
            })
        );
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(await page.findByRole("button", { name: "Queue scan" }));
        await expect(
            await page.findByText("The request could not be completed. Try again.")
        ).toBeVisible();
    },
};
