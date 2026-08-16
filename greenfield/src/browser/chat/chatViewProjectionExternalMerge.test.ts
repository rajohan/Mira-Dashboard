import { describe, expect, test } from "bun:test";

import type { ChatDisplayMessage, ChatMessagePart, ChatToolPart } from "./chatTypes.ts";
import { mergeChatMessages } from "./chatViewProjection.ts";

const sessionKey = "agent:main:main";

function message(
    id: string,
    role: ChatDisplayMessage["role"],
    sequence: number,
    parts: readonly ChatMessagePart[],
    overrides: Partial<ChatDisplayMessage> = {}
): ChatDisplayMessage {
    return {
        attachments: [],
        id,
        parts,
        role,
        sequence,
        sessionKey,
        ...overrides,
    };
}

function external(
    id: string,
    providerRunId: string,
    sequence: number,
    parts: readonly ChatMessagePart[],
    overrides: Partial<ChatDisplayMessage> = {}
): ChatDisplayMessage {
    return message(`external:${providerRunId}:${id}`, "assistant", sequence, parts, {
        providerRunId,
        ...overrides,
    });
}

describe("external chat activity merge", () => {
    test("retires an exact runtime final through the canonical user admission anchor", () => {
        const providerRunId = "0123456789abcdef0123456789abcdef";
        const user = message(
            "canonical-user",
            "user",
            1,
            [{ kind: "text", text: "Send files" }],
            { idempotencyKey: providerRunId, providerRunId }
        );
        const final = message("canonical-final", "assistant", 2, [
            { kind: "text", text: "Sent files." },
        ]);
        const runtime = external("runtime-final", providerRunId, 2, [
            { kind: "text", text: "Sent files." },
        ]);

        expect(mergeChatMessages([user, final], [runtime], new Set())).toEqual([
            user,
            final,
        ]);
    });

    test("coalesces live thinking, tools, controls, and text around canonical output", () => {
        const providerRunId = "provider:merge";
        const canonical = message(
            "canonical-assistant",
            "assistant",
            10,
            [
                { kind: "thinking", status: "complete", text: "Working" },
                {
                    callId: "call-1",
                    input: { command: "inspect" },
                    kind: "tool",
                    name: "bash",
                    status: "running",
                },
                {
                    activity: "complete",
                    kind: "control",
                    text: "Run complete",
                    tone: "muted",
                },
                { kind: "text", text: "Final answer" },
            ],
            { providerRunId }
        );
        const before = external("before", providerRunId, 5, [
            { kind: "thinking", status: "running", text: "Working in detail" },
            {
                callId: "call-1",
                kind: "tool",
                name: "bash",
                output: "done",
                status: "completed",
            },
            {
                activity: "running",
                kind: "control",
                text: "Run complete",
                tone: "warning",
            },
            { kind: "text", text: "Final answer" },
            { kind: "text", text: "Live prefix" },
        ]);
        const after = external("after", providerRunId, 11, [
            { kind: "text", text: "Live suffix" },
        ]);

        const merged = mergeChatMessages([canonical], [after, before], new Set());

        expect(merged).toHaveLength(1);
        expect(merged[0]?.parts).toEqual([
            { kind: "text", text: "Live prefix" },
            {
                kind: "thinking",
                status: "complete",
                text: "Working in detail",
            },
            {
                callId: "call-1",
                input: { command: "inspect" },
                kind: "tool",
                name: "bash",
                output: "done",
                status: "completed",
            },
            {
                activity: "complete",
                kind: "control",
                text: "Run complete",
                tone: "warning",
            },
            { kind: "text", text: "Final answer" },
            { kind: "text", text: "Live suffix" },
        ]);
    });

    test("retires exact anchored external lanes into canonical activity", () => {
        const providerRunId = "provider:anchored";
        const steer = message("steer", "user", 3, [
            { kind: "text", text: "Adjust the run" },
        ]);
        const canonical = message(
            "canonical-assistant",
            "assistant",
            6,
            [
                {
                    kind: "thinking",
                    status: "complete",
                    text: "BeforeAfter",
                },
                {
                    callId: "history-tool",
                    callIdSource: "synthetic",
                    input: { command: "continue" },
                    kind: "tool",
                    name: "bash",
                    output: "done",
                    status: "completed",
                },
                {
                    activity: "complete",
                    kind: "control",
                    text: "Finished",
                    tone: "muted",
                },
                { kind: "text", text: "Canonical longer" },
            ],
            { providerRunId }
        );
        const before = external("thinking-before", providerRunId, 1, [
            { kind: "thinking", status: "running", text: "Before" },
        ]);
        const after = external(
            "activity-after",
            providerRunId,
            4,
            [
                { kind: "thinking", status: "running", text: "After" },
                {
                    callId: "runtime-tool",
                    callIdSource: "synthetic",
                    input: { command: "continue" },
                    kind: "tool",
                    name: "bash",
                    status: "completed",
                },
                {
                    activity: "running",
                    kind: "control",
                    text: "Finished",
                    tone: "warning",
                },
                { kind: "text", text: "Canonical" },
                { kind: "text", text: " longer" },
            ],
            {
                precedingUserMessageIdAnchor: steer.id,
                precedingUserTextAnchor: "Adjust the run",
            }
        );

        const merged = mergeChatMessages([steer, canonical], [before, after], new Set());

        expect(merged.map(({ id }) => id)).toEqual([steer.id, canonical.id]);
        expect(merged[1]?.parts.map(({ kind }) => kind)).toEqual([
            "thinking",
            "thinking",
            "tool",
            "control",
            "text",
        ]);
    });

    test("places consecutive anchored chunks and reconciles reversed synthetic tool identity", () => {
        const providerRunId = "provider:consecutive-anchors";
        const firstUser = message(
            "first-steer",
            "user",
            2,
            [{ kind: "text", text: "First steer" }],
            { providerRunId: "first-steer:user" }
        );
        const secondUser = message(
            "second-steer",
            "user",
            6,
            [{ kind: "text", text: "Second steer" }],
            { providerRunId: "second-steer:user" }
        );
        const canonical = message("canonical-after-steers", "assistant", 10, [
            {
                callId: "history-tool",
                callIdSource: "synthetic",
                kind: "tool",
                name: "search",
                output: "found",
                status: "completed",
            },
            { kind: "text", text: "Canonical answer" },
        ]);
        const leading = external("leading", providerRunId, 1, [
            { kind: "text", text: "Leading activity" },
        ]);
        const firstAnchor = external(
            "first-anchor",
            providerRunId,
            3,
            [
                {
                    callId: "runtime-tool",
                    callIdSource: "synthetic",
                    kind: "tool",
                    name: "search",
                    status: "running",
                },
            ],
            { precedingUserMessageIdAnchor: firstUser.id }
        );
        const between = external("between", providerRunId, 4, [
            { kind: "control", text: "Between steers", tone: "muted" },
        ]);
        const secondAnchor = external(
            "second-anchor",
            providerRunId,
            7,
            [{ kind: "text", text: "Canonical answer" }],
            { precedingUserMessageIdAnchor: secondUser.id }
        );
        const tail = external("tail", providerRunId, 8, [
            { kind: "text", text: "Trailing activity" },
        ]);

        const merged = mergeChatMessages(
            [firstUser, secondUser, canonical],
            [tail, secondAnchor, between, firstAnchor, leading],
            new Set()
        );

        expect(merged.map(({ id }) => id)).toEqual([
            firstUser.id,
            secondUser.id,
            canonical.id,
        ]);
        expect(merged.at(-1)?.parts.some((part) => part.kind === "tool")).toBeTrue();
    });

    test("matches safe synthetic tools and keeps ambiguous tools distinct", () => {
        const providerRunId = "provider:synthetic";
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const canonicalTools: ChatToolPart[] = [
            {
                callId: "history-equal",
                callIdSource: "synthetic",
                input: { command: "same" },
                kind: "tool",
                name: "bash",
                status: "completed",
            },
            {
                callId: "history-cycle",
                callIdSource: "synthetic",
                input: cyclic,
                kind: "tool",
                name: "bash",
                status: "completed",
            },
            {
                callId: "history-running",
                callIdSource: "synthetic",
                kind: "tool",
                name: "read",
                status: "running",
            },
            {
                callId: "history-nameless",
                callIdSource: "synthetic",
                kind: "tool",
                name: "unknown",
                nameSource: "synthetic",
                status: "completed",
            },
        ];
        const canonical = message("canonical-tools", "assistant", 10, canonicalTools, {
            providerRunId,
        });
        const runtime = external("tools", providerRunId, 11, [
            {
                callId: "runtime-equal",
                callIdSource: "synthetic",
                input: { command: "same" },
                kind: "tool",
                name: "bash",
                output: "merged",
                status: "completed",
            },
            {
                callId: "runtime-cycle",
                callIdSource: "synthetic",
                input: cyclic,
                kind: "tool",
                name: "bash",
                status: "completed",
            },
            {
                callId: "runtime-running",
                callIdSource: "synthetic",
                kind: "tool",
                name: "read",
                status: "running",
            },
            {
                callId: "runtime-nameless",
                callIdSource: "synthetic",
                kind: "tool",
                name: "unknown",
                nameSource: "synthetic",
                status: "completed",
            },
        ]);

        const merged = mergeChatMessages([canonical], [runtime], new Set());
        const tools = merged[0]?.parts.filter(
            (part): part is ChatToolPart => part.kind === "tool"
        );
        expect(tools?.find(({ callId }) => callId === "history-equal")?.output).toBe(
            "merged"
        );
        expect(tools).toHaveLength(7);
    });

    test("places text-anchored activity and keeps unbound runtime rows", () => {
        const providerRunId = "provider:text-anchor";
        const unowned = external("unowned", "provider:other", 1, [
            { kind: "text", text: "Other provider" },
        ]);
        const ordinary = message("runtime:ordinary", "assistant", 2, [
            { kind: "text", text: "Ordinary runtime" },
        ]);
        const firstUser = message(
            "first-user",
            "user",
            3,
            [{ kind: "text", text: "Repeated prompt" }],
            { providerRunId }
        );
        const fallbackUser = message("fallback-user", "user", 5, [
            { kind: "text", text: "Repeated prompt" },
        ]);
        const canonicalAssistant = message(
            "canonical-answer",
            "assistant",
            8,
            [{ kind: "text", text: "Answer" }],
            { providerRunId }
        );
        const before = external("before-anchor", providerRunId, 4, [
            { kind: "thinking", status: "running", text: "Before" },
        ]);
        const anchor = external(
            "anchor",
            providerRunId,
            6,
            [{ kind: "thinking", status: "running", text: "After" }],
            { precedingUserTextAnchor: "Repeated prompt" }
        );
        const after = external("after-anchor", providerRunId, 7, [
            { kind: "control", text: "Still running", tone: "muted" },
        ]);
        const hidden = message(
            "hidden-runtime",
            "user",
            9,
            [{ kind: "text", text: "Hidden" }],
            { idempotencyKey: "hidden-key" }
        );
        const echoed = message(
            "echoed-runtime",
            "user",
            10,
            [{ kind: "text", text: "Repeated prompt" }],
            { idempotencyKey: "canonical-key" }
        );
        const canonicalWithKey = { ...firstUser, idempotencyKey: "canonical-key" };

        const merged = mergeChatMessages(
            [canonicalWithKey, fallbackUser, canonicalAssistant],
            [after, anchor, before, unowned, ordinary, hidden, echoed],
            new Set([hidden.id])
        );

        expect(merged.map(({ id }) => id)).toEqual([
            canonicalWithKey.id,
            fallbackUser.id,
            canonicalAssistant.id,
            unowned.id,
            ordinary.id,
        ]);
        expect(merged.some(({ id }) => id === hidden.id)).toBeFalse();
        expect(merged.some(({ id }) => id === echoed.id)).toBeFalse();
    });

    test("collapses canonical and runtime user suffix aliases to one bubble", () => {
        const identity = "0123456789abcdef0123456789abcdef";
        const canonical = message(
            "canonical-user",
            "user",
            1,
            [{ kind: "text", text: "Only once" }],
            { idempotencyKey: identity }
        );
        const runtimeBase = message(
            "runtime-base",
            "user",
            2,
            [{ kind: "text", text: "Only once" }],
            { idempotencyKey: identity }
        );
        const runtimeCarrier = message(
            "runtime-carrier",
            "user",
            3,
            [{ kind: "text", text: "Only once" }],
            { idempotencyKey: `${identity}:user` }
        );

        expect(
            mergeChatMessages([canonical], [runtimeBase, runtimeCarrier], new Set()).map(
                ({ id }) => id
            )
        ).toEqual([canonical.id]);
        expect(
            mergeChatMessages([], [runtimeBase, runtimeCarrier], new Set()).map(
                ({ id }) => id
            )
        ).toEqual([runtimeBase.id]);
    });
});
