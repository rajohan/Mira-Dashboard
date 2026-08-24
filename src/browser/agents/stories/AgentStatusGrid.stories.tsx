import type { Meta, StoryObj } from "@storybook/tanstack-react";

import type {
    AgentDefinition,
    AgentStatusProjection,
} from "../../../contracts/agentModel.ts";
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
        freshness: "fresh",
        gatewayAvailability: "active",
        hasActiveRun: true,
        lastActivityAtMs: timestampMs,
        lastSeenAtMs: timestampMs,
        observedAtMs: timestampMs,
        providerModel: "openai/gpt-5.6-sol",
        sessionKey: "agent:mira-2026:main",
        startedAtMs: timestampMs - 25 * 60_000,
        state: "working",
    },
    {
        agentId: "coder",
        freshness: "stale",
        gatewayAvailability: "stale",
        hasActiveRun: false,
        lastActivityAtMs: timestampMs - 75 * 60_000,
        lastSeenAtMs: timestampMs - 75 * 60_000,
        observedAtMs: timestampMs - 60_000,
        sessionKey: "agent:coder:main",
        state: "idle",
    },
] satisfies readonly AgentStatusProjection[]);

const meta = {
    args: {
        agents,
        statuses: mixedStatuses,
    },
    component: AgentStatusGrid,
    parameters: {
        layout: "padded",
    },
} satisfies Meta<typeof AgentStatusGrid>;

export default meta;

type Story = StoryObj<typeof meta>;

export const MixedStatus: Story = {};

export const AllIdle: Story = {
    args: {
        statuses: agents.map((agent) => ({
            agentId: agent.id,
            freshness: "unavailable" as const,
            gatewayAvailability: "disconnected" as const,
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
