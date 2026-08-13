import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, within } from "storybook/test";

import type { JobRunDetail } from "../../../contracts/jobs.ts";
import type {
    ListLogSourcesOutput,
    LogMaintenanceStatusOutput,
    LogSnapshotOutput,
} from "../../../contracts/logs.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtureValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";
import { logSourcesQueryKey } from "../logQueries.ts";

const observedAtMs = 1_800_000_000_000;
const maintenanceRunId = "019fdf70-0000-7000-8000-000000000020";
const sourceCatalog = {
    observedAtMs,
    sources: [
        {
            availability: "available",
            group: "dashboard",
            id: "dashboard.web.stderr",
            label: "Dashboard web stderr",
            modifiedAtMs: observedAtMs,
            sizeBytes: 65_536,
        },
        {
            availability: "available",
            group: "openclaw",
            id: "openclaw.gateway",
            label: "OpenClaw gateway",
            modifiedAtMs: observedAtMs - 1000,
            sizeBytes: 131_072,
        },
        {
            availability: "missing",
            group: "host",
            id: "host.auth",
            label: "Host authentication",
        },
    ],
} as const satisfies ListLogSourcesOutput;

const maintenance = {
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
            state: "queueable",
        },
        {
            id: "host-apport",
            label: "Host Apport log",
            scope: "host",
            state: "queueable",
        },
        {
            id: "host-dpkg",
            label: "Host package log",
            scope: "host",
            state: "queueable",
        },
        {
            id: "host-rsyslog",
            label: "Host system logs",
            scope: "host",
            state: "queueable",
        },
    ],
} as const satisfies LogMaintenanceStatusOutput;

const unavailableMaintenance = {
    ...maintenance,
    policies: maintenance.policies.map((policy) => ({
        ...policy,
        state: "unavailable" as const,
    })),
} satisfies LogMaintenanceStatusOutput;

function snapshot(sourceId = "dashboard.web.stderr"): LogSnapshotOutput {
    return {
        hasEarlier: true,
        lines: [
            {
                id: "a".repeat(64),
                line: '{"component":"http","level":"info","message":"request completed","requestId":"request-42","time":"2027-01-15T08:00:00.000Z"}',
                severity: "info",
            },
            {
                id: "b".repeat(64),
                line: '{"component":"gateway/ws","level":"warn","message":"credential=[REDACTED] reconnect scheduled","time":"2027-01-15T08:00:01.000Z"}',
                severity: "warn",
            },
        ],
        observedAtMs,
        revision: sourceId.startsWith("openclaw") ? "c".repeat(64) : "d".repeat(64),
        scannedBytes: 32_768,
        sourceId,
    };
}

const queuedRun = {
    events: [],
    run: {
        actionKey: "maintenance.rotate-logs",
        attemptCount: 0,
        attemptLimit: 1,
        availableAtMs: observedAtMs,
        cancellationPolicy: "cooperative",
        displayName: "Managed log maintenance",
        eventCount: 1,
        id: maintenanceRunId,
        priority: 0,
        queuedAtMs: observedAtMs,
        resourceClass: "host-heavy",
        resourceKeys: ["host.logs"],
        retrySafe: false,
        state: "queued",
        stateVersion: 1,
        timeoutMs: 300_000,
        triggerType: "system",
        updatedAtMs: observedAtMs,
    },
} as const satisfies JobRunDetail;

const notifications = { notifications: [], readCount: 0, unreadCount: 0 } as const;

function logsFixtures({
    maintenanceFixture = dashboardStoryValue(maintenance),
    mutations = {},
    snapshotFixture = dashboardStoryResolver((input) => {
        const sourceId =
            typeof input === "object" && input !== null && "sourceId" in input
                ? String(input.sourceId)
                : "dashboard.web.stderr";
        return snapshot(sourceId);
    }),
    sourcesFixture = dashboardStoryValue(sourceCatalog),
}: {
    readonly maintenanceFixture?: DashboardStoryFixtureValue;
    readonly mutations?: DashboardStoryFixtures["mutations"];
    readonly snapshotFixture?: DashboardStoryFixtureValue;
    readonly sourcesFixture?: DashboardStoryFixtureValue;
} = {}): DashboardStoryFixtures {
    return {
        mutations,
        queries: {
            "logs.listSources": sourcesFixture,
            "logs.maintenanceStatus": maintenanceFixture,
            "logs.search": snapshotFixture,
            "logs.tail": snapshotFixture,
            "notifications.list": dashboardStoryValue(notifications),
        },
    };
}

const pending = dashboardStoryResolver(
    () =>
        new Promise<never>(() => {
            // Intentionally pending to expose a stable loading or busy state.
        })
);

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    title: "Pages/Logs",
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: {
        fixtures: logsFixtures({
            maintenanceFixture: pending,
            snapshotFixture: pending,
            sourcesFixture: pending,
        }),
        route: "/logs",
    },
};

export const Fresh: Story = { args: { fixtures: logsFixtures(), route: "/logs" } };

export const EmptySearch: Story = {
    args: {
        fixtures: logsFixtures({
            snapshotFixture: dashboardStoryResolver((input) => ({
                ...snapshot(),
                hasEarlier: false,
                lines:
                    typeof input === "object" && input !== null && "query" in input
                        ? []
                        : snapshot().lines,
            })),
        }),
        route: "/logs",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.type(
            await canvas.findByRole("searchbox", { name: "Search logs" }),
            "no-matches"
        );
        await userEvent.click(canvas.getByRole("button", { name: "Search" }));
        await expect(
            await canvas.findByRole("heading", { name: "No matching log lines" })
        ).toBeVisible();
    },
};

export const InitialError: Story = {
    args: {
        fixtures: logsFixtures({
            maintenanceFixture: dashboardStoryFailure(
                new TypeError("Safe maintenance story failure")
            ),
            sourcesFixture: dashboardStoryFailure(
                new TypeError("Safe log inventory story failure")
            ),
        }),
        route: "/logs",
    },
};

export const BrowserRetained: Story = {
    args: {
        fixtures: logsFixtures({
            sourcesFixture: dashboardStoryFailure(
                new TypeError("Safe retained inventory failure")
            ),
        }),
        querySeeds: [{ key: logSourcesQueryKey, updatedAtMs: 1, value: sourceCatalog }],
        route: "/logs",
    },
};

export const MaintenanceUnavailable: Story = {
    args: {
        fixtures: logsFixtures({
            maintenanceFixture: dashboardStoryValue(unavailableMaintenance),
        }),
        route: "/logs",
    },
};

async function openMaintenanceConfirmation(canvasElement: HTMLElement) {
    const canvas = within(canvasElement);
    await userEvent.click(
        await canvas.findByRole("button", {
            name: "Run Managed application and container logs",
        })
    );
    const body = within(canvasElement.ownerDocument.body);
    return within(
        await body.findByRole("dialog", {
            name: "Run Managed application and container logs?",
        })
    );
}

export const Confirmation: Story = {
    args: Fresh.args,
    play: async ({ canvasElement }) => {
        await openMaintenanceConfirmation(canvasElement);
    },
};

export const Busy: Story = {
    args: {
        fixtures: logsFixtures({
            mutations: { "logs.requestMaintenance": pending },
        }),
        route: "/logs",
    },
    play: async ({ canvasElement }) => {
        const dialog = await openMaintenanceConfirmation(canvasElement);
        await userEvent.click(dialog.getByRole("button", { name: "Add to queue" }));
        await expect(
            dialog.getByRole("button", { name: "Adding log maintenance to the queue…" })
        ).toBeDisabled();
    },
};

export const Queued: Story = {
    args: {
        fixtures: {
            ...logsFixtures({
                mutations: {
                    "logs.requestMaintenance": dashboardStoryValue({
                        dryRun: false,
                        jobRunId: maintenanceRunId,
                        policyId: "docker-managed",
                        queued: true,
                    }),
                },
            }),
            queries: {
                ...logsFixtures().queries,
                "jobs.getRun": dashboardStoryValue(queuedRun),
            },
        },
        route: "/logs",
    },
    play: async ({ canvasElement }) => {
        const dialog = await openMaintenanceConfirmation(canvasElement);
        await userEvent.click(dialog.getByRole("button", { name: "Add to queue" }));
        const canvas = within(canvasElement);
        await expect(
            await canvas.findByText(/was added to the queue as job/u)
        ).toBeVisible();
    },
};

export const Error: Story = {
    args: {
        fixtures: logsFixtures({
            mutations: {
                "logs.requestMaintenance": dashboardStoryFailure(
                    new TypeError("Safe maintenance admission failure")
                ),
            },
        }),
        route: "/logs",
    },
    play: async ({ canvasElement }) => {
        const dialog = await openMaintenanceConfirmation(canvasElement);
        await userEvent.click(dialog.getByRole("button", { name: "Add to queue" }));
        await expect(await within(canvasElement).findByRole("alert")).toBeVisible();
    },
};

export const Mobile: Story = {
    args: Fresh.args,
    parameters: { viewport: { defaultViewport: "mobile1" } },
};
