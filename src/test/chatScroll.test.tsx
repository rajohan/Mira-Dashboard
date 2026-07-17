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
        const scrollIntoView = jest.fn();
        const { result, unmount } = renderHook(() =>
            useChatScroll([row], "agent:main:main", jest.fn(), stickToBottomReference)
        );
        const container = document.createElement("div");
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, value: 400 },
        });
        const bottom = document.createElement("div");
        Object.defineProperty(bottom, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
        result.current.messagesContainerReference.current = container;
        result.current.messagesBottomReference.current = bottom;

        act(() => result.current.scheduleBottomFollow());
        const firstFrameId = animationFrameState.nextFrameId;
        stickToBottomReference.current = false;
        act(() => animationFrameState.frames.get(firstFrameId)?.(0));
        expect(scrollIntoView).not.toHaveBeenCalled();

        stickToBottomReference.current = true;
        act(() => result.current.scheduleBottomFollow());
        const pendingFrameId = animationFrameState.nextFrameId;
        unmount();
        expect(cancelFrame).toHaveBeenCalledWith(pendingFrameId);
        expect(animationFrameState.frames.has(pendingFrameId)).toBe(false);
    });

    it("schedules one bottom follow after a hard-refresh history load", () => {
        const row: ChatRow = {
            key: "answer",
            kind: "message",
            message: { content: "answer", role: "assistant", text: "answer" },
        };
        const stickToBottomReference = { current: true };
        const scrollIntoView = jest.fn();
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
        const bottom = document.createElement("div");
        Object.defineProperty(bottom, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
        result.current.messagesContainerReference.current = container;
        result.current.messagesBottomReference.current = bottom;

        rerender({ rows: [row] });
        expect(animationFrameState.frames.size).toBe(1);

        scrollHeight = 700;
        const firstFrameId = animationFrameState.nextFrameId;
        act(() => animationFrameState.frames.get(firstFrameId)?.(0));
        expect(container.scrollTop).toBe(700);
        expect(animationFrameState.frames.size).toBe(1);

        unmount();
    });
});
