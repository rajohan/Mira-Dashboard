import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";

import type {
    TerminalRuntime,
    TerminalSessionSummary,
} from "../../../contracts/terminal.ts";
import { TerminalWorkspace } from "../TerminalWorkspace.tsx";

const runtime: TerminalRuntime = {
    clientMessageMaximumBytes: 16 * 1024,
    defaultLocation: { path: "/", rootId: "dashboard" },
    idleTimeoutMs: 10 * 60 * 1000,
    mode: "pty",
    outputReplayMaximumBytes: 256 * 1024,
    reconnectGraceMs: 15 * 1000,
    roots: [
        { defaultPath: "/", id: "dashboard", label: "Dashboard project" },
        { defaultPath: "/", id: "workspace", label: "Mira workspace" },
    ],
    serverMessageMaximumBytes: 32 * 1024,
    sessionMaximumDurationMs: 30 * 60 * 1000,
    supportsInput: true,
    supportsPty: true,
    supportsResize: true,
    supportsSignals: ["SIGINT", "SIGTERM", "SIGHUP"],
    webSocketProtocol: "mira-terminal-v1",
};
const connectedSession: TerminalSessionSummary = {
    dimensions: { columns: 108, rows: 32 },
    expiresAtMs: 1_800_001_800_000,
    idleExpiresAtMs: 1_800_000_600_000,
    location: { path: "/", rootId: "dashboard" },
    nextSequence: 8,
    replayAvailableFromSequence: 1,
    sessionId: "019fe7a8-03fe-7000-8ea2-874b1ea1b40e",
    startedAtMs: 1_800_000_000_000,
    state: "connected",
};

function StoryTerminalCanvas() {
    return (
        <section
            aria-label="Interactive terminal story canvas"
            className="h-full min-h-96 bg-[#0b0b0c] p-4 font-mono text-sm text-zinc-200"
        >
            <p className="text-emerald-300">operator@dashboard:~/greenfield$</p>
            <p className="mt-1 text-zinc-400">
                Story canvas only — production bytes render exclusively through xterm.
            </p>
        </section>
    );
}

const meta = {
    args: {
        announcement: "Interactive terminal connected.",
        canvas: <StoryTerminalCanvas />,
        dimensions: connectedSession.dimensions,
        location: runtime.defaultLocation,
        onClear: fn(),
        onCopySelection: fn(),
        onEnd: fn(),
        onFocus: fn(),
        onLocation: fn(),
        onRefreshSession: fn(),
        onResume: fn(),
        onStart: fn(),
        phase: "connected",
        runtime,
        session: connectedSession,
        terminalReady: true,
    },
    component: TerminalWorkspace,
    parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TerminalWorkspace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {
    decorators: [
        (StoryComponent) => (
            <div className="bg-primary-900 min-h-screen p-3 sm:p-5">
                <StoryComponent />
            </div>
        ),
    ],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("Connected")).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: "End terminal" }));
        const body = within(canvasElement.ownerDocument.body);
        await expect(
            body.getByRole("dialog", { name: "End interactive terminal?" })
        ).toBeVisible();
    },
};

export const ReconnectingWithReplay: Story = {
    args: {
        announcement: "Connection lost. Reconnecting and restoring recent output.",
        phase: "reconnecting",
    },
};

export const ResynchronizedAfterReplayGap: Story = {
    args: {
        announcement:
            "Some earlier output is no longer available. Showing the newest output.",
        phase: "resyncing",
        replayGap: true,
    },
};

export const ReadyToStart: Story = {
    args: {
        announcement: "Terminal is ready to start.",
        phase: "idle",
        session: undefined,
    },
};

export const ActiveInAnotherTab: Story = {
    args: {
        announcement: "One terminal session is already active.",
        phase: "active-elsewhere",
        session: {
            ...connectedSession,
            state: "connected",
        },
    },
};
