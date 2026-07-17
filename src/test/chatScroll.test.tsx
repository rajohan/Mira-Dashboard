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
    it("keeps the centered bubble anchored through a delayed insertion above it", () => {
        const initialRows = [
            chatRow("assistant-before", "assistant"),
            chatRow("thinking-being-read", "assistant"),
            chatRow("user-after", "user"),
        ];
        const stickToBottomReference = { current: false };
        const { result, rerender, unmount } = renderHook(
            ({ rows }: { rows: ChatRow[] }) =>
                useChatScroll(
                    rows,
                    "activity",
                    "agent:main:main",
                    jest.fn(),
                    stickToBottomReference
                ),
            { initialProps: { rows: initialRows } }
        );
        const container = document.createElement("div");
        const scrollTo = jest.fn((options: ScrollToOptions) => {
            container.scrollTop = Number(options.top || 0);
        });
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 300 },
            getBoundingClientRect: {
                configurable: true,
                value: () => ({ bottom: 300, top: 0 }) as DOMRect,
            },
            scrollHeight: { configurable: true, value: 1000 },
            scrollTo: { configurable: true, value: scrollTo },
        });
        const positions = new Map([
            ["assistant-before", 0],
            ["thinking-being-read", 160],
            ["user-after", 460],
        ]);
        const heights = new Map([
            ["assistant-before", 160],
            ["thinking-being-read", 300],
            ["user-after", 160],
            ["new-tool", 237],
        ]);
        const rowElements = new Map(
            initialRows.map((row) => {
                const element = document.createElement("div");
                element.dataset.chatRowKey = row.key;
                Object.defineProperty(element, "getBoundingClientRect", {
                    configurable: true,
                    value: () => {
                        const top = (positions.get(row.key) || 0) - container.scrollTop;
                        return {
                            bottom: top + (heights.get(row.key) || 160),
                            top,
                        } as DOMRect;
                    },
                });
                container.append(element);
                return [row.key, element] as const;
            })
        );
        result.current.messagesContainerReference.current = container;

        rerender({ rows: initialRows });
        result.current.virtualizer.getTotalSize();
        stickToBottomReference.current = false;
        container.scrollTop = 120;
        scrollTo.mockClear();
        act(() => result.current.handleScroll());
        animationFrameState.frames.clear();

        positions.set("new-tool", 160);
        const newToolElement = document.createElement("div");
        newToolElement.dataset.chatRowKey = "new-tool";
        Object.defineProperty(newToolElement, "getBoundingClientRect", {
            configurable: true,
            value: () => {
                const top = (positions.get("new-tool") || 0) - container.scrollTop;
                return {
                    bottom: top + (heights.get("new-tool") || 160),
                    top,
                } as DOMRect;
            },
        });
        container.insertBefore(newToolElement, rowElements.get("thinking-being-read")!);

        rerender({
            rows: [initialRows[0]!, chatRow("new-tool", "tool"), ...initialRows.slice(1)],
        });

        expect(container.scrollTop).toBe(120);
        positions.set("thinking-being-read", 397);
        positions.set("user-after", 697);
        const anchorFrameId = animationFrameState.nextFrameId;
        const anchorFrame = animationFrameState.frames.get(anchorFrameId);
        expect(anchorFrame).toBeDefined();
        animationFrameState.frames.delete(anchorFrameId);
        act(() => anchorFrame?.(0));

        expect(container.scrollTop).toBe(357);
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 357 }));

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
            useChatScroll(
                [row],
                "activity",
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

    it("follows late virtual measurements after a hard-refresh history load", () => {
        const row: ChatRow = {
            key: "answer",
            kind: "message",
            message: { content: "answer", role: "assistant", text: "answer" },
        };
        const stickToBottomReference = { current: true };
        const scrollIntoView = jest.fn();
        const { result, rerender, unmount } = renderHook(
            ({ rows }: { rows: ChatRow[] }) =>
                useChatScroll(
                    rows,
                    "activity",
                    "agent:main:main",
                    jest.fn(),
                    stickToBottomReference
                ),
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
        expect(container.scrollTop).toBe(400);

        scrollHeight = 700;
        const firstFrameId = animationFrameState.nextFrameId;
        act(() => animationFrameState.frames.get(firstFrameId)?.(0));
        expect(container.scrollTop).toBe(700);

        scrollHeight = 900;
        const secondFrameId = animationFrameState.nextFrameId;
        act(() => animationFrameState.frames.get(secondFrameId)?.(0));
        expect(container.scrollTop).toBe(900);

        unmount();
    });
});
