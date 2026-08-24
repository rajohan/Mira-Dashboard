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

const timestampMs = Date.now();

function session(
    key: string,
    kind: GatewaySession["kind"],
    displayName: string,
    updatedAtMs: number,
    overrides: Partial<GatewaySession> = {}
): GatewaySession {
    return {
        displayName,
        contextTokens: 272_000,
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
    session(gatewayPrimarySessionKey, "main", "Primary main", timestampMs - 5000, {
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
    (
        action: GatewaySessionAction,
        selectedSession: GatewaySession
    ): Promise<GatewaySessionActionResult> =>
        Promise.resolve({
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
} satisfies Meta<typeof GatewaySessionsView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FreshCurrentSessions: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.queryByRole("heading", { name: "Current status" })
        ).not.toBeInTheDocument();
        await expect(canvas.queryByText("Connected")).not.toBeInTheDocument();
        await expect(
            canvas.queryByRole("button", { name: "Refresh" })
        ).not.toBeInTheDocument();
        const table = canvas.getByRole("table", {
            name: "Current OpenClaw sessions",
        });
        await expect(table).toBeVisible();
        await expect(canvas.getByText("Tokens (known only)")).toBeVisible();
        await expect(canvas.getByText("48k / 272k")).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: "CRON" }));
        await expect(within(table).getByText("Daily summary")).toBeVisible();
        await expect(within(table).queryByText("Primary main")).not.toBeInTheDocument();
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
        await expect(canvas.queryByText("Last known")).not.toBeInTheDocument();
        await expect(canvas.getByText(/Showing session data from/u)).toBeVisible();
    },
};

export const EmptySessions: Story = {
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
            canvas.getByText(
                "OpenClaw returned more sessions than this page can show. Showing the first 5."
            )
        ).toBeVisible();
    },
};
