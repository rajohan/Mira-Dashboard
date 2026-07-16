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
});
