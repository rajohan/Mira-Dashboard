import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, jest } from "bun:test";

import type { ChatCompactionStatus } from "../components/features/chat/domain/chatProjection";
import {
    projectChatActivityRows,
    useChatCompactionIndicator,
} from "../components/features/chat/useChatCompactionIndicator";

afterEach(() => {
    jest.useRealTimers();
});

describe("chat compaction indicator", () => {
    it("replaces normal activity with compaction and supplies a refresh fallback", () => {
        const normalActivity = {
            key: "typing-run",
            kind: "typing" as const,
            message: { content: "Bash", role: "assistant", text: "Bash" },
        };
        const compaction: ChatCompactionStatus = {
            key: "compact-1",
            phase: "active",
            text: "Compacting context",
            timestamp: "2026-07-17T18:00:00.000Z",
        };

        expect(
            projectChatActivityRows({
                activeRuns: [],
                compactionStatus: compaction,
                isActiveSession: true,
                rows: [normalActivity],
                sessionKey: "agent:main:main",
            })
        ).toEqual([
            expect.objectContaining({
                key: "compaction-compact-1",
                kind: "typing",
                message: expect.objectContaining({ text: "Compacting context" }),
            }),
        ]);
        expect(
            projectChatActivityRows({
                activeRuns: [],
                compactionStatus: undefined,
                isActiveSession: true,
                rows: [],
                sessionKey: "agent:main:main",
            })
        ).toEqual([
            expect.objectContaining({
                key: "typing-session-agent:main:main",
                kind: "typing",
                message: expect.objectContaining({ text: "Thinking" }),
            }),
        ]);
        const streamingRows = [
            {
                key: "streaming-answer",
                kind: "stream" as const,
                message: {
                    content: "Streaming answer",
                    role: "assistant",
                    runId: "active-run",
                    text: "Streaming answer",
                },
            },
        ];
        expect(
            projectChatActivityRows({
                activeRuns: [{ runId: "active-run" }],
                compactionStatus: undefined,
                isActiveSession: true,
                rows: streamingRows,
                sessionKey: "agent:main:main",
            })
        ).toBe(streamingRows);
        expect(
            projectChatActivityRows({
                activeRuns: [],
                compactionStatus: undefined,
                isActiveSession: true,
                rows: streamingRows,
                sessionKey: "agent:main:main",
            })
        ).toEqual([
            ...streamingRows,
            expect.objectContaining({
                key: "typing-session-agent:main:main",
                kind: "typing",
            }),
        ]);
    });

    it("preserves normal activity while completed compaction feedback is visible", () => {
        const normalActivity = {
            key: "typing-run",
            kind: "typing" as const,
            message: { content: "Thinking", role: "assistant", text: "Thinking" },
        };

        expect(
            projectChatActivityRows({
                activeRuns: [],
                compactionStatus: {
                    key: "compact-1",
                    phase: "complete",
                    text: "Context compacted",
                    timestamp: "2026-07-17T18:00:00.000Z",
                },
                isActiveSession: true,
                rows: [normalActivity],
                sessionKey: "agent:main:main",
            })
        ).toEqual([
            normalActivity,
            expect.objectContaining({
                key: "compaction-compact-1",
                kind: "status",
                message: expect.objectContaining({ text: "Context compacted" }),
            }),
        ]);
    });

    it("expires active feedback five minutes after the provider event", () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2026-07-17T18:00:00.000Z"));
        const status: ChatCompactionStatus = {
            key: "compact-1",
            phase: "active",
            text: "Compacting context",
            timestamp: "2026-07-17T18:00:00.000Z",
        };

        const { result } = renderHook(() => useChatCompactionIndicator(status));
        expect(result.current).toEqual(status);

        act(() => jest.advanceTimersByTime(5 * 60_000));
        expect(result.current).toBeUndefined();
    });

    it("does not replay stale completed feedback after refresh", () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2026-07-17T18:00:06.000Z"));

        const { result } = renderHook(() =>
            useChatCompactionIndicator({
                key: "compact-2",
                phase: "complete",
                text: "Context compacted",
                timestamp: "2026-07-17T18:00:00.000Z",
            })
        );

        expect(result.current).toBeUndefined();
    });
});
