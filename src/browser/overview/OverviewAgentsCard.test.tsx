import { describe, expect, test } from "bun:test";

import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";

import type {
    AgentDefinition,
    AgentStatusProjection,
} from "../../contracts/agentModel.ts";
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
        freshness: "fresh",
        gatewayAvailability: "active",
        hasActiveRun: true,
        lastActivityAtMs: timestampMs,
        lastSeenAtMs: timestampMs,
        observedAtMs: timestampMs,
        sessionKey: "agent:main:main",
        startedAtMs: timestampMs - 60_000,
        state: "working",
    },
    {
        agentId: "researcher",
        freshness: "fresh",
        gatewayAvailability: "idle",
        hasActiveRun: false,
        lastActivityAtMs: timestampMs - 120_000,
        lastSeenAtMs: timestampMs - 120_000,
        observedAtMs: timestampMs,
        sessionKey: "agent:researcher:main",
        state: "idle",
    },
] as const satisfies readonly AgentStatusProjection[]);

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
    test("renders separate Dashboard task and Gateway session projections", async () => {
        renderCard({ agents, statuses });

        expect(
            await screen.findByRole("heading", { level: 2, name: "Agent activity" })
        ).toBeTruthy();
        expect(within(metric("Added")).getByText("2")).toBeTruthy();
        expect(within(metric("Working")).getByText("1")).toBeTruthy();
        expect(within(metric("Idle")).getByText("1")).toBeTruthy();
        expect(within(metric("Status unavailable")).getByText("0")).toBeTruthy();
        expect(within(metric("Active")).getByText("1")).toBeTruthy();
        expect(within(metric("Idle sessions")).getByText("1")).toBeTruthy();
        expect(screen.getByText("Complete the Phase 3 overview")).toBeTruthy();
        expect(
            screen.getByText(`Started ${formatDashboardDateTime(timestampMs - 60_000)}`)
        ).toHaveAttribute("dateTime", new Date(timestampMs - 60_000).toISOString());
        expect(
            screen.getByText(/does not prove that the agent is online or healthy/u)
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
                freshness: status.freshness,
                gatewayAvailability: status.gatewayAvailability,
                hasActiveRun: status.hasActiveRun,
                lastActivityAtMs: status.lastActivityAtMs,
                lastSeenAtMs: status.lastSeenAtMs,
                observedAtMs: status.observedAtMs,
                sessionKey: status.sessionKey,
                state: "idle" as const,
            })),
        });

        expect(await screen.findByText("All agents are idle.")).toBeTruthy();
        expect(within(metric("Idle")).getByText("2")).toBeTruthy();
        expect(
            screen.getByText(/does not prove that the agent is online or healthy/u)
        ).toBeTruthy();
    });

    test("discloses a cross-projection mismatch without inventing availability", async () => {
        renderCard({ agents, statuses: statuses.slice(1) });

        expect(
            await screen.findByText(
                "No agent currently reports working. Status is unavailable for one or more agents."
            )
        ).toBeTruthy();
        expect(within(metric("Idle")).getByText("1")).toBeTruthy();
        expect(within(metric("Status unavailable")).getByText("1")).toBeTruthy();
        expect(
            screen.getByText(/does not prove that the agent is online or healthy/u)
        ).toBeTruthy();
    });
});
