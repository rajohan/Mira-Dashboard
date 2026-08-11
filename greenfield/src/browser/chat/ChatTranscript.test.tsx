import { describe, expect, jest, spyOn, test } from "bun:test";

import { visibleChatTranscriptMessages } from "./chatMessageVisibility.ts";
import { ChatTranscript } from "./ChatTranscript.tsx";
import {
    activeCompactionMaximumAgeMs,
    completedCompactionMaximumAgeMs,
    projectChatTranscriptMessages,
} from "./chatTranscriptProjection.ts";
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
    test("projects one default activity row before the first assistant part", () => {
        const projected = projectChatTranscriptMessages(
            [],
            ["provider-empty"],
            sessionKey,
            Date.now()
        );

        expect(projected).toEqual([
            expect.objectContaining({
                id: "activity:provider-empty:thinking",
                parts: [
                    {
                        activity: "running",
                        kind: "control",
                        text: "Thinking…",
                        tone: "muted",
                    },
                ],
            }),
        ]);
    });

    test("keeps activity after a same-run steer and derives only bounded tool input", () => {
        const tool: ChatDisplayMessage = {
            attachments: [],
            id: "external:run:segment:tool",
            parts: [
                {
                    callId: "call-1",
                    input: {
                        cmd: `bun test ${"safe ".repeat(40)}`,
                        ignoredSecret: "must-not-render",
                    },
                    kind: "tool",
                    name: "functions.exec_command",
                    output: "must-not-render-in-activity",
                    status: "completed",
                },
            ],
            providerRunId: "provider-steer",
            role: "assistant",
            sequence: 1,
            sessionKey,
        };
        const steer: ChatDisplayMessage = {
            attachments: [],
            id: "steer-user",
            parts: [{ kind: "text", text: "Continue" }],
            providerRunId: "provider-steer",
            role: "user",
            sequence: 2,
            sessionKey,
        };
        const projected = projectChatTranscriptMessages(
            [tool, steer],
            ["provider-steer"],
            sessionKey,
            Date.now()
        );

        expect(projected.map(({ id }) => id)).toEqual([
            tool.id,
            steer.id,
            "activity:provider-steer:thinking",
        ]);
        expect(projected.at(-1)?.parts).toEqual([
            expect.objectContaining({ kind: "control", text: "Thinking…" }),
        ]);
        expect(JSON.stringify(projected.at(-1))).not.toContain("must-not-render");
    });

    test("shows the latest bounded tool summary as a separate activity row", () => {
        const runningTool: ChatDisplayMessage = {
            attachments: [],
            id: "external:run:segment:tool",
            parts: [
                {
                    callId: "call-2",
                    input: '{"cmd":"bun test src/browser/chat","cwd":"/workspace"}',
                    kind: "tool",
                    name: "functions.exec_command",
                    status: "running",
                },
            ],
            providerRunId: "provider-tool",
            role: "assistant",
            sequence: 1,
            sessionKey,
        };
        const projected = projectChatTranscriptMessages(
            [runningTool],
            ["provider-tool"],
            sessionKey,
            Date.now()
        );

        expect(projected.map(({ id }) => id)).toEqual([
            runningTool.id,
            "activity:provider-tool:tool:call-2",
        ]);
        expect(projected.at(-1)?.parts).toEqual([
            expect.objectContaining({
                kind: "control",
                text: "Bash: bun test src/browser/chat (workspace)",
            }),
        ]);
    });

    test("bounds active and completed compaction feedback like legacy", () => {
        const nowMs = Date.now();
        const compaction = (
            id: string,
            activity: "complete" | "running",
            timestampMs: number
        ): ChatDisplayMessage => ({
            attachments: [],
            id,
            parts: [
                {
                    activity,
                    kind: "control",
                    text:
                        activity === "running"
                            ? "Compacting context"
                            : "Context compacted",
                    tone: "muted",
                },
            ],
            providerRunId: id,
            role: "assistant",
            sequence: 1,
            sessionKey,
            timestampMs,
        });
        const projected = projectChatTranscriptMessages(
            [
                compaction("fresh-complete", "complete", nowMs - 1000),
                compaction("stale-complete", "complete", nowMs - 6000),
                compaction("stale-active", "running", nowMs - 300_001),
            ],
            [],
            sessionKey,
            nowMs
        );

        expect(projected.map(({ id }) => id)).toEqual(["fresh-complete"]);
        expect(projected[0]?.parts).toEqual([
            expect.objectContaining({
                activity: "complete",
                kind: "control",
                text: "Context compacted",
            }),
        ]);
    });

    test("starts a fresh compaction TTL after idle and refreshes it on retry", () => {
        jest.useFakeTimers();
        let currentTimeMs = 1000;
        const nowSpy = spyOn(Date, "now").mockImplementation(() => currentTimeMs);
        const compaction = (timestampMs: number): ChatDisplayMessage => ({
            attachments: [],
            id: "compaction-retry",
            parts: [
                {
                    activity: "running",
                    kind: "control",
                    text: "Compacting context",
                    tone: "muted",
                },
            ],
            providerRunId: "provider-compaction",
            role: "assistant",
            sequence: 1,
            sessionKey,
            timestampMs,
        });
        const rendered = render(<ChatTranscript {...properties([])} />);

        try {
            currentTimeMs = 1_000_000;
            act(() => {
                rendered.rerender(
                    <ChatTranscript {...properties([compaction(currentTimeMs)])} />
                );
            });
            expect(screen.queryByText("No messages yet")).toBeNull();

            const dateReadsBeforeUnrelatedMessage = nowSpy.mock.calls.length;
            act(() => {
                rendered.rerender(
                    <ChatTranscript
                        {...properties([
                            compaction(currentTimeMs),
                            message("unrelated-message", 2),
                        ])}
                    />
                );
            });
            expect(nowSpy).toHaveBeenCalledTimes(dateReadsBeforeUnrelatedMessage);

            currentTimeMs += activeCompactionMaximumAgeMs - 1000;
            act(() => {
                jest.advanceTimersByTime(activeCompactionMaximumAgeMs - 1000);
            });
            expect(screen.queryByText("No messages yet")).toBeNull();

            act(() => {
                rendered.rerender(
                    <ChatTranscript {...properties([compaction(currentTimeMs)])} />
                );
            });
            currentTimeMs += 2000;
            act(() => {
                jest.advanceTimersByTime(2000);
            });
            expect(screen.queryByText("No messages yet")).toBeNull();

            currentTimeMs += activeCompactionMaximumAgeMs - 2000;
            act(() => {
                jest.advanceTimersByTime(activeCompactionMaximumAgeMs - 2000);
            });
            expect(screen.getByText("No messages yet")).toBeVisible();
        } finally {
            act(() => rendered.unmount());
            nowSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test("filters an expired compaction synchronously when it arrives after idle", () => {
        jest.useFakeTimers();
        let currentTimeMs = 1000;
        const nowSpy = spyOn(Date, "now").mockImplementation(() => currentTimeMs);
        const rendered = render(<ChatTranscript {...properties([])} />);
        const expiredCompaction: ChatDisplayMessage = {
            attachments: [],
            id: "expired-after-idle",
            parts: [
                {
                    activity: "complete",
                    kind: "control",
                    text: "Context compacted",
                    tone: "muted",
                },
            ],
            providerRunId: "expired-provider-run",
            role: "assistant",
            sequence: 1,
            sessionKey,
            timestampMs: 1_000_000 - completedCompactionMaximumAgeMs - 1,
        };

        try {
            const readsBeforeArrival = nowSpy.mock.calls.length;
            currentTimeMs = 1_000_000;
            act(() => {
                rendered.rerender(
                    <ChatTranscript {...properties([expiredCompaction])} />
                );
            });
            expect(nowSpy).toHaveBeenCalledTimes(readsBeforeArrival + 1);
            expect(screen.queryByText("Context compacted")).toBeNull();
            expect(screen.getByText("No messages yet")).toBeVisible();

            const readsBeforePendingTimers = nowSpy.mock.calls.length;
            act(() => {
                jest.advanceTimersByTime(0);
            });
            expect(nowSpy).toHaveBeenCalledTimes(readsBeforePendingTimers);

            act(() => {
                rendered.rerender(
                    <ChatTranscript
                        {...properties([
                            expiredCompaction,
                            message("unrelated-after-expiry", 2),
                        ])}
                    />
                );
            });
            expect(nowSpy).toHaveBeenCalledTimes(readsBeforePendingTimers);
        } finally {
            act(() => rendered.unmount());
            nowSpy.mockRestore();
            jest.useRealTimers();
        }
    });

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
