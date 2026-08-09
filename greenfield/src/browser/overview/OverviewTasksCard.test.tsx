import { describe, expect, test } from "bun:test";

import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";

import type { TaskSummary } from "../../contracts/taskModel.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { OverviewTasksCard, type OverviewTasksCardProps } from "./OverviewTasksCard.tsx";

const { render, screen, within } = await import("@testing-library/react");

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
    {
        createdAtMs: timestampMs - 40_000,
        id: "019fe300-0000-7000-8000-000000000029",
        labels: [],
        priority: "low",
        status: "todo",
        title: "Prepare the next larger rewrite slice",
        updatedAtMs: timestampMs - 2000,
        version: 1,
    },
] as const satisfies readonly TaskSummary[]);

function renderCard(properties: OverviewTasksCardProps) {
    const rootRoute = createRootRoute();
    const overviewRoute = createRoute({
        component: () => <OverviewTasksCard {...properties} />,
        getParentRoute: () => rootRoute,
        path: "/",
    });
    const tasksRoute = createRoute({
        component: () => null,
        getParentRoute: () => rootRoute,
        path: "/tasks",
    });
    const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/"] }),
        routeTree: rootRoute.addChildren([overviewRoute, tasksRoute]),
    });
    return render(<RouterProvider router={router} />);
}

function metric(label: string): HTMLElement {
    const definition = screen
        .getAllByText(label)
        .find((element) => element.tagName === "DT");
    const container = definition?.closest("div");
    if (!(container instanceof HTMLElement)) {
        throw new TypeError(`Missing ${label} metric`);
    }
    return container;
}

describe("OverviewTasksCard", () => {
    test("discloses its unfinished window and newest task without claiming totals", async () => {
        renderCard({ hasMore: true, tasks });

        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Unfinished tasks",
            })
        ).toBeTruthy();
        expect(within(metric("To do")).getByText("1")).toBeTruthy();
        expect(within(metric("In progress")).getByText("1")).toBeTruthy();
        expect(within(metric("Blocked")).getByText("1")).toBeTruthy();
        expect(
            screen.getByRole("heading", {
                level: 3,
                name: "Complete the greenfield operational overview",
            })
        ).toBeTruthy();
        expect(screen.getByText("high priority")).toBeTruthy();
        expect(screen.getAllByText("In progress").length).toBeGreaterThan(1);
        expect(screen.getByText("Mira")).toBeTruthy();
        expect(
            screen.getByText(`Updated ${formatDashboardDateTime(timestampMs)}`)
        ).toHaveAttribute("dateTime", new Date(timestampMs).toISOString());
        expect(
            screen.getByText("Older unfinished tasks are available on the task board.")
        ).toBeTruthy();
        expect(screen.getByRole("link", { name: "View tasks" })).toHaveAttribute(
            "href",
            "/tasks"
        );
    });

    test("renders an explicit globally empty unfinished-task result", async () => {
        renderCard({ hasMore: false, tasks: [] });

        expect(await screen.findByText("No unfinished tasks.")).toBeTruthy();
        expect(within(metric("To do")).getByText("0")).toBeTruthy();
        expect(screen.queryByText(/Older unfinished tasks/u)).toBeNull();
    });
});
