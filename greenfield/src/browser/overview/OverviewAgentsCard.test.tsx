import { describe, expect, test } from "bun:test";

import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";

import type { AgentDefinition, AgentStatus } from "../../contracts/agentModel.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import {
    OverviewAgentsCard,
    type OverviewAgentsCardProps,
} from "./OverviewAgentsCard.tsx";

const { render, screen, within } = await import("@testing-library/react");

const timestampMs = 1_800_000_000_000;
const agents = Object.freeze([
    {
        description: "Primary Dashboard operator",
        displayName: "Mira",
        id: "main",
        role: "primary",
    },
    {
        description: "Focused research specialist",
        displayName: "Researcher",
        id: "researcher",
        role: "specialist",
    },
] as const satisfies readonly AgentDefinition[]);
const statuses = Object.freeze([
    {
        agentId: "main",
        currentTask: "Complete the Phase 3 overview",
        lastActivityAtMs: timestampMs,
        startedAtMs: timestampMs - 60_000,
        state: "working",
    },
    {
        agentId: "researcher",
        lastActivityAtMs: timestampMs - 120_000,
        state: "idle",
    },
] as const satisfies readonly AgentStatus[]);

function renderCard(properties: OverviewAgentsCardProps) {
    const rootRoute = createRootRoute();
    const overviewRoute = createRoute({
        component: () => <OverviewAgentsCard {...properties} />,
        getParentRoute: () => rootRoute,
        path: "/",
    });
    const agentsRoute = createRoute({
        component: () => null,
        getParentRoute: () => rootRoute,
        path: "/agents",
    });
    const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/"] }),
        routeTree: rootRoute.addChildren([overviewRoute, agentsRoute]),
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

describe("OverviewAgentsCard", () => {
    test("renders complete Dashboard-owned current tasks and explicit Gateway scope", async () => {
        renderCard({ agents, statuses });

        expect(
            await screen.findByRole("heading", { level: 2, name: "Agent activity" })
        ).toBeTruthy();
        expect(within(metric("Configured")).getByText("2")).toBeTruthy();
        expect(within(metric("Working")).getByText("1")).toBeTruthy();
        expect(within(metric("Idle")).getByText("1")).toBeTruthy();
        expect(within(metric("Missing projection")).getByText("0")).toBeTruthy();
        expect(screen.getByText("Complete the Phase 3 overview")).toBeTruthy();
        expect(
            screen.getByText(`Started ${formatDashboardDateTime(timestampMs - 60_000)}`)
        ).toHaveAttribute("dateTime", new Date(timestampMs - 60_000).toISOString());
        expect(
            screen.getByText(/Gateway presence and sessions are not included/u)
        ).toBeTruthy();
        expect(screen.getByRole("link", { name: "View agents" })).toHaveAttribute(
            "href",
            "/agents"
        );
    });

    test("describes a complete idle projection without implying Gateway presence", async () => {
        renderCard({
            agents,
            statuses: statuses.map((status) => ({
                agentId: status.agentId,
                lastActivityAtMs: status.lastActivityAtMs,
                state: "idle" as const,
            })),
        });

        expect(await screen.findByText("All configured agents are idle.")).toBeTruthy();
        expect(within(metric("Idle")).getByText("2")).toBeTruthy();
        expect(screen.queryByText(/online/u)).toBeNull();
    });

    test("discloses a cross-projection mismatch without inventing availability", async () => {
        renderCard({ agents, statuses: statuses.slice(1) });

        expect(
            await screen.findByText(
                "No configured agent currently reports working; one or more status projections are missing."
            )
        ).toBeTruthy();
        expect(within(metric("Idle")).getByText("1")).toBeTruthy();
        expect(within(metric("Missing projection")).getByText("1")).toBeTruthy();
        expect(screen.queryByText(/unavailable/u)).toBeNull();
        expect(screen.queryByText(/online/u)).toBeNull();
    });
});
