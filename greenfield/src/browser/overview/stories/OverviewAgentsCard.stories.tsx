import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { expect, within } from "storybook/test";

import type { AgentDefinition, AgentStatus } from "../../../contracts/agentModel.ts";
import { OverviewAgentsCard } from "../OverviewAgentsCard.tsx";

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

const rootRoute = createRootRoute({ component: Outlet });
const overviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
});
const agentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents",
});
rootRoute.addChildren([overviewRoute, agentsRoute]);

const meta = {
    args: { agents, statuses },
    component: OverviewAgentsCard,
    parameters: {
        layout: "padded",
        tanstack: {
            router: {
                path: "/",
                route: overviewRoute,
            },
        },
    },
    title: "Overview/OverviewAgentsCard",
} satisfies Meta<typeof OverviewAgentsCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Working: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByRole("heading", { name: "Agent activity" })
        ).toBeVisible();
        await expect(canvas.getByText("Complete the Phase 3 overview")).toBeVisible();
        await expect(canvas.getByRole("link", { name: "View agents" })).toHaveAttribute(
            "href",
            "/agents"
        );
    },
};

export const AllIdle: Story = {
    args: {
        statuses: statuses.map((status) => ({
            agentId: status.agentId,
            lastActivityAtMs: status.lastActivityAtMs,
            state: "idle" as const,
        })),
    },
    play: async ({ canvasElement }) => {
        await expect(
            within(canvasElement).getByText("All configured agents are idle.")
        ).toBeVisible();
    },
};

export const MissingProjection: Story = {
    args: { statuses: statuses.slice(1) },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("Missing projection")).toBeVisible();
        await expect(
            canvas.getByText(
                "No configured agent currently reports working; one or more status projections are missing."
            )
        ).toBeVisible();
    },
};
