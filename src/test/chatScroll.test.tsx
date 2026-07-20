import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import type { ChatRow } from "../components/features/chat/chatTypes";
import { useChatScroll } from "../components/features/chat/useChatScroll";

const originalAnimationFrame = {
    cancelAnimationFrame,
    requestAnimationFrame,
};
const originalVisibilityState = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState"
);
const animationFrameState = {
    frames: new Map<number, FrameRequestCallback>(),
    nextFrameId: 0,
};
const cancelFrame = jest.fn((frameId: number) => {
    animationFrameState.frames.delete(frameId);
});

function runNextAnimationFrame(): void {
    const frame = animationFrameState.frames.entries().next().value;
    if (!frame) {
        throw new Error("Expected a queued animation frame");
    }
    const [frameId, callback] = frame;
    animationFrameState.frames.delete(frameId);
    act(() => callback(0));
}

function runAnimationFrames(count: number): void {
    for (let index = 0; index < count; index += 1) {
        runNextAnimationFrame();
    }
}

function chatRow(key: string, role: string): ChatRow {
    return {
        key,
        kind: "message",
        message: { content: key, role, text: key },
    };
}

function setDocumentVisibility(visibilityState: DocumentVisibilityState): void {
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: visibilityState,
    });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
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
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
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
    if (originalVisibilityState) {
        Object.defineProperty(document, "visibilityState", originalVisibilityState);
    } else {
        Reflect.deleteProperty(document, "visibilityState");
    }
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
        act(() => result.current.handleUserScrollIntent());

        expect(cancelFrame).toHaveBeenCalledWith(pendingFrameId);
        expect(animationFrameState.frames.has(pendingFrameId)).toBe(false);

        act(() => result.current.handleScroll());
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
        let scrollTop = 0;
        const scrollWrites: number[] = [];
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, get: () => scrollHeight },
            scrollTop: {
                configurable: true,
                get: () => scrollTop,
                set: (value: number) => {
                    scrollTop = value;
                    scrollWrites.push(value);
                },
            },
        });
        result.current.messagesContainerReference.current = container;
        runAnimationFrames(4);

        scrollHeight = 700;
        rerender({
            rows: [initialRows[0]!, chatRow("new-tool", "tool"), activity],
        });

        expect(animationFrameState.frames.size).toBe(1);
        scrollTop = 500;
        scrollWrites.length = 0;
        act(() => result.current.handleScroll());
        expect(stickToBottomReference.current).toBe(true);
        runNextAnimationFrame();
        expect(scrollWrites).toEqual([]);
        runNextAnimationFrame();
        expect(scrollWrites).toEqual([]);
        runNextAnimationFrame();
        expect(scrollWrites).toEqual([700]);
        expect(scrollTop).toBe(700);
        expect(animationFrameState.frames.size).toBe(0);

        container.scrollTop = 500;
        act(() => result.current.handleScroll());
        expect(stickToBottomReference.current).toBe(false);
        unmount();
    });

    it("primes and settles the bottom after a hard-refresh history load", () => {
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
        let scrollTop = 0;
        const scrollWrites: number[] = [];
        const container = document.createElement("div");
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, get: () => scrollHeight },
            scrollTop: {
                configurable: true,
                get: () => scrollTop,
                set: (value: number) => {
                    scrollTop = value;
                    scrollWrites.push(value);
                },
            },
        });
        result.current.messagesContainerReference.current = container;

        rerender({ rows: [row] });
        expect(animationFrameState.frames.size).toBe(1);
        scrollWrites.length = 0;

        scrollHeight = 700;
        runNextAnimationFrame();
        expect(scrollWrites).toEqual([700]);

        scrollHeight = 900;
        runNextAnimationFrame();
        scrollHeight = 1100;
        runNextAnimationFrame();
        runNextAnimationFrame();
        expect(scrollWrites).toEqual([700]);

        runNextAnimationFrame();
        expect(scrollTop).toBe(1100);
        expect(scrollWrites).toEqual([700, 1100]);
        expect(animationFrameState.frames.size).toBe(0);

        unmount();
    });

    it("settles existing rows when an asynchronous history load finishes", () => {
        const row = chatRow("answer", "assistant");
        const stickToBottomReference = { current: true };
        const { result, rerender, unmount } = renderHook(
            ({ isLoadingHistory }: { isLoadingHistory: boolean }) =>
                useChatScroll(
                    [row],
                    "agent:main:main",
                    jest.fn(),
                    stickToBottomReference,
                    isLoadingHistory
                ),
            { initialProps: { isLoadingHistory: true } }
        );
        let scrollHeight = 500;
        let scrollTop = 0;
        const scrollWrites: number[] = [];
        const container = document.createElement("div");
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, get: () => scrollHeight },
            scrollTop: {
                configurable: true,
                get: () => scrollTop,
                set: (value: number) => {
                    scrollTop = value;
                    scrollWrites.push(value);
                },
            },
        });
        result.current.messagesContainerReference.current = container;
        runAnimationFrames(4);

        scrollWrites.length = 0;
        scrollTop = 120;
        scrollHeight = 800;
        rerender({ isLoadingHistory: false });
        runNextAnimationFrame();
        expect(scrollWrites.at(-1)).toBe(800);

        scrollHeight = 950;
        runNextAnimationFrame();
        runAnimationFrames(2);
        expect(scrollWrites.at(-1)).toBe(950);
        expect(scrollTop).toBe(950);
        unmount();
    });

    it("restores a hidden tab only when it was sticky before deactivation", () => {
        const stickToBottomReference = { current: true };
        const { result, unmount } = renderHook(() =>
            useChatScroll(
                [chatRow("answer", "assistant")],
                "agent:main:main",
                jest.fn(),
                stickToBottomReference
            )
        );
        let scrollHeight = 600;
        let scrollTop = 0;
        const scrollWrites: number[] = [];
        const container = document.createElement("div");
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, get: () => scrollHeight },
            scrollTop: {
                configurable: true,
                get: () => scrollTop,
                set: (value: number) => {
                    scrollTop = value;
                    scrollWrites.push(value);
                },
            },
        });
        result.current.messagesContainerReference.current = container;
        runAnimationFrames(4);

        scrollWrites.length = 0;
        setDocumentVisibility("hidden");
        stickToBottomReference.current = false;
        scrollTop = 180;
        scrollHeight = 900;
        setDocumentVisibility("visible");
        expect(stickToBottomReference.current).toBe(true);
        runAnimationFrames(4);
        expect(scrollWrites).toEqual([900, 900]);

        scrollWrites.length = 0;
        stickToBottomReference.current = false;
        setDocumentVisibility("hidden");
        setDocumentVisibility("visible");
        expect(animationFrameState.frames.size).toBe(0);
        expect(scrollWrites).toEqual([]);
        unmount();
    });

    it("completes a bottom follow queued before the first row renders", () => {
        const row = chatRow("answer", "assistant");
        const stickToBottomReference = { current: true };
        const { result, rerender, unmount } = renderHook(
            ({ rows }: { rows: ChatRow[] }) =>
                useChatScroll(rows, "agent:main:main", jest.fn(), stickToBottomReference),
            { initialProps: { rows: [] as ChatRow[] } }
        );
        const container = document.createElement("div");
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, value: 700 },
        });
        result.current.messagesContainerReference.current = container;

        act(() => result.current.scheduleBottomFollow());
        rerender({ rows: [row] });
        expect(animationFrameState.frames.size).toBe(1);

        runNextAnimationFrame();
        expect(container.scrollTop).toBe(700);
        runAnimationFrames(3);
        expect(animationFrameState.frames.size).toBe(0);
        unmount();
    });

    it("settles an explicit follow after the virtualized tail grows", () => {
        const stickToBottomReference = { current: true };
        const { result, unmount } = renderHook(() =>
            useChatScroll(
                [chatRow("answer", "assistant")],
                "agent:main:main",
                jest.fn(),
                stickToBottomReference
            )
        );
        let scrollHeight = 500;
        let scrollTop = 0;
        const scrollWrites: number[] = [];
        const container = document.createElement("div");
        Object.defineProperties(container, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, get: () => scrollHeight },
            scrollTop: {
                configurable: true,
                get: () => scrollTop,
                set: (value: number) => {
                    scrollTop = value;
                    scrollWrites.push(value);
                },
            },
        });
        result.current.messagesContainerReference.current = container;
        runAnimationFrames(4);

        scrollTop = 150;
        scrollWrites.length = 0;
        stickToBottomReference.current = false;
        act(() => result.current.followToBottom());
        expect(stickToBottomReference.current).toBe(true);

        runNextAnimationFrame();
        expect(scrollWrites).toEqual([500]);
        scrollHeight = 760;
        runAnimationFrames(3);
        expect(scrollWrites).toEqual([500, 760]);
        expect(scrollTop).toBe(760);
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
