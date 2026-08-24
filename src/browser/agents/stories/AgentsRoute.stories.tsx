import type { Meta, StoryObj } from "@storybook/tanstack-react";

import type {
    AgentConfiguration,
    AgentStatusProjection,
    AgentTaskRun,
} from "../../../contracts/agentModel.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";

const nowMs = 1_800_000_000_000;
const configuration = {
    agents: [
        {
            description: "Coordinates Dashboard work.",
            displayName: "Mira",
            id: "main",
            role: "primary",
        },
        {
            description: "Researches verified sources.",
            displayName: "Researcher",
            id: "researcher",
            role: "specialist",
        },
    ],
} as const satisfies AgentConfiguration;
const statuses = {
    statuses: [
        {
            agentId: "main",
            currentTask: "Close full-page Storybook coverage",
            freshness: "fresh",
            gatewayAvailability: "active",
            hasActiveRun: true,
            lastActivityAtMs: nowMs,
            lastSeenAtMs: nowMs,
            observedAtMs: nowMs,
            providerModel: "openai/gpt-5.6-sol",
            sessionKey: "agent:main:main",
            startedAtMs: nowMs - 120_000,
            state: "working",
        },
        {
            agentId: "researcher",
            freshness: "unavailable",
            gatewayAvailability: "disconnected",
            state: "idle",
        },
    ],
} as const satisfies { readonly statuses: readonly AgentStatusProjection[] };
const history = {
    runs: [
        {
            agentId: "main",
            id: "019fe000-0000-7000-8000-000000000001",
            lastActivityAtMs: nowMs,
            startedAtMs: nowMs - 120_000,
            status: "active",
            task: "Close full-page Storybook coverage",
        },
    ],
} as const satisfies { readonly runs: readonly AgentTaskRun[] };
const notifications = {
    notifications: [],
    readCount: 0,
    unreadCount: 0,
} as const;

function agentsFixtures(
    overrides: Partial<DashboardStoryFixtures> = {}
): DashboardStoryFixtures {
    return {
        mutations: overrides.mutations,
        queries: {
            "agents.getConfiguration": dashboardStoryValue(configuration),
            "agents.listStatuses": dashboardStoryValue(statuses),
            "agents.listTaskHistory": dashboardStoryValue(history),
            "notifications.list": dashboardStoryValue(notifications),
            ...overrides.queries,
        },
    };
}

const pending = dashboardStoryResolver(
    () =>
        new Promise<never>(() => {
            // Intentionally pending to render the route loading state.
        })
);

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: {
        fixtures: agentsFixtures({
            queries: {
                "agents.getConfiguration": pending,
                "agents.listStatuses": pending,
                "agents.listTaskHistory": pending,
            },
        }),
        route: "/agents",
    },
};

export const Ready: Story = { args: { fixtures: agentsFixtures(), route: "/agents" } };

export const EmptyHistory: Story = {
    args: {
        fixtures: agentsFixtures({
            queries: { "agents.listTaskHistory": dashboardStoryValue({ runs: [] }) },
        }),
        route: "/agents",
    },
};

export const InitialError: Story = {
    args: {
        fixtures: agentsFixtures({
            queries: {
                "agents.listTaskHistory": dashboardStoryFailure(
                    new TypeError("Safe agent story failure")
                ),
            },
        }),
        route: "/agents",
    },
};

export const BrowserRetained: Story = {
    args: {
        fixtures: agentsFixtures({
            queries: {
                "agents.listStatuses": dashboardStoryResolver((_input, callIndex) =>
                    callIndex === 0
                        ? statuses
                        : Promise.reject(new TypeError("Safe retained refresh failure"))
                ),
            },
        }),
        route: "/agents",
    },
};
