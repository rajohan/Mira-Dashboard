import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import type { ChatRow } from "../components/features/chat/chatTypes";
import { useChatScroll } from "../components/features/chat/useChatScroll";

const originalAnimationFrame = {
    cancelAnimationFrame,
    requestAnimationFrame,
};
const animationFrameState = {
    frames: new Map<number, FrameRequestCallback>(),
    nextFrameId: 0,
};
const cancelFrame = jest.fn((frameId: number) => {
    animationFrameState.frames.delete(frameId);
});

function chatRow(key: string, role: string): ChatRow {
    return {
        key,
        kind: "message",
        message: { content: key, role, text: key },
    };
}

beforeEach(() => {
    animationFrameState.nextFrameId = 0;
    animationFrameState.frames.clear();
    cancelFrame.mockClear();
    Object.defineProperties(globalThis, {
        cancelAnimationFrame: {
            configurable: true,
            value: cancelFrame,
            writable: true,
        },
        requestAnimationFrame: {
            configurable: true,
            value: (callback: FrameRequestCallback) => {
                const frameId = ++animationFrameState.nextFrameId;
                animationFrameState.frames.set(frameId, callback);
                return frameId;
            },
            writable: true,
        },
    });
});

afterEach(() => {
    Object.defineProperties(globalThis, {
        cancelAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.cancelAnimationFrame,
            writable: true,
        },
        requestAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.requestAnimationFrame,
            writable: true,
        },
    });
});

describe("chat scroll", () => {
    it("delegates off-bottom row anchoring to the virtualizer", () => {
        const initialRows = [
            chatRow("assistant-before", "assistant"),
            chatRow("thinking-being-read", "assistant"),
            chatRow("user-after", "user"),
        ];
        const stickToBottomReference = { current: false };
        const { result, rerender, unmount } = renderHook(
            ({ rows }: { rows: ChatRow[] }) =>
                useChatScroll(rows, "agent:main:main", jest.fn(), stickToBottomReference),
            { initialProps: { rows: initialRows } }
        );
        const container = document.createElement("div");
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 300 },
            scrollHeight: { configurable: true, value: 1000 },
        });
        result.current.messagesContainerReference.current = container;

        rerender({ rows: initialRows });
        stickToBottomReference.current = false;
        container.scrollTop = 120;
        act(() => result.current.handleScroll());
        animationFrameState.frames.clear();

        rerender({
            rows: [initialRows[0]!, chatRow("new-tool", "tool"), ...initialRows.slice(1)],
        });

        expect(result.current.virtualizer.options.anchorTo).toBe("end");
        expect(result.current.virtualizer.options.followOnAppend).toBe("auto");
        expect(container.scrollTop).toBe(120);
        expect(animationFrameState.frames.size).toBe(0);

        unmount();
    });

    it("does not force a queued bottom follow after the user scrolls away", () => {
        const row: ChatRow = {
            key: "answer",
            kind: "message",
            message: { content: "answer", role: "assistant", text: "answer" },
        };
        const stickToBottomReference = { current: true };
        const { result, unmount } = renderHook(() =>
            useChatScroll([row], "agent:main:main", jest.fn(), stickToBottomReference)
        );
        const container = document.createElement("div");
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, value: 400 },
        });
        result.current.messagesContainerReference.current = container;

        act(() => result.current.scheduleBottomFollow());
        const firstFrameId = animationFrameState.nextFrameId;
        stickToBottomReference.current = false;
        act(() => animationFrameState.frames.get(firstFrameId)?.(0));
        expect(container.scrollTop).toBe(0);

        stickToBottomReference.current = true;
        act(() => result.current.scheduleBottomFollow());
        const pendingFrameId = animationFrameState.nextFrameId;
        unmount();
        expect(cancelFrame).toHaveBeenCalledWith(pendingFrameId);
        expect(animationFrameState.frames.has(pendingFrameId)).toBe(false);
    });

    it("cancels a queued bottom follow as soon as the user scrolls up", () => {
        const stickToBottomReference = { current: true };
        const { result, unmount } = renderHook(() =>
            useChatScroll(
                [chatRow("answer", "assistant")],
                "agent:main:main",
                jest.fn(),
                stickToBottomReference
            )
        );
        const container = document.createElement("div");
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, value: 400 },
        });
        result.current.messagesContainerReference.current = container;

        container.scrollTop = 300;
        act(() => result.current.handleScroll());
        act(() => result.current.scheduleBottomFollow());
        const pendingFrameId = animationFrameState.nextFrameId;

        container.scrollTop = 200;
        act(() => {
            result.current.handleUserScrollIntent();
            result.current.handleScroll();
        });

        expect(cancelFrame).toHaveBeenCalledWith(pendingFrameId);
        expect(animationFrameState.frames.has(pendingFrameId)).toBe(false);
        expect(stickToBottomReference.current).toBe(false);
        unmount();
    });

    it("keeps sticky bottom when a tool is inserted before a stable activity row", () => {
        const activity: ChatRow = {
            key: "activity",
            kind: "typing",
            message: { content: "Thinking", role: "assistant", text: "Thinking" },
        };
        const initialRows = [chatRow("user", "user"), activity];
        const stickToBottomReference = { current: true };
        const { result, rerender, unmount } = renderHook(
            ({ rows }: { rows: ChatRow[] }) =>
                useChatScroll(rows, "agent:main:main", jest.fn(), stickToBottomReference),
            { initialProps: { rows: initialRows } }
        );
        const container = document.createElement("div");
        let scrollHeight = 500;
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, get: () => scrollHeight },
        });
        result.current.messagesContainerReference.current = container;
        const initialFrameId = animationFrameState.nextFrameId;
        const initialFrame = animationFrameState.frames.get(initialFrameId);
        animationFrameState.frames.delete(initialFrameId);
        act(() => initialFrame?.(0));

        scrollHeight = 700;
        rerender({
            rows: [initialRows[0]!, chatRow("new-tool", "tool"), activity],
        });

        expect(animationFrameState.frames.size).toBe(1);
        act(() => result.current.handleScroll());
        expect(stickToBottomReference.current).toBe(true);
        const followFrame = animationFrameState.frames.get(
            animationFrameState.nextFrameId
        );
        act(() => followFrame?.(0));
        expect(container.scrollTop).toBe(700);

        container.scrollTop = 500;
        act(() => result.current.handleScroll());
        expect(stickToBottomReference.current).toBe(false);
        unmount();
    });

    it("schedules one bottom follow after a hard-refresh history load", () => {
        const row: ChatRow = {
            key: "answer",
            kind: "message",
            message: { content: "answer", role: "assistant", text: "answer" },
        };
        const stickToBottomReference = { current: true };
        const { result, rerender, unmount } = renderHook(
            ({ rows }: { rows: ChatRow[] }) =>
                useChatScroll(rows, "agent:main:main", jest.fn(), stickToBottomReference),
            { initialProps: { rows: [] as ChatRow[] } }
        );
        let scrollHeight = 400;
        const container = document.createElement("div");
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, get: () => scrollHeight },
        });
        result.current.messagesContainerReference.current = container;

        rerender({ rows: [row] });
        expect(animationFrameState.frames.size).toBe(1);

        scrollHeight = 700;
        const firstFrameId = animationFrameState.nextFrameId;
        const firstFrame = animationFrameState.frames.get(firstFrameId);
        animationFrameState.frames.delete(firstFrameId);
        act(() => firstFrame?.(0));
        expect(container.scrollTop).toBe(700);
        expect(animationFrameState.frames.size).toBe(0);

        unmount();
    });

    it("delegates same-row growth to the virtualizer without a second scroll", () => {
        const stickToBottomReference = { current: true };
        const { result, rerender, unmount } = renderHook(
            ({ text }: { text: string }) =>
                useChatScroll(
                    [
                        {
                            key: "thinking",
                            kind: "message",
                            message: { content: text, role: "assistant", text },
                        },
                    ],
                    "agent:main:main",
                    jest.fn(),
                    stickToBottomReference
                ),
            { initialProps: { text: "short" } }
        );
        const container = document.createElement("div");
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, value: 400 },
        });
        result.current.messagesContainerReference.current = container;
        animationFrameState.frames.clear();

        rerender({ text: "thinking grew without adding a row" });
        expect(animationFrameState.frames.size).toBe(0);
        expect(result.current.virtualizer.options.anchorTo).toBe("end");
        expect(
            result.current.virtualizer.options.useAnimationFrameWithResizeObserver
        ).toBe(true);
        unmount();
    });
});
