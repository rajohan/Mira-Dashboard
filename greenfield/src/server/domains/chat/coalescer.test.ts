/* oxlint-disable typescript/require-await -- Async test doubles mirror production promise ports. */
import { describe, expect, test } from "bun:test";

import { chatDeltaCoalescingMilliseconds } from "../../../contracts/chatModel.ts";
import { ChatRuntimeEventCoalescer, type ChatCoalescerScheduler } from "./coalescer.ts";
import type { ChatRuntimeEventDraft } from "./repository.ts";

describe("chat runtime event coalescer", () => {
    test("batches contiguous stream deltas on the audited 150 ms window", async () => {
        let scheduled: (() => void) | undefined;
        let delay: number | undefined;
        const scheduler: ChatCoalescerScheduler = {
            clear() {
                scheduled = undefined;
            },
            schedule(callback, delayMs) {
                scheduled = callback;
                delay = delayMs;
                return callback;
            },
        };
        const batches: Array<readonly ChatRuntimeEventDraft[]> = [];
        const coalescer = new ChatRuntimeEventCoalescer(async (events) => {
            batches.push(events);
        }, scheduler);

        await coalescer.push({
            kind: "assistant",
            mode: "append",
            occurredAtMs: 1000,
            providerSequenceEnd: 1,
            providerSequenceStart: 1,
            text: "hel",
        });
        await coalescer.push({
            kind: "assistant",
            mode: "append",
            occurredAtMs: 1001,
            providerSequenceEnd: 2,
            providerSequenceStart: 2,
            text: "lo",
        });

        expect(delay).toBe(chatDeltaCoalescingMilliseconds);
        expect(batches).toEqual([]);
        scheduled?.();
        await coalescer.flush();
        expect(batches).toEqual([
            [
                {
                    kind: "assistant",
                    mode: "append",
                    occurredAtMs: 1001,
                    providerSequenceEnd: 2,
                    providerSequenceStart: 1,
                    text: "hello",
                },
            ],
        ]);
    });

    test("flushes pending text and a tool boundary in one serialized commit", async () => {
        const batches: Array<readonly ChatRuntimeEventDraft[]> = [];
        const coalescer = new ChatRuntimeEventCoalescer(
            async (events) => {
                batches.push(events);
            },
            {
                clear() {},
                schedule() {
                    return 1;
                },
            }
        );
        await coalescer.push({
            kind: "thinking",
            mode: "append",
            occurredAtMs: 1000,
            text: "reason",
        });
        await coalescer.push({
            callId: "call-1",
            isError: false,
            kind: "tool",
            name: "search",
            occurredAtMs: 1001,
            phase: "started",
        });

        expect(batches).toEqual([
            [
                {
                    kind: "thinking",
                    mode: "append",
                    occurredAtMs: 1000,
                    text: "reason",
                },
                {
                    callId: "call-1",
                    isError: false,
                    kind: "tool",
                    name: "search",
                    occurredAtMs: 1001,
                    phase: "started",
                },
            ],
        ]);
    });

    test("serializes concurrent incompatible pushes without reversing event order", async () => {
        const batches: Array<readonly ChatRuntimeEventDraft[]> = [];
        const coalescer = new ChatRuntimeEventCoalescer(
            async (events) => {
                batches.push(events);
            },
            {
                clear() {},
                schedule() {
                    return 1;
                },
            }
        );

        const first = coalescer.push({
            kind: "assistant",
            mode: "append",
            occurredAtMs: 1000,
            text: "first",
        });
        const second = coalescer.push({
            kind: "thinking",
            mode: "append",
            occurredAtMs: 1001,
            text: "second",
        });
        const boundary = coalescer.push({
            itemId: "item-1",
            itemType: "notice",
            kind: "item",
            occurredAtMs: 1002,
            text: "third",
        });
        await Promise.all([first, second, boundary]);

        expect(batches.flat().map(({ kind }) => kind)).toEqual([
            "assistant",
            "thinking",
            "item",
        ]);
    });

    test("rejects half-present provider ranges before they enter a batch", async () => {
        const coalescer = new ChatRuntimeEventCoalescer(async () => {}, {
            clear() {},
            schedule() {
                return 1;
            },
        });
        let observedError: unknown;
        try {
            await coalescer.push({
                kind: "assistant",
                mode: "append",
                occurredAtMs: 1000,
                providerSequenceStart: 1,
                text: "invalid",
            });
        } catch (error) {
            observedError = error;
        }
        expect(observedError).toBeInstanceOf(TypeError);
    });

    test("latches and reports timer-triggered sink rejection without an unhandled retry loop", async () => {
        let scheduled: (() => void) | undefined;
        const failure = new Error("database unavailable");
        const observed: unknown[] = [];
        const coalescer = new ChatRuntimeEventCoalescer(
            async () => {
                throw failure;
            },
            {
                clear() {
                    scheduled = undefined;
                },
                schedule(callback) {
                    scheduled = callback;
                    return callback;
                },
            },
            (error) => observed.push(error)
        );
        await coalescer.push({
            kind: "assistant",
            mode: "append",
            occurredAtMs: 1000,
            text: "pending",
        });
        scheduled?.();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        await new Promise<void>((resolve) => queueMicrotask(resolve));

        let laterFailure: unknown;
        try {
            await coalescer.push({
                kind: "assistant",
                mode: "append",
                occurredAtMs: 1001,
                text: "later",
            });
        } catch (error) {
            laterFailure = error;
        }
        expect(observed).toEqual([failure]);
        expect(laterFailure).toBe(failure);
    });
});
