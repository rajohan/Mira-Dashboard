import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type {
    TerminalConnectionTicket,
    TerminalRuntime,
    TerminalSessionSummary,
} from "../../../contracts/terminal.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtureValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";
import type { TerminalSocketConnectionFactory } from "../TerminalBrowser.tsx";
import type { TerminalEmulator } from "../terminalEmulator.ts";

const observedAtMs = 1_800_000_000_000;
const sessionId = "019fe7a8-03fe-7000-8ea2-874b1ea1b40e";
const dockerContainerId = "1".repeat(64);
const runtime = {
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
} as const satisfies TerminalRuntime;

const ticket = {
    afterSequence: 0,
    connectionToken: `${"a".repeat(32)}.${"b".repeat(64)}`,
    expiresAtMs: observedAtMs + 60_000,
    sessionId,
    webSocketProtocol: "mira-terminal-v1",
    webSocketUrl: `/api/terminal/sessions/${sessionId}/socket`,
} as const satisfies TerminalConnectionTicket;

const connectedSession = {
    dimensions: { columns: 80, rows: 24 },
    expiresAtMs: observedAtMs + 1_800_000,
    idleExpiresAtMs: observedAtMs + 600_000,
    location: runtime.defaultLocation,
    nextSequence: 1,
    replayAvailableFromSequence: 1,
    sessionId,
    startedAtMs: observedAtMs,
    state: "connected",
} as const satisfies TerminalSessionSummary;

const notifications = { notifications: [], readCount: 0, unreadCount: 0 } as const;

function terminalFixtures({
    active = dashboardStoryValue({ status: "none" }),
    mutations = {},
    queries = {},
    runtimeFixture = dashboardStoryValue(runtime),
}: {
    readonly active?: ReturnType<typeof dashboardStoryValue>;
    readonly mutations?: DashboardStoryFixtures["mutations"];
    readonly queries?: DashboardStoryFixtures["queries"];
    readonly runtimeFixture?: DashboardStoryFixtureValue;
} = {}): DashboardStoryFixtures {
    return {
        mutations,
        queries: {
            "notifications.list": dashboardStoryValue(notifications),
            "terminal.getActiveSession": active,
            "terminal.getRuntime": runtimeFixture,
            ...queries,
        },
    };
}

function createStoryEmulator(): TerminalEmulator {
    return {
        clear() {},
        copySelection: () => Promise.resolve("empty"),
        dispose() {},
        fit: () => ({ columns: 80, rows: 24 }),
        focus() {},
        open(container) {
            container.textContent = "operator@dashboard:/$";
        },
        onInput: () => () => {},
        reset() {},
        search: () => false,
        setInputEnabled() {},
        write(_data, callback) {
            callback();
        },
    };
}

const createConnectedStorySocketConnection: TerminalSocketConnectionFactory = (
    options
) => {
    void Promise.resolve().then(() => {
        options.callbacks.onOpen();
        options.callbacks.onControl({
            replayAvailableFromSequence: 1,
            resumed: false,
            session: connectedSession,
            type: "ready",
        });
        return true;
    });
    return {
        afterSequence: options.ticket.afterSequence,
        close() {},
        sendControl: () => true,
        sendInput: () => true,
    };
};

const storyTerminalBrowserDependencies = {
    createEmulator: createStoryEmulator,
} as const;

const pending = dashboardStoryResolver(
    () =>
        new Promise<never>(() => {
            // Intentionally pending to keep the requested lifecycle visible.
        })
);

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
    title: "Pages/Terminal",
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
    args: {
        fixtures: terminalFixtures(),
        route: "/terminal",
        terminalBrowserDependencies: storyTerminalBrowserDependencies,
    },
};

export const Connected: Story = {
    args: {
        fixtures: terminalFixtures({
            mutations: { "terminal.prepareSession": dashboardStoryValue(ticket) },
        }),
        route: "/terminal",
        terminalBrowserDependencies: {
            ...storyTerminalBrowserDependencies,
            createSocketConnection: createConnectedStorySocketConnection,
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Start terminal" })
        );
        await expect(await canvas.findByText("Connected")).toBeVisible();
    },
};

function reconnectingSession(replayAvailableFromSequence: number) {
    return {
        ...connectedSession,
        nextSequence: 8,
        replayAvailableFromSequence,
        state: "awaiting-reconnect" as const,
    } satisfies TerminalSessionSummary;
}

export const Reconnecting: Story = {
    args: {
        fixtures: terminalFixtures({
            active: dashboardStoryValue({
                session: reconnectingSession(1),
                status: "active",
            }),
            mutations: { "terminal.prepareResume": pending },
        }),
        route: "/terminal",
        terminalBrowserDependencies: storyTerminalBrowserDependencies,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Resume terminal" })
        );
        await expect(await canvas.findByText("Reconnecting")).toBeVisible();
    },
};

export const ReplayGap: Story = {
    args: {
        fixtures: terminalFixtures({
            active: dashboardStoryValue({
                session: reconnectingSession(6),
                status: "active",
            }),
            mutations: { "terminal.prepareResume": pending },
        }),
        route: "/terminal",
        terminalBrowserDependencies: storyTerminalBrowserDependencies,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Resume terminal" })
        );
        await expect(await canvas.findByText("Resyncing")).toBeVisible();
        await expect(
            canvas.getByText(/Some earlier output is no longer available/u)
        ).toBeVisible();
    },
};

export const ActiveElsewhere: Story = {
    args: {
        fixtures: terminalFixtures({
            active: dashboardStoryValue({
                session: connectedSession,
                status: "active",
            }),
        }),
        route: "/terminal",
        terminalBrowserDependencies: storyTerminalBrowserDependencies,
    },
};

export const DockerHandoff: Story = {
    args: {
        fixtures: terminalFixtures(),
        route: `/terminal?dockerContainerId=${dockerContainerId}`,
        terminalBrowserDependencies: storyTerminalBrowserDependencies,
    },
};

export const Unavailable: Story = {
    args: {
        fixtures: terminalFixtures({
            runtimeFixture: dashboardStoryFailure(
                new TypeError("Safe terminal story failure")
            ),
        }),
        route: "/terminal",
        terminalBrowserDependencies: storyTerminalBrowserDependencies,
    },
};

export const MfaError: Story = {
    args: {
        fixtures: terminalFixtures({
            runtimeFixture: dashboardStoryFailure(
                Object.assign(new Error("Safe step-up story failure"), {
                    data: { code: "UNAUTHORIZED", reason: "step_up_required" },
                })
            ),
        }),
        route: "/terminal",
        terminalBrowserDependencies: storyTerminalBrowserDependencies,
    },
};

export const EnrollmentRequired: Story = {
    args: {
        fixtures: terminalFixtures({
            mutations: {
                "terminal.prepareSession": dashboardStoryFailure(
                    Object.assign(new Error("Safe enrollment-required failure"), {
                        data: {
                            code: "FORBIDDEN",
                            reason: "mfa_enrollment_required",
                        },
                    })
                ),
            },
            queries: {
                "auth.sessions": dashboardStoryValue({ sessions: [] }),
                "automationSecurity.listPrincipals": dashboardStoryValue({
                    activePrincipalCount: 0,
                    principals: [],
                    totalPrincipalCount: 0,
                }),
                "securityAudit.listEvents": dashboardStoryValue({ events: [] }),
            },
        }),
        route: "/terminal",
        terminalBrowserDependencies: storyTerminalBrowserDependencies,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Start terminal" })
        );
        const enrollment = await page.findByRole("dialog", {
            name: "Protect privileged actions",
        });
        const enrollmentRequirement = within(enrollment).getByText(
            "Multi-factor authentication is required before this action can continue."
        );
        await waitFor(async () => {
            await expect(enrollmentRequirement).toBeVisible();
        });
        await expect(enrollment).toBeVisible();
        await expect(
            within(enrollment).getByText(/Register a security key or authenticator app/iu)
        ).toBeVisible();
        await userEvent.click(
            within(enrollment).getByRole("button", {
                name: "Open Dashboard security settings",
            })
        );
        const securityHeading = await canvas.findByRole("heading", {
            level: 1,
            name: "Account security",
        });
        await expect(securityHeading).toBeVisible();
        await expect(
            canvas.getByRole("tab", { name: "Dashboard settings" })
        ).toHaveAttribute("aria-selected", "true");
    },
};

export const Mobile: Story = {
    args: Ready.args,
    parameters: { viewport: { defaultViewport: "mobile1" } },
};
