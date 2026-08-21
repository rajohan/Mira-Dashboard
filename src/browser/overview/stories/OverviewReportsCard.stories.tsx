import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { expect, within } from "storybook/test";

import type { ReportSummary } from "../../../contracts/monitoring.ts";
import { formatDashboardDateTime } from "../../lib/formatDateTime.ts";
import { OverviewReportsCard } from "../OverviewReportsCard.tsx";

const reports = Object.freeze([
    {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
        kind: "daily-brief",
        occurredAtMs: 1_800_000_000_000,
        source: "monitor",
        status: "warning",
        summary: "A short report summary without loading the full report.",
        title: "Daily operational brief",
    },
    {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8827",
        kind: "heartbeat",
        occurredAtMs: 1_799_999_000_000,
        source: "monitor",
        status: "ok",
        title: "Earlier heartbeat",
    },
] as const satisfies readonly ReportSummary[]);

const rootRoute = createRootRoute({ component: Outlet });
const overviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
});
const reportsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/reports",
});
rootRoute.addChildren([overviewRoute, reportsRoute]);

const meta = {
    args: { hasMore: true, reports },
    component: OverviewReportsCard,
    parameters: {
        layout: "padded",
        tanstack: {
            router: {
                path: "/",
                route: overviewRoute,
            },
        },
    },
} satisfies Meta<typeof OverviewReportsCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LatestWindow: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByRole("heading", { name: "Recent reports" })
        ).toBeVisible();
        await expect(canvas.getByText("Daily operational brief")).toBeVisible();
        await expect(canvas.getByText("warning")).toBeVisible();
        await expect(
            canvas.getByText(formatDashboardDateTime(reports[0].occurredAtMs))
        ).toHaveAttribute("dateTime", new Date(reports[0].occurredAtMs).toISOString());
        await expect(canvas.getByRole("link", { name: "View reports" })).toHaveAttribute(
            "href",
            "/reports"
        );
    },
};

export const Empty: Story = {
    args: { hasMore: false, reports: [] },
};
