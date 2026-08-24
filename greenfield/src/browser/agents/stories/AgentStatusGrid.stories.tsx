import type { Meta, StoryObj } from "@storybook/tanstack-react";

import type { AgentDefinition, AgentStatus } from "../../../contracts/agentModel.ts";
import { AgentStatusGrid } from "../AgentStatusGrid.tsx";

const timestampMs = 1_800_000_000_000;

const agents = Object.freeze([
    {
        description: "Coordinates Dashboard work and closes operational loops.",
        displayName: "Mira",
        id: "mira-2026",
        role: "primary",
    },
    {
        description: "Implements and verifies focused code changes.",
        displayName: "Coder",
        id: "coder",
        role: "specialist",
    },
    {
        description: "Checks runtime health and reports actionable changes.",
        displayName: "Monitor",
        id: "monitor",
        role: "specialist",
    },
] satisfies readonly AgentDefinition[]);

const mixedStatuses = Object.freeze([
    {
        agentId: "mira-2026",
        currentTask: "Expand the reviewed Storybook component catalog",
        lastActivityAtMs: timestampMs,
        startedAtMs: timestampMs - 25 * 60_000,
        state: "working",
    },
    {
        agentId: "coder",
        lastActivityAtMs: timestampMs - 75 * 60_000,
        state: "idle",
    },
] satisfies readonly AgentStatus[]);

const meta = {
    args: {
        agents,
        statuses: mixedStatuses,
    },
    component: AgentStatusGrid,
    parameters: {
        layout: "padded",
    },
    title: "Agents/AgentStatusGrid",
} satisfies Meta<typeof AgentStatusGrid>;

export default meta;

type Story = StoryObj<typeof meta>;

export const MixedStatus: Story = {};

export const AllIdle: Story = {
    args: {
        statuses: agents.map((agent) => ({
            agentId: agent.id,
            lastActivityAtMs: timestampMs - 60_000,
            state: "idle" as const,
        })),
    },
};

export const StatusUnavailable: Story = {
    args: {
        statuses: [],
    },
};
