import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type {
    GatewaySession,
    ListGatewaySessionsResult,
} from "../../../contracts/gatewaySessions.ts";
import {
    deriveGatewaySessionStats,
    gatewayPrimarySessionKey,
} from "../../../contracts/gatewaySessions.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";
import { gatewaySessionQueryKey } from "../gatewaySessionQueries.ts";

const observedAtMs = Date.now();
const sessions = [
    {
        displayName: "Primary main",
        contextTokens: 272_000,
        hasActiveRun: true,
        key: gatewayPrimarySessionKey,
        kind: "main",
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        sessionId: "primary-session-generation",
        totalTokens: 48_320,
        totalTokensFresh: true,
        updatedAtMs: observedAtMs,
    },
    {
        channel: "webchat",
        contextTokens: 272_000,
        displayName: "Delivery review",
        hasActiveRun: false,
        key: "agent:main:subagent:delivery-review",
        kind: "subagent",
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        sessionId: "delivery-review-generation",
        totalTokens: 12_800,
        totalTokensFresh: true,
        updatedAtMs: observedAtMs - 90_000,
    },
] as const satisfies readonly GatewaySession[];

const freshSnapshot = {
    filter: "ALL",
    projectionTruncated: false,
    sessions: [...sessions],
    source: {
        checkedAtMs: observedAtMs,
        connection: "connected",
        freshness: "fresh",
        observedAtMs,
    },
    stats: deriveGatewaySessionStats(sessions, observedAtMs),
} as const satisfies ListGatewaySessionsResult;

const emptySnapshot = {
    ...freshSnapshot,
    sessions: [],
    stats: deriveGatewaySessionStats([], observedAtMs),
} satisfies ListGatewaySessionsResult;

const lastKnownGoodSnapshot = {
    ...freshSnapshot,
    source: {
        checkedAtMs: observedAtMs + 60_000,
        connection: "disconnected",
        freshness: "stale",
        observedAtMs,
    },
} satisfies ListGatewaySessionsResult;

const notifications = { notifications: [], readCount: 0, unreadCount: 0 } as const;

function sessionsFixtures(
    sessionsFixture = dashboardStoryValue(freshSnapshot),
    mutations: DashboardStoryFixtures["mutations"] = {}
): DashboardStoryFixtures {
    return {
        mutations,
        queries: {
            "gatewaySessions.list": sessionsFixture,
            "notifications.list": dashboardStoryValue(notifications),
        },
    };
}

const pending = dashboardStoryResolver(
    () =>
        new Promise<never>(() => {
            // Intentionally pending to expose the route loading state.
        })
);

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
    title: "Pages/Sessions",
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: { fixtures: sessionsFixtures(pending), route: "/sessions" },
};

export const Fresh: Story = {
    args: { fixtures: sessionsFixtures(), route: "/sessions" },
};

export const Empty: Story = {
    args: {
        fixtures: sessionsFixtures(dashboardStoryValue(emptySnapshot)),
        route: "/sessions",
    },
};

export const LastKnownGood: Story = {
    args: {
        fixtures: sessionsFixtures(dashboardStoryValue(lastKnownGoodSnapshot)),
        route: "/sessions",
    },
};

export const InitialError: Story = {
    args: {
        fixtures: sessionsFixtures(
            dashboardStoryFailure(new TypeError("Safe sessions story failure"))
        ),
        route: "/sessions",
    },
};

export const BackgroundUnavailable: Story = {
    args: {
        fixtures: sessionsFixtures(
            dashboardStoryFailure(new TypeError("Safe background refresh failure"))
        ),
        querySeeds: [
            { key: gatewaySessionQueryKey, updatedAtMs: 1, value: freshSnapshot },
        ],
        route: "/sessions",
    },
};

export const ActionBusy: Story = {
    args: {
        fixtures: sessionsFixtures(undefined, {
            "gatewaySessions.reset": dashboardStoryResolver(
                () =>
                    new Promise<never>(() => {
                        // Keep the confirmed action visibly busy.
                    })
            ),
        }),
        route: "/sessions",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", {
                name: `Actions for Primary main; key ${gatewayPrimarySessionKey}`,
            })
        );
        const body = within(canvasElement.ownerDocument.body);
        await userEvent.click(
            await body.findByRole("menuitem", { name: /Reset session/u })
        );
        const dialog = within(
            await body.findByRole("dialog", { name: "Reset session?" })
        );
        await userEvent.click(dialog.getByRole("button", { name: "Reset session" }));
        await expect(
            dialog.getByRole("button", { name: "Reset session…" })
        ).toBeDisabled();
    },
};

export const UnknownOutcome: Story = {
    args: {
        fixtures: sessionsFixtures(
            dashboardStoryResolver((_input, callIndex) =>
                callIndex === 0
                    ? freshSnapshot
                    : Promise.reject(new TypeError("Safe reconciliation failure"))
            ),
            {
                "gatewaySessions.reset": dashboardStoryFailure(
                    Object.assign(new Error("Safe unknown outcome"), {
                        data: {
                            code: "SERVICE_UNAVAILABLE",
                            reason: "operation_outcome_unknown",
                        },
                    })
                ),
            }
        ),
        route: "/sessions",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", {
                name: `Actions for Primary main; key ${gatewayPrimarySessionKey}`,
            })
        );
        const body = within(canvasElement.ownerDocument.body);
        await userEvent.click(
            await body.findByRole("menuitem", { name: /Reset session/u })
        );
        const dialog = within(
            await body.findByRole("dialog", { name: "Reset session?" })
        );
        await userEvent.click(dialog.getByRole("button", { name: "Reset session" }));
        await waitFor(
            async () => {
                const currentDialog = within(
                    body.getByRole("dialog", { name: "Reset session?" })
                );
                await expect(
                    currentDialog.getByText(
                        /could not confirm whether the action finished/u
                    )
                ).toBeVisible();
            },
            { timeout: 5000 }
        );
    },
};

export const Mobile: Story = {
    args: { fixtures: sessionsFixtures(), route: "/sessions" },
    parameters: { viewport: { defaultViewport: "mobile1" } },
};
