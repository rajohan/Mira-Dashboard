import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type {
    DockerGetContainerLogsResult,
    DockerOverview,
    DockerPreparePruneResult,
    DockerRequestOperationResult,
} from "../../../contracts/docker.ts";
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
            createdAtMs: observedAtMs - 8 * 60 * 60_000,
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
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: { fixtures: dockerFixtures({ overview: pending }), route: "/docker" },
};

export const Fresh: Story = {
    args: { fixtures: dockerFixtures(), route: "/docker" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const summary = await canvas.findByRole("region", {
            name: "Engine summary",
        });
        await expect(summary).toBeVisible();
        const summaryHeading = within(summary).getByRole("heading", {
            name: "Engine summary",
        });
        const pageHeading = canvas.getByRole("heading", { name: "Docker" });
        await expect(summaryHeading).toHaveClass("sr-only");
        await expect(pageHeading).toHaveClass("sr-only");
        await expect(canvas.queryByText("Operations")).toBeNull();
        await expect(
            canvas.queryByRole("button", { name: "Refresh snapshot" })
        ).toBeNull();

        for (const [headingId, headingName] of [
            ["docker-updater-heading", "Updater"],
            ["docker-updater-services-heading", "Services"],
            ["docker-containers-heading", "Containers"],
            ["docker-images-heading", "Images"],
            ["docker-volumes-heading", "Volumes"],
        ] as const) {
            const heading = canvasElement.querySelector(`#${headingId}`);
            if (heading === null) {
                throw new TypeError(`Missing ${headingName} heading`);
            }
            await expect(heading).toHaveTextContent(headingName);
            const headingIcon = heading.previousElementSibling;
            if (headingIcon === null || headingIcon.tagName.toLowerCase() !== "svg") {
                throw new TypeError(`Missing decorative icon for ${headingName}`);
            }
            await expect(headingIcon).toHaveClass("text-accent-300");
            await expect(headingIcon).toHaveAttribute("aria-hidden", "true");
            await expect(headingIcon.parentElement).not.toHaveClass("bg-accent-500/10");
        }

        await expect(canvas.queryByRole("heading", { name: "Compose stack" })).toBeNull();
        await expect(
            canvas.queryByRole("button", { name: "Start Docker stack" })
        ).toBeNull();
        await expect(
            canvas.queryByRole("button", { name: "Stop Docker stack" })
        ).toBeNull();
        await expect(
            canvas.queryByRole("button", { name: "Restart Docker stack" })
        ).toBeNull();

        const stackActions = canvas.getByRole("button", {
            name: "Docker stack actions",
        });
        const containerHeading = canvasElement.querySelector(
            "#docker-containers-heading"
        );
        const containerHeader =
            containerHeading?.parentElement?.parentElement?.parentElement;
        await expect(containerHeader).toHaveClass(
            "grid-cols-[minmax(0,1fr)_auto]",
            "xl:grid-cols-[minmax(0,1fr)_24rem_auto]",
            "xl:items-end"
        );
        const containerSearch = canvas.getByRole("searchbox", {
            name: "Search Docker containers",
        });
        await expect(containerSearch).toHaveAttribute("placeholder", "Search containers");
        await expect(containerSearch.parentElement).toHaveClass(
            "col-span-2",
            "row-start-2",
            "w-full",
            "xl:col-span-1",
            "xl:col-start-2",
            "xl:row-start-1",
            "xl:w-96"
        );
        await expect(stackActions.parentElement?.parentElement).toHaveClass(
            "col-start-2",
            "row-start-1",
            "xl:col-start-3",
            "xl:self-end",
            "xl:pb-1"
        );
        stackActions.scrollIntoView({ block: "center" });
        await userEvent.click(stackActions);
        const page = within(canvasElement.ownerDocument.body);
        const stackMenu = await page.findByRole("menu");
        await expect(within(stackMenu).getAllByRole("menuitem")).toHaveLength(3);
        await expect(
            within(stackMenu).getByRole("menuitem", { name: /^Start stack/u })
        ).toBeEnabled();
        await expect(
            within(stackMenu).getByRole("menuitem", { name: /^Stop stack/u })
        ).toBeEnabled();
        const restartStackAction = within(stackMenu).getByRole("menuitem", {
            name: /^Restart stack/u,
        });
        await expect(restartStackAction).toBeEnabled();
        await userEvent.click(restartStackAction);
        const stackDialog = await page.findByRole("dialog", {
            name: "Restart Docker stack?",
        });
        await expect(stackDialog).toHaveTextContent(
            "Restart the discovered root Compose stack at this exact source revision?"
        );
        await expect(
            within(stackDialog).getByRole("button", { name: "Queue stack restart" })
        ).toBeVisible();
        await userEvent.click(
            within(stackDialog).getByRole("button", { name: "Cancel" })
        );
        await waitFor(async () => {
            await expect(page.queryByRole("dialog", { hidden: true })).toBeNull();
        });

        const table = canvas.queryByRole("table", { name: "Docker containers" });
        const container =
            table === null
                ? within(
                      canvas.getByRole("list", { name: "Docker containers" })
                  ).getByRole("listitem", { name: "alpha-api container" })
                : within(table).getByRole("row", {
                      name: "Open details for alpha-api",
                  });
        await expect(within(container).getByText("running")).toBeVisible();
        await expect(within(container).getByText("Up 7 hours")).toBeVisible();
        await expect(within(container).getByText("healthy")).toBeVisible();
        await expect(
            within(container).getByText(/^(?:2 restarts|restarts: 2)$/u)
        ).toBeVisible();
        await expect(within(container).getByText("256 MiB")).toBeVisible();
        await expect(within(container).getByText("service: api")).toBeVisible();
        await expect(within(container).getByText("project: example")).toBeVisible();
        await expect(container).not.toHaveTextContent("256 MiB / 1 GiB (25%)");
        await expect(container).not.toHaveTextContent(firstContainerId.slice(0, 12));

        const imagesTable = canvas.getByRole("table", { name: "Docker images" });
        const volumesTable = canvas.getByRole("table", { name: "Docker volumes" });
        const imagesCard = canvas
            .getByRole("heading", { name: "Images" })
            .closest("section");
        await expect(imagesCard?.parentElement).toHaveClass(
            "xl:grid-cols-2",
            "@min-[66rem]:grid-cols-2"
        );
        await expect(imagesTable).toHaveClass(
            "bg-primary-950/40",
            "w-full",
            "table-fixed"
        );
        await expect(volumesTable).toHaveClass(
            "bg-primary-950/40",
            "w-full",
            "table-fixed"
        );
        await expect(imagesTable.parentElement).not.toHaveClass("overflow-x-auto");
        await expect(volumesTable.parentElement).not.toHaveClass("overflow-x-auto");
    },
};

export const Mobile: Story = {
    args: { fixtures: dockerFixtures(), route: "/docker" },
    parameters: {
        viewport: { defaultViewport: "mobile1" },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const list = await canvas.findByRole("list", { name: "Docker containers" });
        const card = within(list).getByRole("listitem", {
            name: "alpha-api container",
        });
        await expect(
            canvas.queryByRole("table", { name: "Docker containers" })
        ).toBeNull();
        await expect(within(card).getByText("Up 7 hours")).toHaveClass("block");
        await expect(within(card).getByText("2 restarts")).toHaveClass("block");
        await expect(within(card).getByText("256 MiB")).toBeVisible();
        await expect(within(card).queryByText("I/O and processes")).toBeNull();

        const imagesList = await canvas.findByRole("list", {
            name: "Docker images",
        });
        const volumesList = await canvas.findByRole("list", {
            name: "Docker volumes",
        });
        const imageCard = within(imagesList).getByRole("listitem", {
            name: "example/old:0.9.0 image",
        });
        const volumeCard = within(volumesList).getByRole("listitem", {
            name: "example_old volume",
        });
        await expect(imagesList).toHaveClass("@min-[30rem]:hidden");
        await expect(volumesList).toHaveClass("@min-[30rem]:hidden");
        await expect(imageCard).toHaveClass("bg-primary-950/40");
        await expect(volumeCard).toHaveClass("bg-primary-950/40");
        await expect(within(imageCard).getByText("Unused")).toBeVisible();
        await expect(within(volumeCard).getByText("Unused")).toBeVisible();
        await expect(canvas.queryByRole("table", { name: "Docker images" })).toBeNull();
        await expect(canvas.queryByRole("table", { name: "Docker volumes" })).toBeNull();

        const imageDelete = within(imageCard).getByRole("button", {
            name: `Delete exact image ${secondImageId}`,
        });
        const volumeDelete = within(volumeCard).getByRole("button", {
            name: "Delete exact volume example_old",
        });
        await expect(imageDelete.textContent?.trim()).toBe("");
        await expect(volumeDelete.textContent?.trim()).toBe("");
        await expect(imageDelete.querySelector("svg")).not.toBeNull();
        await expect(volumeDelete.querySelector("svg")).not.toBeNull();
        await expect(
            canvas.getByRole("button", { name: "Prune unused images" })
        ).toHaveTextContent("Prune unused (1)");
        await expect(
            canvas.getByRole("button", { name: "Prune unused volumes" })
        ).toHaveTextContent("Prune unused (1)");

        const actionTrigger = within(card).getByRole("button", {
            name: "Actions for alpha-api",
        });
        actionTrigger.scrollIntoView({ block: "center" });
        await userEvent.click(actionTrigger);
        const page = within(canvasElement.ownerDocument.body);
        const menu = await page.findByRole("menu");
        await waitFor(async () => await expect(menu).toBeVisible());
        await expect(page.getAllByRole("menuitem")).toHaveLength(4);
        await expect(page.getByRole("menuitem", { name: /^Stop/u })).toBeEnabled();
        await expect(page.queryByRole("menuitem", { name: /^Start/u })).toBeNull();
        await userEvent.keyboard("{Escape}");

        await userEvent.click(
            within(card).getByRole("button", {
                name: "Open details for alpha-api",
            })
        );
        const dialog = await page.findByRole("dialog");
        await expect(dialog).toHaveTextContent("alpha-api details");
        await userEvent.click(
            within(dialog).getByRole("button", { name: "Close dialog" })
        );
        await expect(
            page.queryByRole("heading", {
                hidden: true,
                name: "Container details",
            })
        ).toBeNull();
        await waitFor(async () => {
            await expect(page.queryByRole("dialog", { hidden: true })).toBeNull();
        });
        await expect(page.queryByText("Container details")).toBeNull();
    },
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
            await canvas.findByRole("button", { name: "Prune unused images" })
        );
        const page = within(canvasElement.ownerDocument.body);
        const dialog = await page.findByRole("dialog", {
            name: "Prune unused Docker images?",
        });
        await expect(dialog).toBeVisible();
        await waitFor(async () => {
            await expect(within(dialog).getByText(/example\/old:0\.9\.0/u)).toBeVisible();
        });
        await expect(
            within(dialog).getByRole("button", { name: "Queue prune" })
        ).toBeVisible();
    },
};

export const Logs: Story = {
    args: { fixtures: dockerFixtures(), route: "/docker" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", {
                name: "Actions for alpha-api",
            })
        );
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(await page.findByRole("menuitem", { name: /^Logs/u }));
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
        await waitFor(
            async () => {
                const dialog = page.getByRole("dialog", {
                    name: "Scan Docker updates?",
                });
                await expect(
                    within(dialog).getByText(/queue outcome could not be confirmed/iu)
                ).toBeVisible();
                await expect(dialog).toBeVisible();
            },
            { timeout: 5000 }
        );
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
        await waitFor(
            async () => {
                const dialog = page.getByRole("dialog", {
                    name: "Scan Docker updates?",
                });
                await expect(
                    within(dialog).getByText(
                        "The request could not be completed. Try again."
                    )
                ).toBeVisible();
                await expect(dialog).toBeVisible();
            },
            { timeout: 5000 }
        );
    },
};
