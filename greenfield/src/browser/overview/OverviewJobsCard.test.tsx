import { describe, expect, test } from "bun:test";

import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";

import {
    jobWorkerSummaryMaximum,
    type JobWorkerSummary,
} from "../../contracts/jobModel.ts";
import type { JobQueueSummary } from "../../contracts/jobs.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { OverviewJobsCard, type OverviewJobsCardProps } from "./OverviewJobsCard.tsx";

const { render, screen, within } = await import("@testing-library/react");

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

const summary = Object.freeze({
    activeResourceClasses: ["host-heavy", "light"],
    control: {
        claimingPaused: false,
        updatedAtMs: timestampMs,
        version: 4,
    },
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

function renderCard(properties: OverviewJobsCardProps) {
    const rootRoute = createRootRoute();
    const overviewRoute = createRoute({
        component: () => <OverviewJobsCard {...properties} />,
        getParentRoute: () => rootRoute,
        path: "/",
    });
    const jobsRoute = createRoute({
        component: () => null,
        getParentRoute: () => rootRoute,
        path: "/jobs",
    });
    const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/"] }),
        routeTree: rootRoute.addChildren([overviewRoute, jobsRoute]),
    });
    return render(<RouterProvider router={router} />);
}

function metric(label: string): HTMLElement {
    const container = screen.getByText(label).closest("div");
    if (!(container instanceof HTMLElement)) {
        throw new TypeError(`Missing ${label} metric`);
    }
    return container;
}

describe("OverviewJobsCard", () => {
    test("renders exact Dashboard queue semantics and route ownership", async () => {
        renderCard({ summary });

        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Dashboard background jobs",
            })
        ).toBeTruthy();
        expect(screen.getByText("Accepting new jobs")).toBeTruthy();
        expect(within(metric("queued")).getByText("1")).toBeTruthy();
        expect(within(metric("running")).getByText("2")).toBeTruthy();
        expect(within(metric("failed")).getByText("3")).toBeTruthy();
        expect(within(metric("timed out")).getByText("1")).toBeTruthy();
        expect(within(metric("Workers recently available")).getByText("2")).toBeTruthy();
        expect(
            screen.getByText(formatDashboardDateTime(summary.oldestQueuedAtMs))
        ).toHaveAttribute("dateTime", new Date(summary.oldestQueuedAtMs).toISOString());
        expect(
            screen.getByText(/OpenClaw scheduled jobs are listed separately/u)
        ).toBeTruthy();
        expect(screen.getByRole("link", { name: "View Dashboard jobs" })).toHaveAttribute(
            "href",
            "/jobs"
        );
    });

    test("distinguishes paused claiming from an empty Dashboard queue", async () => {
        renderCard({
            summary: {
                ...summary,
                activeResourceClasses: [],
                control: { ...summary.control, claimingPaused: true },
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
        });

        expect(await screen.findByText("New jobs paused")).toBeTruthy();
        expect(within(metric("queued")).getByText("0")).toBeTruthy();
        expect(within(metric("Workers recently available")).getByText("0")).toBeTruthy();
        expect(within(metric("Oldest waiting since")).getByText("None")).toBeTruthy();
        expect(screen.queryByRole("button", { name: /claim/u })).toBeNull();
    });

    test("does not claim the bounded worker window is a global total", async () => {
        renderCard({
            summary: {
                ...summary,
                workers: Array.from({ length: jobWorkerSummaryMaximum }, (_, index) =>
                    worker(index + 1)
                ),
            },
        });

        await screen.findByRole("heading", {
            level: 2,
            name: "Dashboard background jobs",
        });
        expect(
            within(metric("Workers recently available")).getByText(
                `${jobWorkerSummaryMaximum}+`
            )
        ).toBeTruthy();
    });
});
