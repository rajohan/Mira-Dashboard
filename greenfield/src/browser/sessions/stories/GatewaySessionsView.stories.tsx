import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";

import type {
    GatewaySession,
    GatewaySessionAction,
    GatewaySessionActionResult,
    ListGatewaySessionsResult,
} from "../../../contracts/gatewaySessions.ts";
import {
    deriveGatewaySessionStats,
    gatewayPrimarySessionKey,
} from "../../../contracts/gatewaySessions.ts";
import { GatewaySessionsView } from "../GatewaySessionsView.tsx";

const timestampMs = 1_800_000_000_000;

function session(
    key: string,
    kind: GatewaySession["kind"],
    displayName: string,
    updatedAtMs: number,
    overrides: Partial<GatewaySession> = {}
): GatewaySession {
    return {
        displayName,
        hasActiveRun: false,
        key,
        kind,
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        totalTokens: 14_500,
        totalTokensFresh: true,
        updatedAtMs,
        ...overrides,
    };
}

const sessions = Object.freeze([
    session(gatewayPrimarySessionKey, "main", "Primary main", timestampMs - 5_000, {
        hasActiveRun: true,
        totalTokens: 48_320,
    }),
    session("agent:coder:main", "subagent", "Coder main", timestampMs - 15_000),
    session(
        "agent:main:subagent:review",
        "subagent",
        "Review subagent",
        timestampMs - 30_000,
        { hasActiveRun: true, totalTokensFresh: false }
    ),
    session("hook:startup", "hook", "Startup hook", timestampMs - 3_700_000, {
        model: undefined,
        modelProvider: undefined,
        totalTokens: undefined,
        totalTokensFresh: false,
    }),
    session("cron:daily-summary", "cron", "Daily summary", timestampMs - 60_000),
]);

const freshSnapshot: ListGatewaySessionsResult = {
    filter: "ALL",
    projectionTruncated: false,
    sessions: [...sessions],
    source: {
        checkedAtMs: timestampMs,
        connection: "connected",
        freshness: "fresh",
        observedAtMs: timestampMs,
    },
    stats: deriveGatewaySessionStats(sessions, timestampMs),
};

const onAction = fn(
    async (
        action: GatewaySessionAction,
        selectedSession: GatewaySession
    ): Promise<GatewaySessionActionResult> => ({
        action,
        key: selectedSession.key,
        outcome: "changed",
        refresh: { snapshot: freshSnapshot, status: "available" },
    })
);

const meta = {
    args: {
        onAction,
        snapshot: freshSnapshot,
    },
    component: GatewaySessionsView,
    parameters: {
        layout: "padded",
    },
    title: "Sessions/GatewaySessionsView",
} satisfies Meta<typeof GatewaySessionsView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FreshCurrentProjection: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("Connected")).toBeVisible();
        await expect(
            canvas.getByRole("table", { name: "Current OpenClaw sessions" })
        ).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: "CRON" }));
        await expect(canvas.getByText("Daily summary")).toBeVisible();
        await expect(canvas.queryByText("Primary main")).not.toBeInTheDocument();
    },
};

export const LastKnownGood: Story = {
    args: {
        snapshot: {
            ...freshSnapshot,
            source: {
                checkedAtMs: timestampMs + 30_000,
                connection: "disconnected",
                freshness: "stale",
                observedAtMs: timestampMs,
            },
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("Last known")).toBeVisible();
        await expect(canvas.getByRole("alert")).toHaveTextContent(
            "last-known-good projection"
        );
    },
};

export const EmptyProjection: Story = {
    args: {
        snapshot: {
            ...freshSnapshot,
            sessions: [],
            stats: deriveGatewaySessionStats([], timestampMs),
        },
    },
    play: async ({ canvasElement }) => {
        await expect(
            within(canvasElement).getByRole("heading", {
                name: "No current sessions",
            })
        ).toBeVisible();
    },
};

export const BoundedMobileCards: Story = {
    args: {
        snapshot: {
            ...freshSnapshot,
            projectionTruncated: true,
        },
    },
    parameters: {
        viewport: { defaultViewport: "mobile1" },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("5+")).toBeVisible();
        await expect(
            canvas.getByText("OpenClaw returned at least 5 current sessions", {
                exact: false,
            })
        ).toBeVisible();
    },
};
