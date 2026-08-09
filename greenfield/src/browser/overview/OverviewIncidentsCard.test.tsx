import { describe, expect, test } from "bun:test";

import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";

import type { IncidentSummary } from "../../contracts/monitoring.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import {
    OverviewIncidentsCard,
    type OverviewIncidentsCardProps,
} from "./OverviewIncidentsCard.tsx";

const { render, screen, within } = await import("@testing-library/react");

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

function renderCard(properties: OverviewIncidentsCardProps) {
    const rootRoute = createRootRoute();
    const overviewRoute = createRoute({
        component: () => <OverviewIncidentsCard {...properties} />,
        getParentRoute: () => rootRoute,
        path: "/",
    });
    const incidentsRoute = createRoute({
        component: () => null,
        getParentRoute: () => rootRoute,
        path: "/incidents",
    });
    const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/"] }),
        routeTree: rootRoute.addChildren([overviewRoute, incidentsRoute]),
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

describe("OverviewIncidentsCard", () => {
    test("discloses persisted active generations without claiming current health", async () => {
        renderCard({ hasMore: true, incidents });

        expect(
            await screen.findByRole("heading", { level: 2, name: "Active incidents" })
        ).toBeTruthy();
        expect(within(metric("Newest 12")).getByText("2")).toBeTruthy();
        expect(within(metric("Critical")).getByText("1")).toBeTruthy();
        expect(within(metric("Error")).getByText("0")).toBeTruthy();
        expect(screen.getByText("Disk capacity remains critical")).toBeTruthy();
        expect(screen.getByText("generation 2")).toBeTruthy();
        expect(screen.getByText("ops-check · 3 occurrences")).toBeTruthy();
        expect(
            screen.getByText(`Last seen ${formatDashboardDateTime(timestampMs)}`)
        ).toHaveAttribute("dateTime", new Date(timestampMs).toISOString());
        expect(screen.getByText(/not a current monitor-health verdict/u)).toBeTruthy();
        expect(
            screen.getByText(
                "Older active generations are available on the incidents route."
            )
        ).toBeTruthy();
        expect(screen.getByRole("link", { name: "View incidents" })).toHaveAttribute(
            "href",
            "/incidents"
        );
    });

    test("renders an explicit empty active-generation result", async () => {
        renderCard({ hasMore: false, incidents: [] });

        expect(await screen.findByText("No persisted active incidents.")).toBeTruthy();
        expect(within(metric("Newest 12")).getByText("0")).toBeTruthy();
        expect(screen.queryByText(/Older active generations/u)).toBeNull();
    });
});
