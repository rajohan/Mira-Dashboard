import { describe, expect, jest, test } from "bun:test";

import { ChatWorkspace } from "./ChatWorkspace.tsx";

const { act, render, screen, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const sessionKey = "agent:main:main";

function properties(): Parameters<typeof ChatWorkspace>[0] {
    return {
        attachments: [],
        canSend: true,
        displaySettings: {
            keepThinkingAfterFinal: false,
            showThinking: true,
            showTools: true,
            toolsExpanded: false,
        },
        draft: "Draft",
        onAbort: jest.fn(),
        onAskCompanion: jest.fn(),
        onAttach: jest.fn(),
        onCancelTask: jest.fn(),
        onChangeDraft: jest.fn(),
        onCompact: jest.fn(),
        onDisplaySettingsChange: jest.fn(),
        onHideMessage: jest.fn(),
        onHydrateMessage: jest.fn(),
        onLoadMoreTasks: jest.fn(),
        onLoadOlder: jest.fn(),
        onRemoveAttachment: jest.fn(),
        onResetCompanion: jest.fn(),
        onResetTranscript: jest.fn(),
        onSelectSession: jest.fn(),
        onSelectTask: jest.fn(),
        onSend: jest.fn(),
        onSendSettingsChange: jest.fn(),
        sendSettings: { model: "gpt-5", speed: "standard", thinking: "high" },
        view: {
            activePlans: [],
            backgroundTasks: [],
            backgroundTasksHasNextPage: false,
            backgroundTasksLoading: false,
            backgroundTasksLoadingMore: false,
            companion: { status: "idle" },
            connection: "connected",
            historyHasNextPage: false,
            historyInitialLoading: false,
            historyLoading: false,
            messages: [
                {
                    attachments: [],
                    id: "message-1",
                    parts: [{ kind: "text", text: "Canonical history" }],
                    role: "assistant",
                    sequence: 1,
                    sessionKey,
                },
            ],
            selectedSessionKey: sessionKey,
            sessionsLoading: false,
            sessions: [
                {
                    activeRunCount: 0,
                    displayName: "Mira main",
                    isDefault: true,
                    key: sessionKey,
                    model: "gpt-5",
                    modelOptions: ["gpt-5"],
                    speed: "standard",
                    thinking: "high",
                    thinkingOptions: ["high"],
                    totalTokensFresh: false,
                },
            ],
        },
    };
}

describe("chat workspace", () => {
    test("presents models without provider prefixes but submits canonical values", async () => {
        const user = userEvent.setup();
        const props = properties();
        const selected = props.view.sessions[0]!;
        const onSendSettingsChange = jest.fn();
        render(
            <ChatWorkspace
                {...props}
                onSendSettingsChange={onSendSettingsChange}
                sendSettings={{
                    ...props.sendSettings,
                    fastMode: "auto",
                    model: "gpt-5.6-sol",
                }}
                view={{
                    ...props.view,
                    sessions: [
                        {
                            ...selected,
                            model: "openai/gpt-5.6-sol",
                            modelOptions: ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra"],
                        },
                    ],
                }}
            />
        );
        expect(screen.getByText("gpt-5.6-sol")).toBeVisible();
        expect(screen.queryByText("openai/gpt-5.6-sol")).toBeNull();
        expect(screen.getByLabelText("Model: openai/gpt-5.6-sol")).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Chat settings" }));
        const modelSelect = screen.getByRole("button", { name: /Chat model/u });
        expect(modelSelect).toHaveTextContent("gpt-5.6-sol");
        expect(modelSelect).not.toHaveTextContent("openai/");
        await user.click(modelSelect);
        expect(screen.getByText("OpenAI")).toBeVisible();
        expect(
            screen.getAllByRole("option", { name: "gpt-5.6-sol" })
        ).toHaveLength(1);
        await user.click(screen.getByRole("option", { name: "gpt-5.6-terra" }));
        expect(onSendSettingsChange).toHaveBeenLastCalledWith({
            fastMode: "auto",
            model: "openai/gpt-5.6-terra",
            speed: "standard",
            thinking: "high",
        });
    });

    test("uses the compact Display heading and hoverable enabled controls", async () => {
        const user = userEvent.setup();
        render(<ChatWorkspace {...properties()} />);

        await user.click(screen.getByRole("button", { name: "Chat settings" }));
        expect(screen.getByText("Display", { selector: "p" })).toBeVisible();
        expect(screen.queryByText("Display in this browser")).toBeNull();
        expect(screen.getByRole("button", { name: /Show thinking/iu })).toHaveClass(
            "hover:bg-primary-800"
        );
        expect(screen.getByRole("button", { name: /Show tools/iu })).toHaveClass(
            "hover:bg-primary-800"
        );
    });

    test("replaces automatic fast mode only after an explicit speed change", async () => {
        const user = userEvent.setup();
        const props = properties();
        const onSendSettingsChange = jest.fn();
        render(
            <ChatWorkspace
                {...props}
                onSendSettingsChange={onSendSettingsChange}
                sendSettings={{
                    ...props.sendSettings,
                    fastMode: "auto",
                }}
            />
        );

        await user.click(screen.getByRole("button", { name: "Chat settings" }));
        await user.click(screen.getByRole("button", { name: /Response speed/iu }));
        await user.click(screen.getByRole("option", { name: "Fast" }));
        expect(onSendSettingsChange).toHaveBeenLastCalledWith({
            fastMode: true,
            model: "gpt-5",
            speed: "fast",
            thinking: "high",
        });
    });

    test("labels selected-session token use as current, out of date, or unknown", () => {
        const props = properties();
        const session = props.view.sessions[0]!;
        const rendered = render(
            <ChatWorkspace
                {...props}
                view={{
                    ...props.view,
                    sessions: [
                        {
                            ...session,
                            contextTokens: 200_000,
                            totalTokens: 1200,
                            totalTokensFresh: true,
                        },
                    ],
                }}
            />
        );
        expect(
            screen.getByLabelText("Session token use: 1,200 of 200,000, current")
        ).toBeVisible();
        expect(screen.getByText("1.2k / 200k")).toBeVisible();

        rendered.rerender(
            <ChatWorkspace
                {...props}
                view={{
                    ...props.view,
                    sessions: [
                        {
                            ...session,
                            contextTokens: 200_000,
                            totalTokens: 1200,
                            totalTokensFresh: false,
                        },
                    ],
                }}
            />
        );
        expect(
            screen.getByLabelText("Session token use: 1,200 of 200,000, out of date")
        ).toBeVisible();
        expect(screen.getByText("~1.2k / 200k")).toBeVisible();

        rendered.rerender(<ChatWorkspace {...props} />);
        expect(screen.getByLabelText("Session token use: Unknown")).toBeVisible();
    });

    test("requires confirmation before destructive provider reset", async () => {
        const user = userEvent.setup();
        const props = properties();
        render(<ChatWorkspace {...props} />);

        expect(props.onResetTranscript).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Chat settings" }));
        await user.click(screen.getByRole("button", { name: "Reset" }));
        const dialog = screen.getByRole("dialog", { name: "Reset this chat?" });
        expect(within(dialog).getByText(/Hiding one message affects/u)).toBeVisible();
        await user.click(
            within(dialog).getByRole("button", {
                name: "Reset chat history",
            })
        );
        expect(props.onResetTranscript).toHaveBeenCalledTimes(1);
        expect(props.onResetTranscript).toHaveBeenCalledWith(sessionKey);
    });

    test("isolates companion drafts and reset confirmation across session switches", async () => {
        const user = userEvent.setup();
        const props = properties();
        const otherSession = {
            ...props.view.sessions[0]!,
            displayName: "Mira other",
            isDefault: false,
            key: "agent:other:main",
        };
        const rendered = render(<ChatWorkspace {...props} canAskCompanion />);
        await user.click(screen.getByRole("button", { name: "Open activity panel" }));
        await user.click(screen.getByRole("button", { name: /Chat helper Idle/iu }));
        await user.type(
            screen.getByRole("textbox", { name: "Ask about this chat" }),
            "Session A draft"
        );
        await user.click(screen.getByRole("button", { name: "Chat settings" }));
        await user.click(
            within(screen.getByTestId("chat-settings-surface")).getByRole("button", {
                name: "Reset",
            })
        );

        rendered.rerender(
            <ChatWorkspace
                {...props}
                canAskCompanion
                view={{
                    ...props.view,
                    selectedSessionKey: otherSession.key,
                    sessions: [...props.view.sessions, otherSession],
                }}
            />
        );
        expect(
            rendered.container.querySelector('input[aria-label="Ask chat helper"]')
        ).toHaveValue("");
        const dialog = screen.getByRole("dialog", { name: "Reset this chat?" });
        await user.click(
            within(dialog).getByRole("button", {
                name: "Reset chat history",
            })
        );
        expect(props.onResetTranscript).toHaveBeenCalledWith(sessionKey);
    });

    test("shows background refresh failure without replacing last-known rows", () => {
        const props = properties();
        const rendered = render(
            <ChatWorkspace
                {...props}
                error="Some chat data could not be refreshed."
                view={{ ...props.view, connection: "stale" }}
            />
        );
        expect(screen.getByRole("log", { name: "Messages" })).toBeVisible();
        expect(screen.getByRole("button", { name: "Session" })).toBeVisible();
        const status = screen.getByRole("alert");
        expect(status).toHaveTextContent("Some chat data could not be refreshed.");
        expect(status).not.toHaveTextContent(/Showing the latest saved history/iu);
        expect(
            within(rendered.container.querySelector("header")!).queryByText(
                /Showing the latest saved history/iu
            )
        ).toBeNull();
    });

    test("announces a background warning without stealing composer focus", async () => {
        const props = properties();
        const rendered = render(<ChatWorkspace {...props} />);
        const composer = screen.getByRole("textbox", { name: "Message" });
        await act(
            () =>
                new Promise<void>((resolve) => {
                    requestAnimationFrame(() => resolve());
                })
        );
        await act(async () => {
            composer.focus();
            await Promise.resolve();
        });
        expect(composer).toHaveFocus();

        await act(async () => {
            rendered.rerender(
                <ChatWorkspace
                    {...props}
                    error="Some chat data could not be refreshed."
                />
            );
            await Promise.resolve();
        });
        expect(composer).toHaveFocus();
    });

    test("distinguishes initial session, history, and task loading from true empty states", () => {
        const props = properties();
        const sessions = render(
            <ChatWorkspace
                {...props}
                view={{
                    ...props.view,
                    selectedSessionKey: "",
                    sessions: [],
                    sessionsLoading: true,
                }}
            />
        );
        expect(screen.getByLabelText("Loading OpenClaw chat sessions…")).toBeVisible();
        expect(screen.queryByText("No chat sessions")).toBeNull();
        sessions.unmount();

        render(
            <ChatWorkspace
                {...props}
                view={{
                    ...props.view,
                    backgroundTasksLoading: true,
                    historyInitialLoading: true,
                    messages: [],
                }}
            />
        );
        expect(screen.getByLabelText("Loading chat history…")).toBeVisible();
        expect(screen.queryByText("No messages yet")).toBeNull();
        expect(screen.getByLabelText("Loading background tasks…")).toBeVisible();
        expect(screen.queryByText(/No background tasks/iu)).toBeNull();
    });

    test("loads the next bounded background-task page on demand", async () => {
        const user = userEvent.setup();
        const props = properties();
        render(
            <ChatWorkspace
                {...props}
                view={{
                    ...props.view,
                    backgroundTasks: [
                        {
                            id: "task-1",
                            label: "First task",
                            status: "running",
                        },
                    ],
                    backgroundTasksHasNextPage: true,
                }}
            />
        );
        await user.click(screen.getByRole("button", { name: "Load more tasks" }));
        expect(props.onLoadMoreTasks).toHaveBeenCalledTimes(1);
    });

    test("labels capped history and task windows and returns to latest", async () => {
        const user = userEvent.setup();
        const props = properties();
        const onReturnHistoryToLatest = jest.fn();
        const onReturnTasksToLatest = jest.fn();
        render(
            <ChatWorkspace
                {...props}
                onReturnHistoryToLatest={onReturnHistoryToLatest}
                onReturnTasksToLatest={onReturnTasksToLatest}
                view={{
                    ...props.view,
                    backgroundTasks: [
                        { id: "task-1", label: "Known task", status: "running" },
                    ],
                    backgroundTasksWindowLimited: true,
                    historyWindowLimited: true,
                }}
            />
        );
        expect(
            screen.getByText("Older history is capped to this browser window.")
        ).toBeVisible();
        expect(
            screen.getByText("Only the most recent tasks are shown here.")
        ).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Return to latest history" })
        );
        await user.click(screen.getByRole("button", { name: "Return to latest tasks" }));
        expect(onReturnHistoryToLatest).toHaveBeenCalledTimes(1);
        expect(onReturnTasksToLatest).toHaveBeenCalledTimes(1);
    });

    test("disables every provider write while the source is stale or disconnected", async () => {
        const user = userEvent.setup();
        const props = properties();
        render(
            <ChatWorkspace
                {...props}
                canAskCompanion
                providerWritesDisabled
                selectedTaskId="task-1"
                view={{
                    ...props.view,
                    backgroundTasks: [
                        { id: "task-1", label: "Running task", status: "running" },
                    ],
                    connection: "stale",
                }}
            />
        );
        await user.click(screen.getByRole("button", { name: "Open activity panel" }));
        await user.click(screen.getByRole("button", { name: /Chat helper Idle/iu }));
        await user.click(screen.getByRole("button", { name: "Chat settings" }));
        const settings = within(screen.getByTestId("chat-settings-surface"));
        expect(screen.getByRole("button", { name: /Response speed/iu })).toBeDisabled();
        expect(settings.getByRole("button", { name: "Compact" })).toBeDisabled();
        expect(settings.getByRole("button", { name: "Reset" })).toBeDisabled();
        expect(
            screen.getByRole("textbox", { name: "Ask about this chat" })
        ).toBeDisabled();
        expect(
            screen
                .getAllByRole("button", { name: "Reset" })
                .every((button) => button.hasAttribute("disabled"))
        ).toBeTrue();
        expect(screen.getByRole("button", { name: "Cancel task" })).toBeDisabled();
    });

    test("shows initial optional-panel failures without inventing empty state", async () => {
        const user = userEvent.setup();
        const props = properties();
        const onRetryModels = jest.fn();
        render(
            <ChatWorkspace
                {...props}
                onRetryCompanion={jest.fn()}
                onRetryModels={onRetryModels}
                onRetryTasks={jest.fn()}
                view={{
                    ...props.view,
                    backgroundTasksError: "Background tasks are unavailable.",
                    companionError: "Companion state is unavailable.",
                    modelInventoryError: "Configured models are unavailable.",
                }}
            />
        );
        expect(screen.getByText("Background tasks are unavailable.")).toBeVisible();
        expect(screen.queryByText(/No background tasks/iu)).toBeNull();
        expect(screen.getByText("Companion state is unavailable.")).toBeVisible();
        expect(screen.queryByText("Configured models are unavailable.")).toBeNull();
        await user.click(screen.getByRole("button", { name: "Chat settings" }));
        expect(screen.getByText("Configured models are unavailable.")).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Try loading models again" })
        );
        expect(onRetryModels).toHaveBeenCalledTimes(1);
        await user.click(screen.getByRole("button", { name: "Retry background tasks" }));
        expect(props.view.messages[0]).toBeDefined();
    });

    test("retains validated optional-panel rows during background failures", () => {
        const props = properties();
        render(
            <ChatWorkspace
                {...props}
                selectedTaskId="task-1"
                view={{
                    ...props.view,
                    backgroundTasks: [
                        { id: "task-1", label: "Known task", status: "running" },
                    ],
                    backgroundTasksError: "Task refresh failed.",
                    companion: {
                        answer: "Last-known answer",
                        question: "Status?",
                        status: "ready",
                    },
                    companionError: "Companion refresh failed.",
                    taskDetailError: "Task detail refresh failed.",
                }}
            />
        );
        expect(screen.getAllByText("Known task")).not.toHaveLength(0);
        expect(screen.getByText("Last-known answer")).toBeVisible();
        expect(screen.getByText("Task refresh failed.")).toBeVisible();
        expect(screen.getByText("Companion refresh failed.")).toBeVisible();
        expect(screen.getByText("Task detail refresh failed.")).toBeVisible();
        expect(screen.getByRole("log", { name: "Messages" })).toBeVisible();
    });

    test("keeps task detail beside its row and toggles it from the disclosure", async () => {
        const user = userEvent.setup();
        const props = properties();
        const onSelectTask = jest.fn();
        const taskView = {
            ...props.view,
            backgroundTasks: [
                { id: "task-1", label: "First task", status: "completed" as const },
                { id: "task-2", label: "Second task", status: "running" as const },
            ],
        };
        const rendered = render(
            <ChatWorkspace
                {...props}
                onSelectTask={onSelectTask}
                selectedTaskId="task-1"
                view={taskView}
            />
        );

        const firstTask = screen.getByRole("button", {
            name: "First task Completed",
        });
        const firstDetail = screen.getByRole("region", {
            name: "Task detail: First task",
        });
        expect(firstTask.closest("li")).toContainElement(firstDetail);
        expect(firstTask).toHaveAttribute("aria-expanded", "true");
        expect(
            screen.getByRole("button", { name: "Second task Running" })
        ).toHaveAttribute("aria-expanded", "false");

        await user.click(firstTask);
        expect(onSelectTask).toHaveBeenLastCalledWith(undefined);
        expect(
            screen.queryByRole("button", { name: "Close details for First task" })
        ).toBeNull();

        rendered.rerender(
            <ChatWorkspace
                {...props}
                onSelectTask={onSelectTask}
                selectedTaskId="task-2"
                view={taskView}
            />
        );
        const secondTask = screen.getByRole("button", {
            name: "Second task Running",
        });
        const secondDetail = screen.getByRole("region", {
            name: "Task detail: Second task",
        });
        const rerenderedFirstTask = screen.getByRole("button", {
            name: "First task Completed",
        });
        expect(secondTask.closest("li")).toContainElement(secondDetail);
        expect(rerenderedFirstTask.closest("li")).not.toContainElement(secondDetail);
        expect(secondTask).toHaveAttribute("aria-expanded", "true");
    });

    test("selects an agent's deterministic first session then stays within that agent", async () => {
        const user = userEvent.setup();
        const props = properties();
        const sessions = [
            props.view.sessions[0]!,
            {
                ...props.view.sessions[0]!,
                displayName: "Ops release",
                isDefault: false,
                key: "agent:ops:release",
                updatedAtMs: 20,
            },
            {
                ...props.view.sessions[0]!,
                displayName: "Ops main",
                isDefault: false,
                key: "agent:ops:main",
                updatedAtMs: 10,
            },
            {
                ...props.view.sessions[0]!,
                displayName: "Coder main",
                isDefault: false,
                key: "agent:coder:main",
            },
        ];
        const rendered = render(
            <ChatWorkspace {...props} view={{ ...props.view, sessions }} />
        );
        await user.click(screen.getByRole("button", { name: "Agent" }));
        await user.click(screen.getByRole("option", { name: /ops 2 sessions/iu }));
        expect(props.onSelectSession).toHaveBeenLastCalledWith("agent:ops:main");

        rendered.rerender(
            <ChatWorkspace
                {...props}
                view={{
                    ...props.view,
                    selectedSessionKey: "agent:ops:main",
                    sessions,
                }}
            />
        );
        await user.click(screen.getByRole("button", { name: "Session" }));
        expect(screen.queryByRole("option", { name: /coder/iu })).toBeNull();
        await user.click(screen.getByRole("option", { name: /release/iu }));
        expect(props.onSelectSession).toHaveBeenLastCalledWith("agent:ops:release");
    });

    test("keeps provider namespaces out of session option descriptions", async () => {
        const user = userEvent.setup();
        const props = properties();
        const selected = props.view.sessions[0]!;
        render(
            <ChatWorkspace
                {...props}
                view={{
                    ...props.view,
                    sessions: [
                        { ...selected, model: "openai/gpt-5.6-sol" },
                        {
                            ...selected,
                            displayName: "Mira secondary",
                            isDefault: false,
                            key: "agent:main:secondary",
                            model: "openai/gpt-5.6-terra",
                        },
                    ],
                }}
            />
        );
        await user.click(screen.getByRole("button", { name: "Session" }));
        expect(screen.getByText("gpt-5.6-terra")).toBeVisible();
        expect(screen.queryByText("openai/gpt-5.6-terra")).toBeNull();
    });

    test("keeps settings in message tools and activity on a separate edge drawer", async () => {
        const user = userEvent.setup();
        const props = properties();
        const rendered = render(<ChatWorkspace {...props} />);
        const pageHeader = rendered.container.querySelector("header")!;
        const toolbar = screen.getByTestId("chat-composer-toolbar");
        expect(
            within(pageHeader).queryByRole("button", { name: "Chat settings" })
        ).toBeNull();
        const settings = within(toolbar).getByRole("button", {
            name: "Chat settings",
        });
        expect(settings.className).toContain("bg-transparent");
        expect(settings.className).not.toContain("border-primary");
        expect(
            within(toolbar).queryByRole("button", { name: "Open activity panel" })
        ).toBeNull();

        const open = screen.getByRole("button", { name: "Open activity panel" });
        expect(open).toHaveAttribute("aria-expanded", "false");
        expect(open.textContent).toBe("");
        expect(open.parentElement).toHaveClass(
            "border-primary-700",
            "top-1/2",
            "-translate-y-1/2",
            "items-center",
            "lg:self-stretch",
            "lg:border-l"
        );
        expect(open).toHaveClass(
            "h-10",
            "flex-none",
            "self-center",
            "focus-visible:ring-1",
            "focus-visible:ring-offset-0"
        );
        await user.click(open);
        expect(screen.getByTestId("chat-main-pane")).toHaveClass("hidden", "lg:flex");
        const panel = screen.getByRole("complementary", {
            name: "Chat activity",
        });
        expect(panel).toHaveClass(
            "fixed",
            "inset-2",
            "z-70",
            "flex",
            "border-primary-700",
            "border"
        );
        const close = screen.getByRole("button", { name: "Close activity panel" });
        expect(close).toHaveAttribute("aria-expanded", "true");
        expect(close).toHaveClass("focus-visible:ring-1", "focus-visible:ring-offset-0");
        await user.click(close);
        expect(screen.getByRole("button", { name: "Open activity panel" })).toBeVisible();
    });

    test("uses border-only settings and places populated-view errors above the composer", async () => {
        const user = userEvent.setup();
        const props = properties();
        const rendered = render(
            <ChatWorkspace {...props} error="Refresh failed in the background." />
        );
        const pageHeader = rendered.container.querySelector("header")!;
        expect(
            within(pageHeader).queryByText("Refresh failed in the background.")
        ).toBeNull();
        const error = screen.getByRole("alert");
        const composer = screen.getByRole("region", { name: "Message composer" });
        const transcriptPane = screen.getByTestId("chat-transcript-pane");
        const statusRow = screen.getByTestId("chat-composer-status");
        expect(
            error.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING
        ).not.toBe(0);
        expect(
            transcriptPane.compareDocumentPosition(statusRow) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).not.toBe(0);
        expect(transcriptPane).not.toContainElement(error);
        expect(statusRow).toContainElement(error);
        expect(transcriptPane).not.toContainElement(composer);
        expect(error).toHaveClass("bg-red-950/50");
        expect(screen.queryByRole("button", { name: "Retry chat refresh" })).toBeNull();

        await user.click(screen.getByRole("button", { name: "Chat settings" }));
        expect(document.querySelectorAll(".fixed.inset-0")).toHaveLength(0);
        expect(screen.getByTestId("chat-settings-surface")).toHaveClass(
            "bg-primary-950",
            "border-primary-600"
        );
    });

    test("dismisses only the current status without changing send gating", async () => {
        const user = userEvent.setup();
        const props = properties();
        const rendered = render(
            <ChatWorkspace
                {...props}
                error="Runtime reconciliation is still pending."
                view={{ ...props.view, connection: "stale" }}
            />
        );
        const status = screen.getByRole("alert");
        expect(status).toHaveTextContent("Runtime reconciliation is still pending.");
        expect(status).not.toHaveTextContent(/Showing the latest saved history/iu);
        await user.click(screen.getByRole("button", { name: "Dismiss chat status" }));
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

        rendered.rerender(
            <ChatWorkspace
                {...props}
                error="A newer reconciliation warning arrived."
                view={{ ...props.view, connection: "stale" }}
            />
        );
        expect(screen.getByRole("alert")).toHaveTextContent(
            "A newer reconciliation warning arrived."
        );
        expect(screen.queryByRole("button", { name: /Retry chat/iu })).toBeNull();
    });
});
