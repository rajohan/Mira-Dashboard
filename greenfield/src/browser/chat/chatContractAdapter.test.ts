import { describe, expect, test } from "bun:test";

import type {
    ChatExternalRun,
    ChatMessage,
    ChatRuntimeSnapshot,
} from "../../contracts/chatModel.ts";
import {
    adaptChatRuntimeEvent,
    chatToolResultMatchesCall,
    projectChatContractMessage,
    projectChatExternalRun,
    projectChatRuntimeSnapshot,
} from "./chatContractAdapter.ts";

const sessionKey = "agent:main:main";
const runId = "019fe633-9133-7ba0-8b80-809dd80dfb39";
const timestampMs = 1_800_000_000_000;

describe("chat contract adapter", () => {
    test("projects ordered hydrated parts and managed media", () => {
        const message: ChatMessage = {
            content: {
                kind: "complete",
                parts: [
                    { id: "text-1", kind: "text", text: "Before" },
                    { id: "thinking-1", kind: "thinking", text: "Reasoning" },
                    {
                        callId: "tool-1",
                        id: "tool-1",
                        input: '{"query":"status"}',
                        isError: false,
                        kind: "tool",
                        name: "lookup",
                        output: "ok",
                        phase: "succeeded",
                    },
                    { id: "text-2", kind: "text", text: "After" },
                    {
                        downloadUrl:
                            "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb40?disposition=download",
                        fileName: "chart.png",
                        id: "media-1",
                        kind: "attachment",
                        mediaType: "image/png",
                        renderPolicy: "inline-image",
                        sizeBytes: 12,
                        url: "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb40?disposition=preview",
                    },
                ],
            },
            createdAtMs: timestampMs,
            id: "message-1",
            role: "assistant",
            sequence: 7,
            source: "gateway-history",
        };
        expect(projectChatContractMessage(message, sessionKey, 0)).toMatchObject({
            attachments: [
                {
                    downloadUrl:
                        "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb40?disposition=download",
                    id: "media-1",
                    name: "chart.png",
                    previewUrl:
                        "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb40?disposition=preview",
                    renderPolicy: "inline-image",
                },
            ],
            parts: [
                { kind: "text", text: "Before" },
                { kind: "thinking", status: "complete", text: "Reasoning" },
                { kind: "tool", name: "lookup", status: "completed" },
                { kind: "text", text: "After" },
            ],
            role: "assistant",
            sequence: 7,
        });
    });

    test("coalesces split call and result parts with one stable tool lifecycle", () => {
        const message: ChatMessage = {
            content: {
                kind: "complete",
                parts: [
                    {
                        callId: "call-1",
                        id: "call-part",
                        input: '{"cmd":"bun test","workdir":"/workspace/app"}',
                        isError: false,
                        kind: "tool",
                        name: "functions.exec_command",
                        phase: "started",
                    },
                    {
                        callId: "call-1",
                        id: "result-part",
                        isError: false,
                        kind: "tool",
                        name: "tool",
                        output: "8 pass",
                        phase: "succeeded",
                    },
                ],
            },
            id: "message-tool-pair",
            role: "assistant",
            source: "gateway-history",
        };

        expect(projectChatContractMessage(message, sessionKey, 0).parts).toEqual([
            {
                callId: "call-1",
                input: '{"cmd":"bun test","workdir":"/workspace/app"}',
                kind: "tool",
                name: "functions.exec_command",
                output: "8 pass",
                status: "completed",
            },
        ]);
    });

    test("pairs synthetic same-name results with the first unresolved call", () => {
        const message: ChatMessage = {
            content: {
                kind: "complete",
                parts: [
                    {
                        callId: "1",
                        callIdSource: "synthetic",
                        id: "call-1",
                        input: "first",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        phase: "started",
                    },
                    {
                        callId: "2",
                        callIdSource: "synthetic",
                        id: "call-2",
                        input: "second",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        phase: "started",
                    },
                    {
                        callId: "3",
                        callIdSource: "synthetic",
                        id: "result-1",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        output: "first result",
                        phase: "succeeded",
                    },
                ],
            },
            id: "synthetic-tool-pair",
            role: "assistant",
            source: "gateway-history",
        };

        expect(projectChatContractMessage(message, sessionKey, 0).parts).toEqual([
            {
                callId: "1",
                callIdSource: "synthetic",
                input: "first",
                kind: "tool",
                name: "search",
                output: "first result",
                status: "completed",
            },
            {
                callId: "2",
                callIdSource: "synthetic",
                input: "second",
                kind: "tool",
                name: "search",
                status: "running",
            },
        ]);
    });

    test("consumes a terminal tool result only once", () => {
        const result = {
            callId: "call-1",
            kind: "tool" as const,
            name: "search",
            output: "found",
            status: "completed" as const,
        };
        expect(
            chatToolResultMatchesCall(
                {
                    callId: "call-1",
                    input: '{"query":"runtime"}',
                    kind: "tool",
                    name: "search",
                    status: "running",
                },
                result
            )
        ).toBeTrue();
        expect(
            chatToolResultMatchesCall(
                {
                    callId: "call-1",
                    kind: "tool",
                    name: "search",
                    output: "first result",
                    status: "completed",
                },
                result
            )
        ).toBeFalse();
    });

    test("maps every runtime lifecycle family explicitly", () => {
        const base = { occurredAtMs: timestampMs, runId, sequence: 1 };
        expect(
            adaptChatRuntimeEvent(sessionKey, "1", {
                ...base,
                kind: "assistant",
                mode: "append",
                text: "Hello",
            })
        ).toMatchObject({ cursor: 1, kind: "assistant", sessionKey, text: "Hello" });
        expect(
            adaptChatRuntimeEvent(sessionKey, "2", {
                ...base,
                callId: "tool-1",
                isError: false,
                kind: "tool",
                name: "lookup",
                output: "ok",
                phase: "succeeded",
            })
        ).toMatchObject({ callId: "tool-1", kind: "tool-completed", output: "ok" });
        expect(
            adaptChatRuntimeEvent(sessionKey, "3", {
                ...base,
                errorMessage: "Provider failed",
                kind: "terminal",
                outcome: "error",
            })
        ).toMatchObject({ kind: "failed", text: "Provider failed" });
        expect(
            adaptChatRuntimeEvent(sessionKey, "4", {
                ...base,
                historyMessageId: "message-1",
                kind: "reconciled",
            })
        ).toMatchObject({ kind: "reconciled" });
        expect(
            adaptChatRuntimeEvent(sessionKey, "5", {
                ...base,
                kind: "provider-noop",
                providerSequence: 9,
                reason: "ignored",
            })
        ).toMatchObject({ cursor: 5, kind: "noop" });
    });

    test("projects restart snapshots in their strict ordered part sequence", () => {
        const snapshot: ChatRuntimeSnapshot = {
            firstSequence: 1,
            parts: [
                { kind: "thinking", sequence: 1, text: "Thought" },
                {
                    callId: "tool-1",
                    isError: false,
                    kind: "tool",
                    name: "lookup",
                    output: "ok",
                    phase: "succeeded",
                    sequence: 2,
                },
                {
                    id: "item-1",
                    kind: "item",
                    sequence: 3,
                    text: "One",
                    type: "plan",
                },
                { kind: "assistant", sequence: 4, text: "Final" },
            ],
            projectionTruncated: false,
            run: {
                admittedAtMs: timestampMs,
                id: runId,
                reconciliation: "history-authoritative",
                reconciledAtMs: timestampMs + 2,
                sessionKey,
                state: "completed",
                stateVersion: 2,
                terminalAtMs: timestampMs + 2,
                updatedAtMs: timestampMs + 2,
            },
            throughSequence: 4,
        };
        expect(projectChatRuntimeSnapshot(snapshot)).toMatchObject({
            lastSequence: 4,
            message: {
                parts: [
                    { kind: "thinking", status: "complete" },
                    { kind: "tool", status: "completed" },
                    { kind: "control", text: "plan: One" },
                    { kind: "text", text: "Final" },
                ],
            },
            phase: "completed",
            reconciliation: "history-authoritative",
        });
    });

    test("projects provider-origin runs without fabricating local admission identity", () => {
        const externalRun: ChatExternalRun = {
            continuity: "interrupted",
            hasUnprojectedActivity: false,
            parts: [
                {
                    kind: "assistant",
                    sequence: 1,
                    text: "Provider response",
                },
                {
                    callId: "provider-tool-1",
                    input: '{"query":"runtime"}',
                    isError: false,
                    kind: "tool",
                    name: "search",
                    output: "Found runtime activity",
                    phase: "succeeded",
                    sequence: 2,
                },
            ],
            plan: {
                phase: "update",
                steps: [{ status: "in_progress", text: "Inspect provider state" }],
            },
            projectionTruncated: false,
            providerRunId: "provider-run-1",
            sessionKey,
            source: "provider-runtime",
            text: "Provider response",
            updatedAtMs: timestampMs,
        };

        const projection = projectChatExternalRun(externalRun);
        expect(projection.message).toMatchObject({
            id: `external:${sessionKey}:provider-run-1`,
            parts: [
                { kind: "text", text: "Provider response" },
                {
                    input: '{"query":"runtime"}',
                    kind: "tool",
                    output: "Found runtime activity",
                    status: "completed",
                },
                {
                    kind: "control",
                    text: expect.stringContaining("Activity updates were interrupted"),
                },
            ],
            role: "assistant",
        });
        expect(projection.message.parts).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    text: expect.stringContaining("started outside the Dashboard"),
                }),
            ])
        );
        expect(projection.message).not.toHaveProperty("clientRunId");
        expect(projection.message).not.toHaveProperty("runId");
        expect(projection.plan).toMatchObject({
            runId: "provider:provider-run-1",
            title: "OpenClaw plan",
        });
    });

    test("retains provider thinking and item activity while excluding provider user echoes", () => {
        const projection = projectChatExternalRun({
            continuity: "complete",
            hasUnprojectedActivity: false,
            parts: [
                {
                    kind: "thinking",
                    sequence: 1,
                    text: "Inspecting the workspace",
                },
                {
                    id: "item-with-text",
                    kind: "item",
                    sequence: 2,
                    text: "Read the current configuration",
                    type: "progress",
                },
                {
                    id: "item-without-text",
                    kind: "item",
                    sequence: 3,
                    type: "checkpoint",
                },
                {
                    kind: "user",
                    sequence: 4,
                    text: "Provider-side copy of the prompt",
                },
            ],
            projectionTruncated: false,
            providerRunId: "provider-activity",
            sessionKey,
            source: "provider-runtime",
            text: "",
            updatedAtMs: timestampMs,
        });

        expect(projection.message.parts).toEqual([
            {
                kind: "thinking",
                status: "running",
                text: "Inspecting the workspace",
            },
            {
                kind: "control",
                text: "progress: Read the current configuration",
                tone: "muted",
            },
            { kind: "control", text: "checkpoint", tone: "muted" },
        ]);
        expect(JSON.stringify(projection.message)).not.toContain(
            "Provider-side copy of the prompt"
        );
    });

    test("keeps truncated assistant text authoritative and folds synthetic tool lifecycle", () => {
        const projection = projectChatExternalRun({
            continuity: "complete",
            hasUnprojectedActivity: true,
            parts: [
                { kind: "assistant", sequence: 1, text: "stale tail" },
                {
                    callId: "synthetic-start",
                    callIdSource: "synthetic",
                    input: '{"query":"runtime"}',
                    isError: false,
                    kind: "tool",
                    name: "search",
                    phase: "started",
                    sequence: 2,
                },
                {
                    callId: "synthetic-result",
                    callIdSource: "synthetic",
                    isError: false,
                    kind: "tool",
                    name: "search",
                    output: "found",
                    phase: "succeeded",
                    sequence: 3,
                },
            ],
            projectionTruncated: true,
            providerRunId: "provider-truncated",
            sessionKey,
            source: "provider-runtime",
            text: "The complete accumulated assistant response.",
            updatedAtMs: timestampMs,
        });

        expect(projection.message.parts).toEqual([
            {
                callId: "synthetic-start",
                callIdSource: "synthetic",
                input: '{"query":"runtime"}',
                kind: "tool",
                name: "search",
                output: "found",
                status: "completed",
            },
            { kind: "text", text: "The complete accumulated assistant response." },
            {
                kind: "control",
                text: "Some OpenClaw activity details were not returned.",
                tone: "warning",
            },
            {
                kind: "control",
                text: "Some additional OpenClaw activity could not be shown.",
                tone: "warning",
            },
        ]);
        expect(JSON.stringify(projection)).not.toContain("stale tail");
    });

    test("treats truncated projections as explicit placeholders, not empty transcripts", () => {
        const snapshot: ChatRuntimeSnapshot = {
            firstSequence: 1,
            parts: [],
            projectionTruncated: true,
            run: {
                admittedAtMs: timestampMs,
                id: runId,
                reconciliation: "pending",
                sessionKey,
                state: "active",
                stateVersion: 1,
                updatedAtMs: timestampMs,
            },
            throughSequence: 8,
        };
        const projected = projectChatRuntimeSnapshot(snapshot);
        expect(projected).toMatchObject({
            lastSequence: 8,
            projectionTruncated: true,
            message: {
                parts: [
                    {
                        kind: "control",
                        text: expect.stringContaining(
                            "live response details were not returned"
                        ),
                        tone: "warning",
                    },
                ],
            },
        });
        expect(projected).not.toHaveProperty("userMessage");
    });

    test("renders expired reconciliation as unresolved rather than failed or active", () => {
        const snapshot: ChatRuntimeSnapshot = {
            firstSequence: 1,
            parts: [],
            projectionTruncated: false,
            run: {
                admittedAtMs: timestampMs,
                id: runId,
                reconciliation: "failed",
                sessionKey,
                state: "unresolved",
                stateVersion: 2,
                terminalAtMs: timestampMs + 1000,
                updatedAtMs: timestampMs + 1000,
            },
            throughSequence: 1,
        };
        expect(projectChatRuntimeSnapshot(snapshot)).toMatchObject({
            phase: "unresolved",
            message: {
                parts: [
                    {
                        kind: "control",
                        text: expect.stringContaining(
                            "still has not confirmed the result"
                        ),
                        tone: "warning",
                    },
                ],
            },
        });
    });
});
