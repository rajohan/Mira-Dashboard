import { describe, expect, test } from "bun:test";

import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";

import type { ReportSummary } from "../../contracts/monitoring.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import {
    OverviewReportsCard,
    type OverviewReportsCardProps,
} from "./OverviewReportsCard.tsx";

const { render, screen, within } = await import("@testing-library/react");

const reports = Object.freeze([
    {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
        kind: "daily-brief",
        occurredAtMs: 1_800_000_000_000,
        source: "monitor",
        status: "error",
        summary: "One bounded summary without report body content.",
        title: "Latest operational report",
    },
    {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8827",
        kind: "heartbeat",
        occurredAtMs: 1_799_999_000_000,
        source: "monitor",
        status: "warning",
        title: "Earlier warning",
    },
    {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8826",
        kind: "heartbeat",
        occurredAtMs: 1_799_998_000_000,
        source: "monitor",
        status: "ok",
        title: "Earlier healthy report",
    },
] as const satisfies readonly ReportSummary[]);

function renderCard(properties: OverviewReportsCardProps) {
    const rootRoute = createRootRoute();
    const overviewRoute = createRoute({
        component: () => <OverviewReportsCard {...properties} />,
        getParentRoute: () => rootRoute,
        path: "/",
    });
    const reportsRoute = createRoute({
        component: () => null,
        getParentRoute: () => rootRoute,
        path: "/reports",
    });
    const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/"] }),
        routeTree: rootRoute.addChildren([overviewRoute, reportsRoute]),
    });
    return render(<RouterProvider router={router} />);
}

function countRow(label: string): HTMLElement {
    const row = screen.getByText(label).parentElement;
    if (!(row instanceof HTMLElement)) throw new TypeError(`Missing ${label} row`);
    return row;
}

describe("OverviewReportsCard", () => {
    test("discloses its bounded window and newest validated summary", async () => {
        renderCard({ hasMore: true, reports });

        expect(
            await screen.findByRole("heading", { level: 2, name: "Reports overview" })
        ).toBeTruthy();
        expect(within(countRow("Newest 50")).getByText("3")).toBeTruthy();
        expect(within(countRow("Warnings")).getByText("1")).toBeTruthy();
        expect(within(countRow("Errors")).getByText("1")).toBeTruthy();
        expect(
            screen.getByRole("heading", {
                level: 3,
                name: "Latest operational report",
            })
        ).toBeTruthy();
        expect(screen.getByText("daily brief")).toBeTruthy();
        expect(screen.getByText("error")).toBeTruthy();
        expect(
            screen.getByText(formatDashboardDateTime(reports[0].occurredAtMs))
        ).toHaveAttribute("dateTime", new Date(reports[0].occurredAtMs).toISOString());
        expect(
            screen.getByText("Older reports are available on the reports route.")
        ).toBeTruthy();
        expect(screen.getByRole("link", { name: "View reports" })).toHaveAttribute(
            "href",
            "/reports"
        );
    });

    test("renders an explicit empty window without claiming a total", async () => {
        renderCard({ hasMore: false, reports: [] });

        expect(await screen.findByText("No reports yet.")).toBeTruthy();
        expect(screen.queryByText("Newest 50")).toBeNull();
        expect(screen.getByRole("link", { name: "View reports" })).toBeTruthy();
    });
});
