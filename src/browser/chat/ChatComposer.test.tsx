import { describe, expect, jest, test } from "bun:test";

import { ChatComposer } from "./ChatComposer.tsx";
import { shouldSubmitChatComposer } from "./chatComposerModel.ts";

const { render, screen, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

function renderComposer(overrides: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
    const properties: Parameters<typeof ChatComposer>[0] = {
        attachments: [],
        canSend: true,
        draft: "",
        modelOptions: ["gpt-5.6-sol"],
        onAbort: jest.fn(),
        onAttach: jest.fn(),
        onChangeDraft: jest.fn(),
        onRemoveAttachment: jest.fn(),
        onSend: jest.fn(),
        thinkingOptions: ["high"],
        ...overrides,
    };
    return { properties, rendered: render(<ChatComposer {...properties} />) };
}

describe("chat composer", () => {
    test("exposes a keyboard-operable slash-command combobox", async () => {
        const onChangeDraft = jest.fn();
        const { rendered } = renderComposer({ draft: "/m", onChangeDraft });
        const user = userEvent.setup();
        const composer = screen.getByRole<HTMLTextAreaElement>("textbox", {
            name: "Message",
        });
        expect(composer).toHaveAttribute("aria-autocomplete", "list");
        expect(composer).toHaveAttribute("aria-controls", "chat-slash-suggestions");
        expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
        expect(
            within(screen.getAllByRole("option")[0]!).getByText(
                "Use gpt-5.6-sol for subsequent sends"
            )
        ).toHaveClass("text-primary-200");
        await user.click(composer);
        await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
        expect(onChangeDraft).toHaveBeenCalledWith("/model gpt-5.6-sol");
        rendered.unmount();
    });

    test("applies a Headless UI slash option selected by pointer", async () => {
        const onChangeDraft = jest.fn();
        const { rendered } = renderComposer({ draft: "/m", onChangeDraft });
        const user = userEvent.setup();
        await user.click(screen.getByRole("option", { name: /model gpt-5.6-sol/iu }));
        expect(onChangeDraft).toHaveBeenLastCalledWith("/model gpt-5.6-sol");
        rendered.unmount();
    });

    test("sends on desktop Enter but preserves Shift, IME, and coarse-pointer Enter", () => {
        expect(
            shouldSubmitChatComposer(
                { isComposing: false, key: "Enter", shiftKey: false },
                false
            )
        ).toBe(true);
        expect(
            shouldSubmitChatComposer(
                { isComposing: false, key: "Enter", shiftKey: true },
                false
            )
        ).toBe(false);
        expect(
            shouldSubmitChatComposer(
                { isComposing: true, key: "Enter", shiftKey: false },
                false
            )
        ).toBe(false);
        expect(
            shouldSubmitChatComposer(
                { isComposing: false, key: "Enter", shiftKey: false },
                true
            )
        ).toBe(false);
    });

    test("keeps the session stop control independent from the draft", async () => {
        const onAbort = jest.fn();
        const { rendered } = renderComposer({
            abortableRunId: "run-2",
            draft: "Keep this draft",
            onAbort,
        });
        const user = userEvent.setup();
        const stop = screen.getByRole("button", { name: "Stop response" });
        expect(stop).toHaveClass(
            "bg-red-500/10",
            "text-red-400",
            "hover:bg-red-500/20",
            "data-hover:bg-red-500/20",
            "data-active:bg-red-500/25"
        );
        await user.click(stop);
        expect(onAbort).toHaveBeenCalledWith("run-2");
        expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
            "Keep this draft"
        );
        rendered.unmount();
    });

    test("keeps the icon toolbar on one ordered message-action row", () => {
        const { rendered } = renderComposer({
            abortableRunId: "run-1",
            settingsControl: <button aria-label="Chat settings" type="button" />,
            voiceInput: { available: true, elapsedMs: 0, phase: "idle" },
            onCancelVoiceInput: jest.fn(),
            onStartVoiceInput: jest.fn(),
            onStopVoiceInput: jest.fn(),
        });
        const toolbar = screen.getByTestId("chat-composer-toolbar");
        expect(
            within(toolbar)
                .getAllByRole("button")
                .map((button) => button.getAttribute("aria-label"))
        ).toEqual([
            "Chat settings",
            "Insert emoji",
            "Start voice input",
            "Attach files",
            "Stop response",
            "Send message",
        ]);
        expect(within(toolbar).queryByText("Attach")).toBeNull();
        expect(within(toolbar).queryByText("Send")).toBeNull();
        rendered.unmount();
    });

    test("renders prepared files as bounded legacy-density preview rows", () => {
        const attachment = {
            file: new File(["attachment"], "release-evidence.txt", {
                type: "text/plain",
            }),
            id: "attachment-compact",
            mediaType: "text/plain",
            name: "release-evidence.txt",
            progress: 42,
            sizeBytes: 10,
            status: "uploading" as const,
        };
        const { rendered } = renderComposer({
            attachments: [attachment],
            canSend: false,
        });
        const list = screen.getByRole("list", { name: "Prepared attachments" });
        expect(list).toHaveClass("flex", "flex-wrap", "max-h-12", "overflow-y-auto");
        const row = within(list).getByRole("listitem");
        expect(row).toHaveAttribute("data-compact", "true");
        expect(row).toHaveClass("min-h-12", "max-w-sm", "flex-[1_1_18rem]");
        const preview = within(row).getByRole("button", {
            name: "Preview release-evidence.txt",
        });
        expect(preview).toContainElement(within(row).getByText("release-evidence.txt"));
        expect(within(row).getByText("Uploading 42% · 10 B")).toBeVisible();
        expect(row.querySelector(".lucide-file-text")).toBeInTheDocument();
        expect(row.querySelector(".lucide-eye")).toBeNull();
        expect(
            within(row).getByRole("progressbar", {
                name: "Upload progress for release-evidence.txt",
            })
        ).toHaveValue(42);
        expect(preview).toBeVisible();
        expect(
            within(row).getByRole("button", { name: "Remove release-evidence.txt" })
        ).toBeVisible();
        rendered.unmount();
    });

    test("navigates the expanded emoji grid and inserts at the caret", async () => {
        const onChangeDraft = jest.fn();
        const { rendered } = renderComposer({ draft: "ab", onChangeDraft });
        const user = userEvent.setup();
        const composer = screen.getByRole<HTMLTextAreaElement>("textbox", {
            name: "Message",
        });
        composer.setSelectionRange(1, 1);
        await user.click(screen.getByRole("button", { name: "Insert emoji" }));
        const grid = screen.getByRole("grid", { name: "Emoji picker" });
        expect(within(grid).getAllByRole("cell").length).toBeGreaterThan(24);
        expect(screen.getByRole("button", { name: "Grinning face" })).toHaveFocus();
        await user.keyboard("{ArrowRight}{Enter}");
        expect(onChangeDraft).toHaveBeenLastCalledWith("a😄b");
        rendered.unmount();
    });

    test("shows real recording and transcribing controls without dead actions", async () => {
        const onCancelVoiceInput = jest.fn();
        const onStopVoiceInput = jest.fn();
        const props = {
            onCancelVoiceInput,
            onStartVoiceInput: jest.fn(),
            onStopVoiceInput,
            voiceInput: {
                available: true,
                elapsedMs: 65_000,
                phase: "recording" as const,
            },
        };
        const { properties, rendered } = renderComposer(props);
        const user = userEvent.setup();
        expect(screen.getByLabelText("Voice recording duration")).toHaveTextContent(
            "1:05"
        );
        expect(screen.getByRole("button", { name: "Stop and transcribe" })).toHaveClass(
            "border-red-700",
            "bg-red-700",
            "rounded-full"
        );
        expect(screen.getByText("Recording")).toBeVisible();
        expect(screen.queryByRole("button", { name: "Insert emoji" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
        expect(onStopVoiceInput).toHaveBeenCalledTimes(1);

        rendered.rerender(
            <ChatComposer
                {...properties}
                {...props}
                voiceInput={{
                    available: true,
                    elapsedMs: 65_000,
                    phase: "transcribing",
                }}
            />
        );
        expect(screen.getByLabelText("Voice input status")).toHaveTextContent(
            "Transcribing"
        );
        await user.click(screen.getByRole("button", { name: "Cancel voice input" }));
        expect(onCancelVoiceInput).toHaveBeenCalledTimes(1);
        rendered.unmount();
    });
});
