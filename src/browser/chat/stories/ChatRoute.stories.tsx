import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { onlineManager } from "@tanstack/react-query";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";

import type { ChatMessage, ChatRuntimeSnapshot } from "../../../contracts/chatModel.ts";
import { chatSpeechCapabilitiesPath } from "../../../contracts/chatSpeech.ts";
import {
    deriveGatewaySessionStats,
    gatewayPrimarySessionKey,
    type GatewaySession,
    type ListGatewaySessionsResult,
} from "../../../contracts/gatewaySessions.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";

const nowMs = 1_800_000_000_000;
const activeRunId = "019fe633-9133-7ba0-8b80-809dd80dfb39";
const primarySession = {
    activeRunIds: [],
    contextTokens: 200_000,
    displayName: "Mira main",
    effectiveFastMode: false,
    fastMode: false,
    hasActiveRun: false,
    key: gatewayPrimarySessionKey,
    kind: "main",
    model: "openai/gpt-5.6-sol",
    sessionId: "session-generation-1",
    thinkingLevel: "high",
    thinkingOptions: ["low", "medium", "high"],
    totalTokens: 42_000,
    totalTokensFresh: true,
    updatedAtMs: nowMs,
} as const satisfies GatewaySession;
const streamingSession = {
    ...primarySession,
    activeRunIds: [activeRunId],
    hasActiveRun: true,
} as const satisfies GatewaySession;
const historyMessages = [
    {
        content: {
            kind: "complete",
            parts: [
                {
                    id: "story-user-text",
                    kind: "text",
                    text: "Is the production deployment healthy?",
                },
            ],
        },
        createdAtMs: nowMs - 60_000,
        id: "story-user-message",
        role: "user",
        source: "gateway-history",
    },
    {
        content: {
            kind: "complete",
            parts: [
                {
                    id: "story-assistant-text",
                    kind: "text",
                    text: "The deployment is healthy and all readiness checks passed.",
                },
            ],
        },
        createdAtMs: nowMs - 50_000,
        id: "story-assistant-message",
        role: "assistant",
        source: "gateway-history",
    },
] as const satisfies readonly ChatMessage[];
const activeRuntime = {
    firstSequence: 1,
    parts: [
        { kind: "thinking", sequence: 1, text: "Inspecting service health…" },
        {
            callId: "story-service-status",
            input: "production",
            isError: false,
            kind: "tool",
            name: "service_status",
            phase: "running",
            sequence: 2,
        },
        {
            kind: "assistant",
            sequence: 3,
            text: "I am checking the final readiness signal now…",
        },
    ],
    projectionTruncated: false,
    run: {
        admittedAtMs: nowMs - 2000,
        id: activeRunId,
        reconciliation: "runtime-authoritative",
        sessionKey: gatewayPrimarySessionKey,
        state: "active",
        stateVersion: 1,
        updatedAtMs: nowMs,
    },
    throughSequence: 3,
} as const satisfies ChatRuntimeSnapshot;
const notifications = { notifications: [], readCount: 0, unreadCount: 0 } as const;

function runtimePage(runs: readonly ChatRuntimeSnapshot[] = []) {
    return {
        cursor: "0",
        events: [],
        externalRuns: [],
        externalRunsTruncated: false,
        hasMore: false,
        resetRequired: true,
        runs,
        sessionKey: gatewayPrimarySessionKey,
        transcriptGeneration: 1,
    };
}

function sessionSnapshot(
    freshness: "fresh" | "stale" = "fresh",
    session: GatewaySession = primarySession
): ListGatewaySessionsResult {
    return {
        filter: "ALL",
        projectionTruncated: false,
        sessions: [session],
        source:
            freshness === "fresh"
                ? {
                      checkedAtMs: nowMs,
                      connection: "connected",
                      freshness,
                      observedAtMs: nowMs,
                  }
                : {
                      checkedAtMs: nowMs + 1000,
                      connection: "disconnected",
                      freshness,
                      observedAtMs: nowMs,
                  },
        stats: deriveGatewaySessionStats([session], nowMs),
    };
}

function chatFixtures({
    history = historyMessages,
    overrides = {},
    runtimeRuns = [],
    sessions = sessionSnapshot(),
}: Readonly<{
    history?: readonly ChatMessage[];
    overrides?: Partial<DashboardStoryFixtures>;
    runtimeRuns?: readonly ChatRuntimeSnapshot[];
    sessions?: ListGatewaySessionsResult;
}> = {}): DashboardStoryFixtures {
    return {
        mutations: overrides.mutations,
        queries: {
            "chat.companionState": dashboardStoryValue({ exchanges: [] }),
            "chat.history": dashboardStoryValue({
                messages: history,
                providerPagesRead: 1,
                sessionId: primarySession.sessionId,
                sessionKey: gatewayPrimarySessionKey,
                truncated: false,
            }),
            "chat.listModels": dashboardStoryValue({
                models: [
                    {
                        id: "openai/gpt-5.6-sol",
                        label: "GPT-5.6 Sol",
                        provider: "openai",
                        supportsFastMode: true,
                        thinkingLevels: ["high"],
                    },
                ],
            }),
            "chat.runtime": dashboardStoryValue(runtimePage(runtimeRuns)),
            "gatewaySessions.list": dashboardStoryValue(sessions),
            "notifications.list": dashboardStoryValue(notifications),
            "openClawTasks.list": dashboardStoryValue({ tasks: [] }),
            ...overrides.queries,
        },
    };
}

function codedError(code: string): Error {
    return Object.assign(new Error("Private Storybook chat failure"), {
        data: { code },
    });
}

async function waitForConnectedComposer(canvasElement: HTMLElement) {
    const canvas = within(canvasElement);
    try {
        await waitFor(
            () =>
                expect(canvas.getByTestId("chat-workspace")).toHaveAttribute(
                    "data-connection",
                    "connected"
                ),
            { timeout: 5000 }
        );
    } catch {
        const mainText = canvasElement.querySelector("main")?.textContent?.trim();
        throw new TypeError(
            `Chat workspace did not connect: ${mainText?.slice(0, 800) ?? "missing main"}`
        );
    }
    return canvas;
}

function inputPath(input: RequestInfo | URL): string {
    if (typeof input === "string") return new URL(input, location.origin).pathname;
    if (input instanceof URL) return input.pathname;
    return new URL(input.url).pathname;
}

function installSpeechFetch(speechToText: boolean): () => void {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const path = inputPath(input);
        if (path === chatSpeechCapabilitiesPath) {
            return Promise.resolve(Response.json({ speechToText, textToSpeech: false }));
        }
        return Promise.reject(new TypeError(`Unexpected Storybook fetch: ${path}`));
    };
    return () => {
        globalThis.fetch = originalFetch;
    };
}

function installVoiceEnvironment(): () => void {
    const restoreFetch = installSpeechFetch(true);
    const originalMediaRecorder = globalThis.MediaRecorder;
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices
    );
    globalThis.MediaRecorder = {
        isTypeSupported: () => true,
    } as unknown as typeof MediaRecorder;
    navigator.mediaDevices.getUserMedia = () =>
        new Promise<never>(() => {
            // Keep microphone acquisition pending so recording stays visible.
        });
    return () => {
        restoreFetch();
        globalThis.MediaRecorder = originalMediaRecorder;
        navigator.mediaDevices.getUserMedia = originalGetUserMedia;
    };
}

const meta = {
    beforeEach: () => {
        onlineManager.setOnline(true);
        globalThis.dispatchEvent(new Event("online"));
    },
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PopulatedStreaming: Story = {
    args: {
        fixtures: chatFixtures({
            runtimeRuns: [activeRuntime],
            sessions: sessionSnapshot("fresh", streamingSession),
        }),
        route: "/chat",
    },
};

export const Empty: Story = {
    args: { fixtures: chatFixtures({ history: [] }), route: "/chat" },
    play: async ({ canvasElement }) => {
        const canvas = await waitForConnectedComposer(canvasElement);
        await expect(await canvas.findByText("No messages yet")).toBeVisible();
    },
};

export const LastKnownGood: Story = {
    args: {
        fixtures: chatFixtures({ sessions: sessionSnapshot("stale") }),
        route: "/chat",
    },
};

export const DisconnectedDraft: Story = {
    args: {
        fixtures: chatFixtures(),
        route: "/chat",
    },
    play: async ({ canvasElement }) => {
        const canvas = await waitForConnectedComposer(canvasElement);
        const composer = canvas.getByRole("textbox", { name: "Message" });
        await userEvent.type(composer, "Keep this draft while disconnected");
        globalThis.dispatchEvent(new Event("offline"));
        await expect(composer).toHaveValue("Keep this draft while disconnected");
        await expect(
            await canvas.findByText(/Live chat is unavailable.*Drafts/iu)
        ).toBeVisible();
    },
};

export const InitialError: Story = {
    args: {
        fixtures: {
            queries: {
                "gatewaySessions.list": dashboardStoryFailure(codedError("FORBIDDEN")),
                "notifications.list": dashboardStoryValue(notifications),
            },
        },
        route: "/chat",
    },
};

export const AttachmentBusy: Story = {
    args: {
        fixtures: chatFixtures({
            history: [],
            overrides: {
                mutations: {
                    "chat.prepareAttachmentTicket": dashboardStoryResolver(
                        () =>
                            new Promise<never>(() => {
                                // Keep attachment preparation pending for visual review.
                            })
                    ),
                },
            },
        }),
        route: "/chat",
    },
    play: async ({ canvasElement }) => {
        const canvas = await waitForConnectedComposer(canvasElement);
        const composer = canvas.getByRole("textbox", { name: "Message" });
        const input = canvasElement.querySelector<HTMLInputElement>('input[type="file"]');
        if (input === null) throw new TypeError("Chat attachment input is missing");
        const attachment = new File(["Storybook attachment"], "deployment.txt", {
            type: "text/plain",
        });
        await fireEvent.change(input, { target: { files: [attachment] } });
        await expect(
            await canvas.findByRole("button", { name: "Preview deployment.txt" })
        ).toBeVisible();
        await userEvent.type(composer, "Review this attachment");
        await userEvent.click(canvas.getByRole("button", { name: "Send message" }));
        await expect(
            await canvas.findByRole(
                "progressbar",
                { name: "Upload progress for deployment.txt" },
                { timeout: 5000 }
            )
        ).toBeVisible();
    },
};

export const VoiceBusy: Story = {
    args: { fixtures: chatFixtures({ history: [] }), route: "/chat" },
    beforeEach: installVoiceEnvironment,
    play: async ({ canvasElement }) => {
        const canvas = await waitForConnectedComposer(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Start voice input" })
        );
        await expect(
            await canvas.findByRole("button", { name: "Stop and transcribe" })
        ).toBeVisible();
        await expect(canvas.getByText("Recording")).toBeVisible();
    },
};

export const Mobile: Story = {
    args: { fixtures: chatFixtures(), route: "/chat" },
    globals: { viewport: { isRotated: false, value: "mobile1" } },
};
