import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "./ChatComposer";
import type { ChatSendAttachment } from "./chatTypes";

const textAttachment: ChatSendAttachment = {
    contentBase64: btoa("hello attachment"),
    file: new File(["hello attachment"], "notes.txt", { type: "text/plain" }),
    fileName: "notes.txt",
    id: "att-1",
    kind: "text",
    mimeType: "text/plain",
    sizeBytes: 16,
};

function renderComposer(
    overrides: Partial<React.ComponentProps<typeof ChatComposer>> = {}
) {
    const fileInputReference = createRef<HTMLInputElement>();
    const props = {
        attachments: [] as ChatSendAttachment[],
        canSend: true,
        draft: "",
        fileInputReference,
        isConnected: true,
        isRecording: false,
        isSending: false,
        isTranscribing: false,
        selectedSessionKey: "session-1",
        slashCommandSuggestions: [],
        onApplySlashSuggestion: vi.fn(),
        onAttachFiles: vi.fn(),
        onChangeDraft: vi.fn(),
        onPreview: vi.fn(),
        onRemoveAttachment: vi.fn(),
        onSend: vi.fn(),
        onToggleRecording: vi.fn(),
        ...overrides,
    } satisfies React.ComponentProps<typeof ChatComposer>;

    return {
        fileInputReference,
        props,
        ...render(<ChatComposer {...props} />),
    };
}

describe("ChatComposer", () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    it("edits and sends draft text from keyboard and send button", async () => {
        const user = userEvent.setup();
        const onChangeDraft = vi.fn();
        const onSend = vi.fn();

        renderComposer({ draft: "hello", onChangeDraft, onSend });

        const textarea = screen.getByPlaceholderText(
            "Message, attach files, or use / commands (try /help)"
        );
        await user.type(textarea, "!");
        expect(onChangeDraft).toHaveBeenLastCalledWith("hello!");

        await user.keyboard("{Enter}");
        expect(onSend).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: /Send/ }));
        expect(onSend).toHaveBeenCalledTimes(2);
    });

    it("renders slash suggestions and applies them by click or tab", async () => {
        const user = userEvent.setup();
        const onApplySlashSuggestion = vi.fn();

        renderComposer({
            draft: "/h",
            onApplySlashSuggestion,
            slashCommandSuggestions: [
                {
                    description: "Show help",
                    title: "/help",
                    value: "/help ",
                },
            ],
        });

        await user.click(screen.getByRole("button", { name: /\/help/ }));
        expect(onApplySlashSuggestion).toHaveBeenCalledWith("/help ");

        screen
            .getByPlaceholderText("Message, attach files, or use / commands (try /help)")
            .focus();
        await user.keyboard("{Tab}");
        expect(onApplySlashSuggestion).toHaveBeenCalledWith("/help ");
    });

    it("previews and removes attachments", async () => {
        const user = userEvent.setup();
        const onPreview = vi.fn();
        const onRemoveAttachment = vi.fn();

        renderComposer({
            attachments: [textAttachment],
            onPreview,
            onRemoveAttachment,
        });

        await user.click(screen.getAllByRole("button", { name: /notes.txt/ })[0]);
        expect(onPreview).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: "text",
                mimeType: "text/plain",
                text: "hello attachment",
                title: "notes.txt",
            })
        );

        await user.click(screen.getByRole("button", { name: "Remove notes.txt" }));
        expect(onRemoveAttachment).toHaveBeenCalledWith("att-1");
    });

    it("opens the emoji picker and inserts an emoji at the cursor", async () => {
        const user = userEvent.setup();
        const onChangeDraft = vi.fn();

        renderComposer({ draft: "Hi ", onChangeDraft });

        await user.click(screen.getByRole("button", { name: "Insert emoji" }));
        await user.click(screen.getByRole("button", { name: "Insert 😀" }));

        expect(onChangeDraft).toHaveBeenCalledWith("😀Hi ");
        await waitFor(() => {
            expect(screen.queryByText("Emoji")).not.toBeInTheDocument();
        });
    });

    it("handles file attachment and voice controls", async () => {
        const user = userEvent.setup();
        const onAttachFiles = vi.fn();
        const onToggleRecording = vi.fn();
        const { container, fileInputReference } = renderComposer({
            onAttachFiles,
            onToggleRecording,
        });
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        const clickSpy = vi.spyOn(fileInputReference.current!, "click");

        await user.click(screen.getByRole("button", { name: /Attach/ }));
        expect(clickSpy).toHaveBeenCalledTimes(1);

        const file = new File(["hello"], "hello.txt", { type: "text/plain" });
        fireEvent.change(input, { target: { files: [file] } });
        expect(onAttachFiles).toHaveBeenCalledWith([file]);

        await user.click(screen.getByRole("button", { name: /Voice/ }));
        expect(onToggleRecording).toHaveBeenCalledTimes(1);
    });

    it("disables controls without a selected connected session", () => {
        renderComposer({
            canSend: false,
            isConnected: false,
            selectedSessionKey: "",
        });

        expect(screen.getByPlaceholderText("Choose a session first")).toBeDisabled();
        expect(screen.getByRole("button", { name: /Voice/ })).toBeDisabled();
        expect(screen.getByRole("button", { name: /Attach/ })).toBeDisabled();
        expect(screen.getByRole("button", { name: /Send/ })).toBeDisabled();
    });
});
