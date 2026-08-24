import { describe, expect, test } from "bun:test";

import {
    chatAbortControlsAreEnabled,
    chatAbortIsGated,
    chatSendIsEnabled,
    chatTaskCancelIsGated,
    reconcileChatTaskSummary,
} from "./chatInteractionState.ts";

describe("chat browser interaction state", () => {
    test("blocks send until a settings mutation and fresh reconciliation settle", () => {
        const ready = {
            actionBusy: false,
            attachments: [],
            connection: "connected" as const,
            sessionKey: "agent:main:main",
            sourceFresh: true,
            text: "Send after settings",
        };
        expect(chatSendIsEnabled(ready)).toBe(true);
        expect(chatSendIsEnabled({ ...ready, actionBusy: true })).toBe(false);
        expect(chatSendIsEnabled({ ...ready, sourceFresh: false })).toBe(false);
        expect(chatSendIsEnabled({ ...ready, connection: "reconnecting" })).toBe(false);
    });
});

describe("chat mutation reconciliation gates", () => {
    test("keeps abort gating scoped to the exact run until owned reconciliation", () => {
        const gate = {
            reconciliation: "runtime-authoritative" as const,
            runLastSequence: 7,
            sessionKey: "agent:main:main",
        };
        const run = {
            lastSequence: 7,
            phase: "active" as const,
            reconciliation: "runtime-authoritative" as const,
        };
        const parallelRuns = {
            a: run,
            b: { ...run, lastSequence: 99 },
        };
        expect(chatAbortIsGated(gate, "agent:main:main", parallelRuns.a)).toBe(true);
        expect(
            chatAbortIsGated(gate, "agent:main:main", {
                ...run,
                lastSequence: 8,
            })
        ).toBe(true);
        expect(
            chatAbortIsGated(gate, "agent:main:main", {
                ...run,
                reconciliation: "history-authoritative",
            })
        ).toBe(true);
        expect(chatAbortIsGated(gate, "agent:main:main", undefined)).toBe(false);
        const ready = {
            actionBusy: false,
            connection: "connected" as const,
            sourceFresh: true,
        };
        expect(chatAbortControlsAreEnabled(ready)).toBe(true);
        expect(
            chatAbortControlsAreEnabled({ ...ready, connection: "disconnected" })
        ).toBe(false);
        expect(chatAbortControlsAreEnabled({ ...ready, sourceFresh: false })).toBe(false);
    });

    test("keeps a task gated until owned reconciliation preserves the race winner", () => {
        const gate = {
            phase: "reconciling" as const,
            sessionKey: "agent:main:main",
            taskUpdatedAtMs: 20,
        };
        const running = { id: "task-1", status: "running" as const, updatedAtMs: 20 };
        expect(chatTaskCancelIsGated(gate)).toBe(true);
        const completed = { ...running, status: "completed" as const };
        expect(
            reconcileChatTaskSummary(completed, {
                ...running,
                status: "cancelled",
                updatedAtMs: 19,
            }).status
        ).toBe("completed");
    });
});
