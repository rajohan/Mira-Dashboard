import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { type ComponentProps, useState } from "react";
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test";

import type { ChatDisplayMessage, ChatWorkspaceView } from "../chatTypes.ts";
import { ChatWorkspace } from "../ChatWorkspace.tsx";

const sessionKey = "agent:main:main";
const nowMs = 1_800_000_000_000;
const mobileViewport = { height: 568, width: 320 } as const;
const desktopViewport = { height: 800, width: 1280 } as const;
const mobile390Viewport = { height: 844, width: 390 } as const;

async function settleLayout(): Promise<void> {
    await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
}

async function settleFollowLayout(): Promise<void> {
    for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
}

async function expectStoryViewport(
    canvasElement: HTMLElement,
    { height, width }: Readonly<{ height: number; width: number }>
): Promise<void> {
    await settleLayout();
    const storyWindow = canvasElement.ownerDocument.defaultView;
    if (storyWindow === null) throw new TypeError("Expected a Storybook window");
    await expect(storyWindow.innerWidth).toBe(width);
    await expect(storyWindow.innerHeight).toBe(height);
}

function rectIsFullyWithin(outer: DOMRect, inner: DOMRect): boolean {
    return (
        inner.width > 0 &&
        inner.height > 0 &&
        inner.top >= outer.top &&
        inner.right <= outer.right &&
        inner.bottom <= outer.bottom &&
        inner.left >= outer.left
    );
}

const session = {
    activeRunCount: 1,
    contextTokens: 200_000,
    displayName: "Mira main",
    isDefault: true,
    key: sessionKey,
    model: "openai/gpt-5.6-sol",
    modelOptions: ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra"],
    speed: "fast" as const,
    thinking: "high",
    thinkingOptions: ["low", "medium", "high"],
    totalTokens: 42_000,
    totalTokensFresh: true,
    updatedAtMs: nowMs,
};

const opsMainSession = {
    ...session,
    activeRunCount: 0,
    displayName: "Ops main",
    isDefault: false,
    key: "agent:ops:main",
    model: "openai/gpt-5.6-terra",
    updatedAtMs: nowMs - 2000,
};
const opsReleaseSession = {
    ...opsMainSession,
    displayName: "Ops release",
    key: "agent:ops:release",
    updatedAtMs: nowMs,
};
const coderSession = {
    ...session,
    activeRunCount: 0,
    displayName: "Coder main",
    isDefault: false,
    key: "agent:coder:main",
    updatedAtMs: nowMs - 1000,
};
const visibleSessions = [session, opsMainSession, opsReleaseSession, coderSession];

const messages: readonly ChatDisplayMessage[] = [
    {
        attachments: [],
        delivery: "sent",
        id: "message-user",
        parts: [{ kind: "text", text: "Check the release status." }],
        role: "user",
        sequence: 1,
        sessionKey,
        timestampMs: nowMs - 20_000,
    },
    {
        attachments: [],
        id: "message-assistant",
        parts: [
            {
                kind: "thinking",
                status: "running",
                text: "I should inspect the latest deployment state.",
            },
            {
                callId: "tool-1",
                input: { service: "mira-dashboard" },
                kind: "tool",
                name: "service_status",
                status: "running",
            },
            { kind: "text", text: "The current release is **healthy** and responding." },
        ],
        role: "assistant",
        runId: "019fe633-9133-7ba0-8b80-809dd80dfb39",
        sequence: 2,
        sessionKey,
        timestampMs: nowMs - 10_000,
    },
];

function view(overrides: Partial<ChatWorkspaceView> = {}): ChatWorkspaceView {
    return {
        activePlans: [
            {
                items: [
                    { id: "plan-1", label: "Inspect service", status: "completed" },
                    { id: "plan-2", label: "Check health", status: "in-progress" },
                    { id: "plan-3", label: "Summarize", status: "pending" },
                ],
                runId: "019fe633-9133-7ba0-8b80-809dd80dfb39",
                title: "Active plan",
            },
        ],
        backgroundTasks: [
            {
                detail: "Inspect the latest deployment logs.",
                id: "task-1",
                label: "Review deployment",
                status: "running",
                summary: "Checking service health",
                updatedAtMs: nowMs,
            },
        ],
        backgroundTasksHasNextPage: false,
        backgroundTasksLoading: false,
        backgroundTasksLoadingMore: false,
        companion: {
            answer: "The active run is checking service health.",
            question: "What is happening?",
            status: "ready",
        },
        connection: "connected",
        historyHasNextPage: true,
        historyInitialLoading: false,
        historyLoading: false,
        messages,
        selectedSessionKey: sessionKey,
        sessionsLoading: false,
        sessions: visibleSessions,
        ...overrides,
    };
}

function InteractiveChatWorkspace(
    args: ComponentProps<typeof ChatWorkspace>
): React.JSX.Element {
    const [displaySettings, setDisplaySettings] = useState(args.displaySettings);
    const [draft, setDraft] = useState(args.draft);
    const [selectedSessionKey, setSelectedSessionKey] = useState(
        args.view.selectedSessionKey
    );
    const [selectedTaskId, setSelectedTaskId] = useState(args.selectedTaskId);
    const [sendSettings, setSendSettings] = useState(args.sendSettings);
    return (
        <ChatWorkspace
            {...args}
            displaySettings={displaySettings}
            draft={draft}
            onChangeDraft={(nextDraft) => {
                args.onChangeDraft(nextDraft);
                setDraft(nextDraft);
            }}
            onDisplaySettingsChange={(nextDisplaySettings) => {
                args.onDisplaySettingsChange(nextDisplaySettings);
                setDisplaySettings(nextDisplaySettings);
            }}
            onSelectSession={(nextSessionKey) => {
                args.onSelectSession(nextSessionKey);
                setSelectedSessionKey(nextSessionKey);
            }}
            onSelectTask={(nextTaskId) => {
                args.onSelectTask(nextTaskId);
                setSelectedTaskId(nextTaskId);
            }}
            onSendSettingsChange={(nextSendSettings) => {
                args.onSendSettingsChange(nextSendSettings);
                setSendSettings(nextSendSettings);
            }}
            sendSettings={sendSettings}
            selectedTaskId={selectedTaskId}
            view={{ ...args.view, selectedSessionKey }}
        />
    );
}

async function expectMobileWorkspaceGeometry(canvasElement: HTMLElement): Promise<void> {
    await expectStoryViewport(canvasElement, mobileViewport);
    const canvas = within(canvasElement);
    const storyDocument = canvasElement.ownerDocument;
    const viewportBounds = new DOMRect(
        0,
        0,
        storyDocument.documentElement.clientWidth,
        storyDocument.documentElement.clientHeight
    );
    const workspace = canvas.getByTestId("chat-workspace");
    const composer = canvas.getByRole("region", { name: "Message composer" });
    const toolbar = canvas.getByTestId("chat-composer-toolbar");
    const transcript = canvas.getByRole("log", { name: "Messages" });
    const activityTrigger = canvas.getByRole("button", {
        name: "Open activity panel",
    });
    const modelLabel = canvas.getByText("gpt-5.6-sol");

    await expect(storyDocument.documentElement.scrollWidth).toBeLessThanOrEqual(
        storyDocument.documentElement.clientWidth
    );
    await expect(storyDocument.documentElement.scrollHeight).toBeLessThanOrEqual(
        storyDocument.documentElement.clientHeight
    );
    for (const element of [workspace, composer, toolbar, activityTrigger]) {
        await expect(
            rectIsFullyWithin(viewportBounds, element.getBoundingClientRect())
        ).toBe(true);
    }
    await expect(transcript.clientHeight).toBeGreaterThan(0);
    await expect(transcript.scrollHeight).toBeGreaterThanOrEqual(transcript.clientHeight);
    await expect(modelLabel.scrollWidth).toBeLessThanOrEqual(modelLabel.clientWidth);
    for (const label of [
        "Chat settings",
        "Insert emoji",
        "Start voice input",
        "Attach files",
        "Stop response 1",
        "Send message",
    ]) {
        const control = within(toolbar).getByRole("button", { name: label });
        await expect(
            rectIsFullyWithin(viewportBounds, control.getBoundingClientRect())
        ).toBe(true);
    }
}

async function expectEmptyComposerFlush(
    canvasElement: HTMLElement,
    viewport: Readonly<{ height: number; width: number }>
): Promise<void> {
    await expectStoryViewport(canvasElement, viewport);
    const canvas = within(canvasElement);
    const workspace = canvas.getByTestId("chat-workspace");
    const composer = canvas.getByRole("region", { name: "Message composer" });
    const workspaceBounds = workspace.getBoundingClientRect();
    const composerBounds = composer.getBoundingClientRect();
    const bottomInset = workspaceBounds.bottom - composerBounds.bottom;
    await expect(bottomInset).toBeGreaterThanOrEqual(0);
    await expect(bottomInset).toBeLessThanOrEqual(16);
    await expect(
        canvasElement.ownerDocument.documentElement.scrollHeight
    ).toBeLessThanOrEqual(canvasElement.ownerDocument.documentElement.clientHeight);
}

async function expectStatusRowGeometry(
    canvasElement: HTMLElement,
    viewport: Readonly<{ height: number; width: number }>
): Promise<void> {
    await expectStoryViewport(canvasElement, viewport);
    const canvas = within(canvasElement);
    const transcriptPane = canvas.getByTestId("chat-transcript-pane");
    const transcript = canvas.getByRole("log", { name: "Messages" });
    const composer = canvas.getByRole("region", { name: "Message composer" });
    const status = canvas.getByTestId("chat-composer-status");
    const alert = within(status).getByRole("alert");
    const paneBounds = transcriptPane.getBoundingClientRect();
    const transcriptBounds = transcript.getBoundingClientRect();
    const composerBounds = composer.getBoundingClientRect();
    const statusBounds = status.getBoundingClientRect();
    const alertBounds = alert.getBoundingClientRect();
    const inset = viewport.width >= 640 ? 16 : 12;

    await expect(
        Math.abs(transcriptBounds.bottom - paneBounds.bottom)
    ).toBeLessThanOrEqual(1);
    await expect(Math.abs(paneBounds.bottom - statusBounds.top)).toBeLessThanOrEqual(1);
    await expect(Math.abs(statusBounds.bottom - composerBounds.top)).toBeLessThanOrEqual(
        1
    );
    await expect(alert).toHaveClass("bg-red-950/50");
    await expect(alertBounds.right).toBeLessThanOrEqual(statusBounds.right - inset);
    await expect(alertBounds.left).toBeGreaterThanOrEqual(statusBounds.left + inset);
    await expect(alertBounds.top).toBeGreaterThanOrEqual(statusBounds.top + inset);
    await expect(alertBounds.bottom).toBeLessThanOrEqual(statusBounds.bottom - inset);
    await expect(status.scrollWidth).toBeLessThanOrEqual(status.clientWidth);

    transcript.scrollTop = transcript.scrollHeight;
    await settleLayout();
    const virtualRows = [...transcript.querySelectorAll<HTMLElement>("[data-index]")];
    let finalMessage: HTMLElement | undefined;
    for (const row of virtualRows) {
        if (
            finalMessage === undefined ||
            Number(row.dataset.index) > Number(finalMessage.dataset.index)
        ) {
            finalMessage = row;
        }
    }
    if (finalMessage === undefined) {
        throw new TypeError("Expected a final virtual transcript row");
    }
    await expect(finalMessage.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        transcript.getBoundingClientRect().bottom + 1
    );
    await expect(finalMessage.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        alert.getBoundingClientRect().top
    );
}

const meta = {
    args: {
        abortableRunIds: ["019fe633-9133-7ba0-8b80-809dd80dfb39"],
        attachments: [],
        canSend: true,
        displaySettings: {
            keepThinkingAfterFinal: false,
            showThinking: true,
            showTools: true,
            toolsExpanded: false,
        },
        draft: "Summarize the evidence",
        onAbort: fn(),
        onAskCompanion: fn(),
        onAttach: fn(),
        onCancelTask: fn(),
        onCancelVoiceInput: fn(),
        onChangeDraft: fn(),
        onCompact: fn(),
        onDisplaySettingsChange: fn(),
        onDismissReadAloudError: fn(),
        onDismissVoiceInputError: fn(),
        onHideMessage: fn(),
        onHydrateMessage: fn(),
        onLoadMoreTasks: fn(),
        onLoadOlder: fn(),
        onReadAloud: fn(),
        onRemoveAttachment: fn(),
        onResetCompanion: fn(),
        onResetTranscript: fn(),
        onRetry: fn(),
        onSelectSession: fn(),
        onSelectTask: fn(),
        onSend: fn(),
        onSendSettingsChange: fn(),
        onStartVoiceInput: fn(),
        onStopReadAloud: fn(),
        onStopVoiceInput: fn(),
        readAloud: { phase: "idle" },
        selectedTaskId: "task-1",
        sendSettings: {
            model: "openai/gpt-5.6-sol",
            speed: "fast",
            thinking: "high",
        },
        view: view(),
        voiceInput: { available: true, elapsedMs: 0, phase: "idle" },
    },
    component: ChatWorkspace,
    decorators: [
        (Story) => (
            <div className="bg-primary-900 text-primary-50 h-dvh min-h-0 overflow-hidden sm:p-3">
                <Story />
            </div>
        ),
    ],
    parameters: { layout: "fullscreen" },
    render: InteractiveChatWorkspace,
    title: "Chat/Workspace",
} satisfies Meta<typeof ChatWorkspace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PopulatedStreaming: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const textarea = canvas.getByRole<HTMLTextAreaElement>("textbox", {
            name: "Message",
        });
        await expect(textarea).toHaveValue("Summarize the evidence");
        await expect(
            within(canvasElement.ownerDocument.body).queryByRole("dialog", {
                name: "Chat settings",
            })
        ).not.toBeInTheDocument();
    },
};

export const TaskDetailCanClose: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            canvas.getByRole("button", { name: "Open activity panel" })
        );
        const task = () =>
            canvas.getByRole("button", {
                name: "Review deployment Running",
            });
        await expect(task()).toHaveAttribute("aria-expanded", "true");
        await expect(
            canvas.getByRole("region", { name: "Task detail: Review deployment" })
        ).toBeVisible();

        await userEvent.click(
            canvas.getByRole("button", {
                name: "Close details for Review deployment",
            })
        );
        await expect(task()).toHaveAttribute("aria-expanded", "false");
        await expect(task()).toHaveFocus();
        await expect(
            canvas.queryByRole("region", { name: "Task detail: Review deployment" })
        ).not.toBeInTheDocument();

        await userEvent.click(task());
        await expect(task()).toHaveAttribute("aria-expanded", "true");
        await userEvent.click(task());
        await expect(task()).toHaveAttribute("aria-expanded", "false");
    },
};

export const SlashSuggestions: Story = {
    args: { draft: "/m" },
};

export const CompletedReadAloud: Story = {
    args: {
        abortableRunIds: [],
        activeRunIds: [],
        view: view({
            activePlans: [],
            messages: [
                {
                    attachments: [],
                    id: "completed-read-aloud",
                    parts: [
                        {
                            kind: "thinking",
                            status: "complete",
                            text: "Private working detail is never spoken.",
                        },
                        {
                            callId: "completed-tool",
                            kind: "tool",
                            name: "service_status",
                            output: "Tool output is never spoken.",
                            status: "completed",
                        },
                        {
                            kind: "text",
                            text: "Only the final answer is spoken.",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey,
                    timestampMs: nowMs,
                },
            ],
        }),
    },
};

export const StreamingReadAloudSuppressed: Story = {
    args: {
        abortableRunIds: ["streaming-read-aloud"],
        activeRunIds: ["streaming-read-aloud"],
        view: view({
            activePlans: [],
            messages: [
                {
                    attachments: [],
                    id: "streaming-text",
                    parts: [{ kind: "text", text: "This answer is still streaming." }],
                    role: "assistant",
                    runId: "streaming-read-aloud",
                    sequence: 1,
                    sessionKey,
                },
            ],
        }),
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.queryByRole("button", { name: "Read Mira message aloud" })
        ).not.toBeInTheDocument();
    },
};

export const AgentAndSessionSelection: Story = {};

export const RecordingVoiceInput: Story = {
    args: {
        voiceInput: { available: true, elapsedMs: 65_000, phase: "recording" },
    },
};

export const TranscribingVoiceInput: Story = {
    args: {
        voiceInput: {
            available: true,
            elapsedMs: 65_000,
            phase: "transcribing",
        },
    },
};

export const MultipleActiveRunsMobile: Story = {
    args: {
        abortableRunIds: ["run-one", "run-two", "run-three"],
        voiceInput: { available: true, elapsedMs: 0, phase: "idle" },
    },
    globals: { viewport: { isRotated: false, value: "mobile1" } },
};

export const MobileSettingsOpen: Story = {
    globals: { viewport: { isRotated: false, value: "mobile1" } },
    play: async ({ canvasElement }) => {
        await expectStoryViewport(canvasElement, mobileViewport);
        const canvas = within(canvasElement);
        await userEvent.click(canvas.getByRole("button", { name: "Chat settings" }));
        const surface = within(canvasElement.ownerDocument.body).getByTestId(
            "chat-settings-surface"
        );
        await expect(surface).toBeVisible();
        await expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth);
        const surfaceStyle = getComputedStyle(surface);
        await expect(surfaceStyle.backdropFilter).toBe("none");
        await expect(surfaceStyle.boxShadow).toBe("none");
        await expect(
            canvasElement.ownerDocument.querySelectorAll(".fixed.inset-0")
        ).toHaveLength(0);
        const viewportLayers = [
            ...canvasElement.ownerDocument.body.querySelectorAll<HTMLElement>("body *"),
        ].filter((element) => {
            const style = getComputedStyle(element);
            if (style.position !== "fixed") return false;
            const bounds = element.getBoundingClientRect();
            return (
                bounds.left <= 0 &&
                bounds.top <= 0 &&
                bounds.right >= mobileViewport.width &&
                bounds.bottom >= mobileViewport.height
            );
        });
        await expect(viewportLayers).toHaveLength(0);
    },
};

export const CollapsibleActivity: Story = {
    globals: { viewport: { isRotated: false, value: "desktop1280" } },
    parameters: {
        viewport: {
            options: {
                desktop1280: {
                    name: "1280 px desktop",
                    styles: { height: "800px", width: "1280px" },
                    type: "desktop",
                },
            },
        },
    },
    play: async ({ canvasElement }) => {
        await expectStoryViewport(canvasElement, desktopViewport);
        const canvas = within(canvasElement);
        const open = canvas.getByRole("button", { name: "Open activity panel" });
        const rail = open.parentElement;
        if (rail === null) throw new TypeError("Expected the collapsed Activity rail");
        await expect(open).toHaveAttribute("aria-expanded", "false");
        const railStyle = getComputedStyle(rail);
        await expect(railStyle.borderLeftWidth).toBe("1px");
        await expect(railStyle.borderLeftStyle).toBe("solid");
        await expect(railStyle.borderLeftColor).toBe("rgb(42, 45, 51)");
        await expect(railStyle.boxShadow).toBe("none");
        await expect(open.getBoundingClientRect().width).toBe(40);
        await expect(open.getBoundingClientRect().height).toBe(40);
    },
};

export const LongCompanionMobile: Story = {
    args: {
        view: view({
            companion: {
                answer: Array.from(
                    { length: 24 },
                    (_, index) => `Evidence line ${index + 1}: chat helper detail.`
                ).join("\n"),
                question:
                    "Summarize every relevant deployment observation without clipping the final action.",
                status: "ready",
            },
        }),
    },
    globals: { viewport: { isRotated: false, value: "mobile1" } },
    name: "Long chat helper answer — activity open (mobile)",
    play: async ({ canvasElement }) => {
        await expectStoryViewport(canvasElement, mobileViewport);
        const canvas = within(canvasElement);
        await userEvent.click(
            canvas.getByRole("button", { name: "Open activity panel" })
        );
        const panel = canvas.getByRole("complementary", { name: "Chat activity" });
        const companionButton = canvas.getByRole("button", {
            name: /Chat helper Ready/iu,
        });
        const companionSection = companionButton.closest("section");
        if (companionSection === null) {
            throw new TypeError("Expected the Companion disclosure section");
        }
        await expect(
            companionSection.getBoundingClientRect().height
        ).toBeGreaterThanOrEqual(341);
        panel.scrollTop = panel.scrollHeight;
        await settleLayout();
        await expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
        await expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
        const answer = canvas.getByLabelText("Chat helper answer");
        const answerText = answer.firstChild;
        if (!(answerText instanceof Text)) {
            throw new TypeError("Expected a text-only Chat helper answer");
        }
        const finalLineStart = answerText.data.lastIndexOf("Evidence line 24");
        const finalLineRange = answer.ownerDocument.createRange();
        finalLineRange.setStart(answerText, finalLineStart);
        finalLineRange.setEnd(answerText, answerText.length);
        const stickyHeader = panel.querySelector("header");
        if (stickyHeader === null) {
            throw new TypeError("Expected the sticky Activity header");
        }
        let finalLineBounds = finalLineRange.getBoundingClientRect();
        const stickyBounds = stickyHeader.getBoundingClientRect();
        if (finalLineBounds.top < stickyBounds.bottom) {
            panel.scrollTop -= stickyBounds.bottom - finalLineBounds.top + 4;
            await settleLayout();
            finalLineBounds = finalLineRange.getBoundingClientRect();
        }
        const panelBounds = panel.getBoundingClientRect();
        await expect(finalLineBounds.width).toBeGreaterThan(0);
        await expect(finalLineBounds.height).toBeGreaterThan(0);
        await expect(finalLineBounds.top).toBeGreaterThanOrEqual(
            stickyHeader.getBoundingClientRect().bottom
        );
        await expect(finalLineBounds.bottom).toBeLessThanOrEqual(panelBounds.bottom);
        for (const control of [
            canvas.getByRole("textbox", { name: "Ask chat helper" }),
            canvas.getByRole("button", { name: "Ask chat helper" }),
            canvas.getByRole("button", { name: "Reset" }),
        ]) {
            control.scrollIntoView({ block: "nearest" });
            await settleLayout();
            await expect(
                rectIsFullyWithin(
                    panel.getBoundingClientRect(),
                    control.getBoundingClientRect()
                )
            ).toBe(true);
        }
    },
};

export const Empty: Story = {
    args: {
        abortableRunIds: [],
        canSend: false,
        draft: "",
        view: view({
            activePlans: [],
            backgroundTasks: [],
            companion: { status: "idle" },
            historyHasNextPage: false,
            messages: [],
        }),
    },
    play: async ({ canvasElement }) => {
        await settleLayout();
        const canvas = within(canvasElement);
        const workspace = canvas.getByTestId("chat-workspace");
        const composer = canvas.getByRole("region", { name: "Message composer" });
        const bottomInset =
            workspace.getBoundingClientRect().bottom -
            composer.getBoundingClientRect().bottom;
        await expect(bottomInset).toBeGreaterThanOrEqual(0);
        await expect(bottomInset).toBeLessThanOrEqual(16);
    },
};

export const EmptyMobile320: Story = {
    args: Empty.args,
    globals: { viewport: { isRotated: false, value: "mobile1" } },
    play: async ({ canvasElement }) => {
        await expectEmptyComposerFlush(canvasElement, mobileViewport);
    },
};

export const EmptyMobile390: Story = {
    args: Empty.args,
    globals: { viewport: { isRotated: false, value: "mobile390" } },
    parameters: {
        viewport: {
            options: {
                mobile390: {
                    name: "390 px mobile",
                    styles: { height: "844px", width: "390px" },
                    type: "mobile",
                },
            },
        },
    },
    play: async ({ canvasElement }) => {
        await expectEmptyComposerFlush(canvasElement, mobile390Viewport);
    },
};

export const StaleLastKnownGood: Story = {
    name: "Out-of-date connection",
    args: {
        canSend: false,
        error: "Some chat data could not be updated. The latest available messages remain visible.",
        view: view({ connection: "stale" }),
    },
    globals: { viewport: { isRotated: false, value: "mobile1" } },
    play: async ({ canvasElement }) => {
        await expectMobileWorkspaceGeometry(canvasElement);
        const canvas = within(canvasElement);
        const status = canvas.getByRole("alert");
        await expect(status).toHaveTextContent(
            "Some chat data could not be updated. The latest available messages remain visible."
        );
        await expect(status).not.toHaveTextContent(/Showing the latest saved history/iu);
        await expectStatusRowGeometry(canvasElement, mobileViewport);
    },
};

export const StaleLastKnownGoodDesktop: Story = {
    args: StaleLastKnownGood.args,
    globals: { viewport: { isRotated: false, value: "desktop1280" } },
    parameters: {
        viewport: {
            options: {
                desktop1280: {
                    name: "1280 px desktop",
                    styles: { height: "800px", width: "1280px" },
                    type: "desktop",
                },
            },
        },
    },
    play: async ({ canvasElement }) => {
        await expectStatusRowGeometry(canvasElement, desktopViewport);
    },
};

export const StaleLastKnownGood390: Story = {
    args: StaleLastKnownGood.args,
    globals: { viewport: { isRotated: false, value: "mobile390" } },
    parameters: {
        viewport: {
            options: {
                mobile390: {
                    name: "390 px mobile",
                    styles: { height: "844px", width: "390px" },
                    type: "mobile",
                },
            },
        },
    },
    play: async ({ canvasElement }) => {
        await expectStatusRowGeometry(canvasElement, mobile390Viewport);
    },
};

export const DisconnectedWithDraft: Story = {
    args: {
        canSend: false,
        draft: "This draft stays local while reconnecting",
        view: view({ connection: "disconnected" }),
    },
};

export const SidePanelsUnavailable: Story = {
    args: {
        view: view({
            backgroundTasks: [],
            backgroundTasksError: "Background tasks are unavailable. Retry to load them.",
            companion: { status: "idle" },
            companionError: "The chat helper is unavailable. Try loading it again.",
            modelInventoryError:
                "Configured models could not be refreshed. Current session controls remain available.",
        }),
    },
    name: "Side panels — unavailable",
};

export const SidePanelLastKnownData: Story = {
    args: {
        view: view({
            backgroundTasksError:
                "Background tasks could not be updated. The latest available tasks remain visible.",
            companionError:
                "The chat helper could not be updated. The latest available answer remains visible.",
            taskDetailError:
                "Task detail could not be refreshed. The summary remains visible.",
        }),
    },
    name: "Side panels — latest available data",
};

export const PendingAttachment: Story = {
    args: {
        attachments: [
            {
                file: new File(["report"], "report.pdf", {
                    type: "application/pdf",
                }),
                id: "attachment-1",
                mediaType: "application/pdf",
                name: "report.pdf",
                progress: 64,
                sizeBytes: 6,
                status: "uploading",
            },
        ],
        canSend: false,
    },
    globals: { viewport: { isRotated: false, value: "desktop1280" } },
    parameters: {
        viewport: {
            options: {
                desktop1280: {
                    name: "1280 px desktop",
                    styles: { height: "800px", width: "1280px" },
                    type: "desktop",
                },
            },
        },
    },
    play: async ({ canvasElement }) => {
        await expectStoryViewport(canvasElement, desktopViewport);
        const canvas = within(canvasElement);
        const list = canvas.getByRole("list", { name: "Prepared attachments" });
        const row = within(list).getByRole("listitem");
        await expect(row.getBoundingClientRect().width).toBeLessThanOrEqual(384);
        await expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(48);
        await expect(row.querySelector(".lucide-eye")).toBeNull();
        await expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
    },
};

export const PreparedAttachmentsMobile: Story = {
    args: {
        attachments: [
            {
                file: new File(["image"], `${"release-".repeat(20)}map.png`, {
                    type: "image/png",
                }),
                id: "compact-image",
                mediaType: "image/png",
                name: `${"release-".repeat(20)}map.png`,
                progress: 100,
                sizeBytes: 340_000,
                status: "ready",
            },
            {
                file: new File(["audio"], "operator-note.ogg", {
                    type: "audio/ogg",
                }),
                id: "compact-audio",
                mediaType: "audio/ogg",
                name: "operator-note.ogg",
                progress: 62,
                sizeBytes: 820_000,
                status: "uploading",
            },
            {
                error: "Upload ticket expired. Remove and attach again.",
                file: new File(["pdf"], "failed-report.pdf", {
                    type: "application/pdf",
                }),
                id: "compact-error",
                mediaType: "application/pdf",
                name: "failed-report.pdf",
                progress: 0,
                sizeBytes: 1_250_000,
                status: "error",
            },
        ],
        canSend: false,
    },
    globals: { viewport: { isRotated: false, value: "mobile1" } },
    play: async ({ canvasElement }) => {
        await expectStoryViewport(canvasElement, mobileViewport);
        const canvas = within(canvasElement);
        const list = canvas.getByRole("list", { name: "Prepared attachments" });
        const viewportBounds = new DOMRect(
            0,
            0,
            mobileViewport.width,
            mobileViewport.height
        );
        await expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
        const rows = within(list).getAllByRole("listitem");
        await expect(list.clientHeight).toBeLessThanOrEqual(48);
        await expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
        await expect(rows[0]!.getBoundingClientRect().height).toBeLessThanOrEqual(48);
        await expect(
            rectIsFullyWithin(viewportBounds, rows[0]!.getBoundingClientRect())
        ).toBe(true);
        await expect(rows[0]!.querySelector(".lucide-eye")).toBeNull();
    },
};

export const AttachmentPickerOpenMobile: Story = {
    args: {
        attachments: [
            {
                file: new File(["image"], "release-map.png", {
                    type: "image/png",
                }),
                id: "picker-image",
                mediaType: "image/png",
                name: "release-map.png",
                progress: 100,
                sizeBytes: 340_000,
                status: "ready",
            },
            {
                file: new File(["audio"], "operator-note.ogg", {
                    type: "audio/ogg",
                }),
                id: "picker-audio",
                mediaType: "audio/ogg",
                name: "operator-note.ogg",
                progress: 62,
                sizeBytes: 820_000,
                status: "uploading",
            },
            {
                error: "Upload ticket expired. Remove and attach again.",
                file: new File(["pdf"], "failed-report.pdf", {
                    type: "application/pdf",
                }),
                id: "picker-pdf",
                mediaType: "application/pdf",
                name: "failed-report.pdf",
                progress: 0,
                sizeBytes: 1_250_000,
                status: "error",
            },
            {
                file: new File(['{"status":"ready"}'], "evidence.json", {
                    type: "application/json",
                }),
                id: "picker-json",
                mediaType: "application/json",
                name: "evidence.json",
                progress: 0,
                sizeBytes: 18,
                status: "preparing",
            },
        ],
        canSend: false,
    },
    globals: { viewport: { isRotated: false, value: "mobile1" } },
    play: async ({ canvasElement }) => {
        await expectStoryViewport(canvasElement, mobileViewport);
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(canvas.getByRole("button", { name: "Attach files" }));
        const dialog = await waitFor(() =>
            page.getByRole("dialog", { name: "Attach files" })
        );
        const dropZone = within(dialog).getByRole("button", {
            name: /Drop files here or choose files/iu,
        });
        await waitFor(async () => {
            await expect(dialog).toBeVisible();
            await expect(dropZone).toBeVisible();
        });
        const close = within(dialog).getByRole("button", { name: "Close dialog" });
        await expect(
            rectIsFullyWithin(
                new DOMRect(0, 0, mobileViewport.width, mobileViewport.height),
                close.getBoundingClientRect()
            )
        ).toBe(true);
        for (const name of [
            "release-map.png",
            "operator-note.ogg",
            "failed-report.pdf",
            "evidence.json",
        ]) {
            await expect(within(dialog).getByText(name)).toBeVisible();
        }
        const done = within(dialog).getByRole("button", { name: "Done" });
        done.scrollIntoView({ block: "center" });
        await waitFor(async () => {
            await expect(
                rectIsFullyWithin(
                    new DOMRect(0, 0, mobileViewport.width, mobileViewport.height),
                    done.getBoundingClientRect()
                )
            ).toBe(true);
        });
        await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    },
};

export const TallAssistantBubbleMobile: Story = {
    args: {
        abortableRunIds: [],
        view: view({
            activePlans: [],
            messages: [
                {
                    attachments: [],
                    id: "tall-assistant",
                    parts: [
                        {
                            kind: "text",
                            text: Array.from(
                                { length: 80 },
                                (_, index) => `Tall response line ${index + 1}.`
                            ).join("\n\n"),
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey,
                },
            ],
        }),
    },
    globals: { viewport: { isRotated: false, value: "mobile1" } },
    play: async ({ canvasElement }) => {
        await expectStoryViewport(canvasElement, mobileViewport);
        const canvas = within(canvasElement);
        const transcript = canvas.getByRole("log", { name: "Messages" });
        const composer = canvas.getByRole("region", { name: "Message composer" });
        const transcriptBounds = transcript.getBoundingClientRect();
        const composerBounds = composer.getBoundingClientRect();
        await expect(transcriptBounds.bottom).toBeLessThanOrEqual(composerBounds.top);
        const hitTarget = canvasElement.ownerDocument.elementFromPoint(
            composerBounds.left + composerBounds.width / 2,
            composerBounds.top + Math.min(24, composerBounds.height / 2)
        );
        await expect(composer.contains(hitTarget)).toBe(true);
    },
};

export const ToolFailure: Story = {
    args: {
        abortableRunIds: [],
        view: view({
            activePlans: [],
            messages: [
                {
                    ...messages[1]!,
                    parts: [
                        {
                            callId: "tool-failed",
                            error: "Service unavailable",
                            kind: "tool",
                            name: "service_status",
                            output: "No private diagnostic body is exposed.",
                            status: "failed",
                        },
                    ],
                },
            ],
        }),
    },
};

export const HydrationRequired: Story = {
    args: {
        view: view({
            messages: [
                {
                    attachments: [],
                    hydration: "required",
                    id: "large-message",
                    parts: [
                        {
                            kind: "control",
                            text: "Large message preview…",
                            tone: "warning",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey,
                },
            ],
        }),
    },
};

export const LongHistory: Story = {
    args: {
        view: view({
            messages: Array.from({ length: 250 }, (_, index) => ({
                attachments: [],
                id: `history-${index}`,
                parts: [
                    {
                        kind: "text" as const,
                        text: `History message ${index + 1}`,
                    },
                ],
                role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
                sequence: index + 1,
                sessionKey,
                timestampMs: nowMs + index,
            })),
        }),
    },
    play: async ({ canvasElement }) => {
        await settleFollowLayout();
        const canvas = within(canvasElement);
        const transcript = canvas.getByRole("log", { name: "Messages" });
        await expect(
            transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
        ).toBeLessThanOrEqual(32);
        await expect(
            canvas.queryByRole("button", { name: "Back to latest" })
        ).not.toBeInTheDocument();
    },
};

export const FollowMessagesMobile: Story = {
    args: LongHistory.args,
    globals: { viewport: { isRotated: false, value: "mobile1" } },
    play: async ({ canvasElement }) => {
        await expectStoryViewport(canvasElement, mobileViewport);
        await settleFollowLayout();
        const canvas = within(canvasElement);
        const transcript = canvas.getByRole("log", { name: "Messages" });
        const composer = canvas.getByRole("region", { name: "Message composer" });
        await expect(transcript.scrollHeight).toBeGreaterThan(transcript.clientHeight);

        await fireEvent.wheel(transcript, { deltaY: -500 });
        transcript.scrollTop = Math.max(
            0,
            transcript.scrollHeight - transcript.clientHeight - 500
        );
        await fireEvent.scroll(transcript);
        const follow = await waitFor(() =>
            canvas.getByRole("button", { name: "Back to latest" })
        );
        const transcriptBounds = transcript.getBoundingClientRect();
        const followBounds = follow.getBoundingClientRect();
        const composerBounds = composer.getBoundingClientRect();
        await expect(followBounds.top).toBeGreaterThanOrEqual(transcriptBounds.top);
        await expect(followBounds.top - transcriptBounds.top).toBeLessThanOrEqual(20);
        await expect(followBounds.right).toBeLessThanOrEqual(transcriptBounds.right);
        await expect(followBounds.bottom).toBeLessThanOrEqual(transcriptBounds.bottom);
        await expect(followBounds.bottom).toBeLessThanOrEqual(composerBounds.top);
        await expect(transcript.scrollWidth).toBeLessThanOrEqual(transcript.clientWidth);

        await userEvent.click(follow);
        await waitFor(async () => {
            await expect(
                transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
            ).toBeLessThanOrEqual(32);
            await expect(
                canvas.queryByRole("button", { name: "Back to latest" })
            ).not.toBeInTheDocument();
        });
    },
};

export const Mobile: Story = {
    globals: {
        viewport: { isRotated: false, value: "mobile1" },
    },
    play: async ({ canvasElement }) => {
        await expectMobileWorkspaceGeometry(canvasElement);
    },
};

export const InitialFailure: Story = {
    args: {
        error: "Chat inventory is unavailable.",
        view: view({ selectedSessionKey: "", sessions: [] }),
    },
};
