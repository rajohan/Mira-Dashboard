import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { expect, within } from "storybook/test";

import {
    jobWorkerSummaryMaximum,
    type JobWorkerSummary,
} from "../../../contracts/jobModel.ts";
import type { JobQueueSummary } from "../../../contracts/jobs.ts";
import { formatDashboardDateTime } from "../../lib/formatDateTime.ts";
import { OverviewJobsCard } from "../OverviewJobsCard.tsx";

const timestampMs = 1_800_000_000_000;

function worker(index: number): JobWorkerSummary {
    return {
        activeRunCount: 1,
        capacity: 2,
        heartbeatAtMs: timestampMs,
        id: `019fe300-0000-7000-8000-${String(index).padStart(12, "0")}`,
        releaseId: "a".repeat(40),
        startedAtMs: timestampMs - 3_600_000,
        state: "online",
    };
}

const activeSummary = Object.freeze({
    activeResourceClasses: ["host-heavy", "light"],
    control: { claimingPaused: false, updatedAtMs: timestampMs, version: 4 },
    oldestQueuedAtMs: timestampMs - 60_000,
    stateCounts: {
        cancelled: 2,
        failed: 3,
        queued: 1,
        running: 2,
        succeeded: 18,
        "timed-out": 1,
    },
    workers: [worker(1), worker(2)],
} satisfies JobQueueSummary);

const rootRoute = createRootRoute({ component: Outlet });
const overviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
});
const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs",
});
rootRoute.addChildren([overviewRoute, jobsRoute]);

const meta = {
    args: { summary: activeSummary },
    component: OverviewJobsCard,
    parameters: {
        layout: "padded",
        tanstack: {
            router: {
                path: "/",
                route: overviewRoute,
            },
        },
    },
    title: "Overview/OverviewJobsCard",
} satisfies Meta<typeof OverviewJobsCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ActiveQueue: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByRole("heading", { name: "Dashboard job queue" })
        ).toBeVisible();
        await expect(canvas.getByText("Claiming active")).toBeVisible();
        await expect(
            canvas.getByText(formatDashboardDateTime(activeSummary.oldestQueuedAtMs))
        ).toHaveAttribute(
            "dateTime",
            new Date(activeSummary.oldestQueuedAtMs).toISOString()
        );
        await expect(
            canvas.getByRole("link", { name: "View Dashboard jobs" })
        ).toHaveAttribute("href", "/jobs");
    },
};

export const PausedEmpty: Story = {
    args: {
        summary: {
            ...activeSummary,
            activeResourceClasses: [],
            control: { ...activeSummary.control, claimingPaused: true },
            oldestQueuedAtMs: undefined,
            stateCounts: {
                cancelled: 0,
                failed: 0,
                queued: 0,
                running: 0,
                succeeded: 0,
                "timed-out": 0,
            },
            workers: [],
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("Claiming paused")).toBeVisible();
        await expect(canvas.getByText("None")).toBeVisible();
    },
};

export const BoundedWorkerWindow: Story = {
    args: {
        summary: {
            ...activeSummary,
            workers: Array.from({ length: jobWorkerSummaryMaximum }, (_, index) =>
                worker(index + 1)
            ),
        },
    },
    play: async ({ canvasElement }) => {
        await expect(within(canvasElement).getByText("32+")).toBeVisible();
    },
};
