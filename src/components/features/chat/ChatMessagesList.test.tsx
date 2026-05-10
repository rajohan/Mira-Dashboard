import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatMessagesList } from "./ChatMessagesList";
import type { ChatRow } from "./chatTypes";

vi.mock("./ChatMarkdown", () => ({
    ChatMarkdown: ({ text }: { text: string }) => (
        <div data-testid="markdown">{text}</div>
    ),
}));

vi.mock("./ChatMessageDetails", () => ({
    ChatMessageDetails: ({
        message,
        visibility,
    }: {
        message: { thinking?: Array<{ text: string }>; toolResult?: { content: string } };
        visibility: { showThinking: boolean; showTools: boolean };
    }) => (
        <div data-testid="message-details">
            {visibility.showThinking
                ? message.thinking?.map((item) => item.text).join(",")
                : null}
            {visibility.showTools ? message.toolResult?.content : null}
        </div>
    ),
}));

function makeVirtualizer(rowCount: number) {
    return {
        getTotalSize: () => rowCount * 100,
        getVirtualItems: () =>
            Array.from({ length: rowCount }, (_, index) => ({
                end: (index + 1) * 100,
                index,
                key: `row-${index}`,
                start: index * 100,
            })),
        measureElement: vi.fn(),
    } as never;
}

function makeRows(): ChatRow[] {
    return [
        {
            key: "user-1",
            kind: "message",
            message: {
                content: "hello",
                role: "user",
                text: "Hello Mira",
                timestamp: "2026-05-11T00:00:00.000Z",
            },
        },
        {
            key: "assistant-1",
            kind: "message",
            message: {
                attachments: [
                    {
                        contentBase64: btoa("read me"),
                        fileName: "result.txt",
                        id: "file-1",
                        kind: "text",
                        mimeType: "text/plain",
                        sizeBytes: 7,
                    },
                ],
                content: "hi",
                images: [{ data: btoa("image"), mimeType: "image/png", type: "image" }],
                role: "assistant",
                text: "Hi Raymond",
                thinking: [{ text: "thinking" }],
                timestamp: "2026-05-11T00:01:00.000Z",
                toolResult: { content: "tool output" },
            },
        },
        {
            key: "typing-1",
            kind: "typing",
            message: {
                content: "",
                role: "assistant",
                text: "Working",
            },
        },
    ];
}

function makeProps(
    overrides: Partial<React.ComponentProps<typeof ChatMessagesList>> = {}
) {
    const rows = makeRows();
    return {
        chatRows: rows,
        isAtBottom: true,
        isLoadingHistory: false,
        messagesBottomReference: createRef<HTMLDivElement>(),
        messagesContainerReference: createRef<HTMLDivElement>(),
        messagesVirtualizer: makeVirtualizer(rows.length),
        onDeleteMessage: vi.fn(),
        onDynamicContentLoad: vi.fn(),
        onFollow: vi.fn(),
        onPreview: vi.fn(),
        onScroll: vi.fn(),
        onTtsError: vi.fn(),
        visibility: { showThinking: true, showTools: true },
        ...overrides,
    } satisfies React.ComponentProps<typeof ChatMessagesList>;
}

function renderMessages(
    overrides: Partial<React.ComponentProps<typeof ChatMessagesList>> = {}
) {
    const props = makeProps(overrides);
    return { props, ...render(<ChatMessagesList {...props} />) };
}

describe("ChatMessagesList", () => {
    beforeEach(() => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                blob: async () => new Blob(["audio"], { type: "audio/mpeg" }),
                ok: true,
            })
        );
        class MockAudio {
            addEventListener = vi.fn();
            pause = vi.fn();
            play = vi.fn().mockResolvedValue(null);
        }

        vi.stubGlobal("Audio", MockAudio);
        vi.stubGlobal("URL", {
            createObjectURL: vi.fn(() => "blob:audio"),
            revokeObjectURL: vi.fn(),
        });
    });

    it("renders loading, empty, and follow states", async () => {
        const user = userEvent.setup();
        const onFollow = vi.fn();
        const { rerender } = renderMessages({
            chatRows: [],
            isLoadingHistory: true,
            messagesVirtualizer: makeVirtualizer(0),
            onFollow,
        });

        expect(screen.getByText("Loading chat…")).toBeInTheDocument();

        rerender(
            <ChatMessagesList
                {...makeProps({
                    chatRows: [],
                    messagesVirtualizer: makeVirtualizer(0),
                })}
            />
        );
        expect(
            screen.getByText(
                "No chat history yet. Send the first message to this session."
            )
        ).toBeInTheDocument();

        const rows = makeRows();
        rerender(
            <ChatMessagesList
                {...makeProps({
                    chatRows: rows,
                    isAtBottom: false,
                    messagesVirtualizer: makeVirtualizer(rows.length),
                    onFollow,
                })}
            />
        );
        await user.click(screen.getByRole("button", { name: "↓ Follow" }));
        expect(onFollow).toHaveBeenCalledTimes(1);
    });

    it("renders messages, attachments, diagnostics, and typing indicator", async () => {
        const user = userEvent.setup();
        const onDeleteMessage = vi.fn();
        const onDynamicContentLoad = vi.fn();
        const onPreview = vi.fn();

        renderMessages({ onDeleteMessage, onDynamicContentLoad, onPreview });

        expect(screen.getByText("Hello Mira")).toBeInTheDocument();
        expect(screen.getByText("Hi Raymond")).toBeInTheDocument();
        expect(screen.getByText("thinkingtool output")).toBeInTheDocument();
        expect(screen.getByText("Working")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Delete your message" }));
        expect(onDeleteMessage).toHaveBeenCalledWith("user-1");

        fireImageLoad("Chat attachment");
        expect(onDynamicContentLoad).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: /result.txt/ }));
        expect(onPreview).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: "text",
                text: "read me",
                title: "result.txt",
            })
        );

        await user.click(screen.getByRole("button", { name: "Chat attachment" }));
        expect(onPreview).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "image", title: "Chat image" })
        );
    });

    it("uses the TTS endpoint for assistant messages and reports errors", async () => {
        const user = userEvent.setup();
        const onTtsError = vi.fn();

        renderMessages({ onTtsError });

        await user.click(
            screen.getByRole("button", { name: "Read assistant message aloud" })
        );
        expect(fetch).toHaveBeenCalledWith(
            "/api/tts/speak",
            expect.objectContaining({
                body: JSON.stringify({ text: "Hi Raymond" }),
                method: "POST",
            })
        );
        await waitFor(() => expect(onTtsError).toHaveBeenCalledWith(""));
        await user.click(screen.getByRole("button", { name: "Stop reading aloud" }));

        (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            json: async () => ({ error: "TTS failed" }),
            ok: false,
            status: 500,
        });
        await user.click(
            screen.getByRole("button", { name: "Read assistant message aloud" })
        );
        await waitFor(() => expect(onTtsError).toHaveBeenCalledWith("TTS failed"));
    });
});

function fireImageLoad(alt: string) {
    const image = screen.getByAltText(alt);
    image.dispatchEvent(new Event("load", { bubbles: true }));
}
