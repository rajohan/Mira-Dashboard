import { describe, expect, jest, test } from "bun:test";

import { visibleChatTranscriptMessages } from "./chatMessageVisibility.ts";
import { ChatTranscript } from "./ChatTranscript.tsx";
import type { ChatDisplayMessage } from "./chatTypes.ts";

const { act, fireEvent, render, screen } = await import("@testing-library/react");

const sessionKey = "agent:main:main";
const display = {
    keepThinkingAfterFinal: false,
    showThinking: true,
    showTools: true,
    toolsExpanded: false,
};

function message(id: string, sequence: number): ChatDisplayMessage {
    return {
        attachments: [],
        id,
        parts: [{ kind: "text", text: `Message ${sequence}` }],
        role: "assistant",
        sequence,
        sessionKey,
    };
}

function properties(messages: readonly ChatDisplayMessage[]) {
    return {
        display,
        hasOlder: false,
        historyLoading: false,
        initialLoading: false,
        messages,
        onHideMessage: jest.fn(),
        onHydrateMessage: jest.fn(),
        onLoadOlder: jest.fn(),
        sessionKey,
    };
}

async function flushAnimationFrames(): Promise<void> {
    await act(async () => {
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
        });
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
        });
    });
}

describe("chat transcript", () => {
    test("removes hidden tool-only messages from the virtualized row set", () => {
        const toolOnly: ChatDisplayMessage = {
            attachments: [],
            id: "tool-only",
            parts: [
                {
                    callId: "call-1",
                    input: { query: "runtime" },
                    kind: "tool",
                    name: "search",
                    status: "running",
                },
            ],
            role: "assistant",
            sequence: 2,
            sessionKey,
        };
        const messages = [message("message-1", 1), toolOnly];
        expect(
            visibleChatTranscriptMessages(messages, {
                ...display,
                showTools: false,
            }).map(({ id }) => id)
        ).toEqual(["message-1"]);
        expect(visibleChatTranscriptMessages(messages, display)).toHaveLength(2);
    });

    test("keeps older-history paging available when filters hide the loaded page", () => {
        const toolOnly: ChatDisplayMessage = {
            attachments: [],
            id: "tool-only-page",
            parts: [
                {
                    callId: "call-1",
                    kind: "tool",
                    name: "search",
                    status: "completed",
                },
            ],
            role: "assistant",
            sequence: 1,
            sessionKey,
        };
        const onLoadOlder = jest.fn();
        const rendered = render(
            <ChatTranscript
                {...properties([toolOnly])}
                display={{ ...display, showTools: false }}
                hasOlder
                onLoadOlder={onLoadOlder}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
        expect(onLoadOlder).toHaveBeenCalledTimes(1);
        expect(screen.queryByText("No messages yet")).toBeNull();
        act(() => rendered.unmount());
    });

    test("announces an atomic polite count while the reader is off the bottom", async () => {
        const first = message("message-1", 1);
        const rendered = render(<ChatTranscript {...properties([first])} />);
        const log = screen.getByRole("log", { name: "Messages" });
        Object.defineProperties(log, {
            clientHeight: { configurable: true, value: 200 },
            scrollHeight: { configurable: true, value: 1000 },
        });
        await flushAnimationFrames();
        act(() => {
            fireEvent.wheel(log, { deltaY: -100 });
            log.scrollTop = 500;
            fireEvent.scroll(log);
            log.scrollTop = 100;
            fireEvent.scroll(log);
        });
        expect(screen.getByRole("button", { name: "Back to latest" })).toBeVisible();

        act(() => {
            rendered.rerender(
                <ChatTranscript {...properties([first, message("message-2", 2)])} />
            );
        });
        await flushAnimationFrames();

        const count = rendered.container.querySelector("output");
        expect(count).toHaveAttribute("aria-atomic", "true");
        expect(count).toHaveAttribute("aria-live", "polite");
        expect(count).toHaveTextContent("1 new message");
        expect(log).toHaveAttribute("aria-live", "off");
        const followButton = screen.getByRole("button", { name: "1 new message" });
        expect(followButton).not.toHaveAttribute("aria-live");
        expect(followButton).toBeVisible();
        expect(rendered.container.querySelectorAll('[aria-live="polite"]')).toHaveLength(
            1
        );
        fireEvent.click(followButton);
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1000);
        expect(screen.queryByRole("button", { name: "Back to latest" })).toBeNull();
        expect(count).toHaveTextContent("");
        act(() => rendered.unmount());
    });

    test("follows same-id streaming growth only while the reader remains sticky", async () => {
        const first = message("streaming", 1);
        const rendered = render(<ChatTranscript {...properties([first])} />);
        const log = screen.getByRole("log", { name: "Messages" });
        let scrollHeight = 1000;
        Object.defineProperties(log, {
            clientHeight: { configurable: true, value: 200 },
            scrollHeight: {
                configurable: true,
                get: () => scrollHeight,
            },
        });
        await flushAnimationFrames();

        scrollHeight = 1200;
        rendered.rerender(
            <ChatTranscript
                {...properties([
                    {
                        ...first,
                        parts: [{ kind: "text", text: "A much longer streamed reply" }],
                    },
                ])}
            />
        );
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1200);

        fireEvent.wheel(log, { deltaY: -100 });
        log.scrollTop = 400;
        fireEvent.scroll(log);
        scrollHeight = 1400;
        rendered.rerender(
            <ChatTranscript
                {...properties([
                    {
                        ...first,
                        parts: [
                            {
                                kind: "text",
                                text: "An even longer streamed reply while scrolled away",
                            },
                        ],
                    },
                ])}
            />
        );
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(400);
        act(() => rendered.unmount());
    });
});
