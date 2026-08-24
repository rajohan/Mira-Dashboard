import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { expect, within } from "storybook/test";

import type { IncidentSummary } from "../../../contracts/monitoring.ts";
import { formatDashboardDateTime } from "../../lib/formatDateTime.ts";
import { OverviewIncidentsCard } from "../OverviewIncidentsCard.tsx";

const timestampMs = 1_800_000_000_000;
const incidents = Object.freeze([
    {
        fingerprint: "a".repeat(64),
        firstSeenAtMs: timestampMs - 10_000,
        generation: 2,
        id: "019fe300-0000-7000-8000-000000000051",
        kind: "filesystem",
        lastSeenAtMs: timestampMs,
        monitorKey: "ops-check",
        occurrenceCount: 3,
        severity: "critical",
        state: "active",
        title: "Disk capacity remains critical",
    },
    {
        fingerprint: "b".repeat(64),
        firstSeenAtMs: timestampMs - 20_000,
        generation: 1,
        id: "019fe300-0000-7000-8000-000000000050",
        kind: "service",
        lastSeenAtMs: timestampMs - 1000,
        monitorKey: "service-check",
        occurrenceCount: 1,
        severity: "warning",
        state: "active",
        title: "Service restart pending",
    },
] as const satisfies readonly IncidentSummary[]);

const rootRoute = createRootRoute({ component: Outlet });
const overviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
const incidentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/incidents",
});
rootRoute.addChildren([overviewRoute, incidentsRoute]);

const meta = {
    args: { hasMore: true, incidents },
    component: OverviewIncidentsCard,
    parameters: {
        layout: "padded",
        tanstack: { router: { path: "/", route: overviewRoute } },
    },
    title: "Overview/OverviewIncidentsCard",
} satisfies Meta<typeof OverviewIncidentsCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ActiveWindow: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByRole("heading", { name: "Active incidents" })
        ).toBeVisible();
        await expect(canvas.getByText("Disk capacity remains critical")).toBeVisible();
        await expect(
            canvas.getByText(`Last seen ${formatDashboardDateTime(timestampMs)}`)
        ).toHaveAttribute("dateTime", new Date(timestampMs).toISOString());
        await expect(
            canvas.getByRole("link", { name: "View incidents" })
        ).toHaveAttribute("href", "/incidents");
        await expect(canvas.getByText(/Older active generations/u)).toBeVisible();
    },
};

export const Empty: Story = {
    args: { hasMore: false, incidents: [] },
    play: async ({ canvasElement }) => {
        await expect(
            within(canvasElement).getByText("No persisted active incidents.")
        ).toBeVisible();
    },
};
