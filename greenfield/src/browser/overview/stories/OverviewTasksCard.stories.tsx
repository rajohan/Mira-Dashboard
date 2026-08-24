import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { expect, within } from "storybook/test";

import type { TaskSummary } from "../../../contracts/taskModel.ts";
import { OverviewTasksCard } from "../OverviewTasksCard.tsx";

const timestampMs = 1_800_000_000_000;
const tasks = Object.freeze([
    {
        assignee: "mira-2026",
        createdAtMs: timestampMs - 20_000,
        id: "019fe300-0000-7000-8000-000000000031",
        labels: ["rewrite"],
        priority: "high",
        status: "in-progress",
        title: "Complete the greenfield operational overview",
        updatedAtMs: timestampMs,
        version: 3,
    },
    {
        createdAtMs: timestampMs - 30_000,
        id: "019fe300-0000-7000-8000-000000000030",
        labels: [],
        priority: "medium",
        status: "blocked",
        title: "Waiting on a reviewed dependency",
        updatedAtMs: timestampMs - 1000,
        version: 2,
    },
] as const satisfies readonly TaskSummary[]);

const rootRoute = createRootRoute({ component: Outlet });
const overviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
});
const tasksRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/tasks",
});
rootRoute.addChildren([overviewRoute, tasksRoute]);

const meta = {
    args: { hasMore: true, tasks },
    component: OverviewTasksCard,
    parameters: {
        layout: "padded",
        tanstack: {
            router: {
                path: "/",
                route: overviewRoute,
            },
        },
    },
    title: "Overview/OverviewTasksCard",
} satisfies Meta<typeof OverviewTasksCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const UnfinishedWindow: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByRole("heading", { name: "Unfinished tasks" })
        ).toBeVisible();
        await expect(
            canvas.getByText("Complete the greenfield operational overview")
        ).toBeVisible();
        await expect(canvas.getByRole("link", { name: "View tasks" })).toHaveAttribute(
            "href",
            "/tasks"
        );
    },
};

export const Empty: Story = {
    args: { hasMore: false, tasks: [] },
    play: async ({ canvasElement }) => {
        await expect(
            within(canvasElement).getByText("No unfinished tasks.")
        ).toBeVisible();
    },
};
