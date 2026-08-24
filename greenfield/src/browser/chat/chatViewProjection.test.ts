import { describe, expect, test } from "bun:test";

import type { ChatMessage } from "../../contracts/chatModel.ts";
import {
    deriveGatewaySessionStats,
    type GatewaySession,
    type ListGatewaySessionsResult,
} from "../../contracts/gatewaySessions.ts";
import { projectChatExternalRun } from "./chatContractAdapter.ts";
import { sortChatDisplayMessages } from "./chatMessageOrdering.ts";
import { chatRuntimeMessages, createChatRuntimeStore } from "./chatRuntimeStore.ts";
import {
    mergeChatMessages,
    projectChatHistory,
    projectChatSessions,
} from "./chatViewProjection.ts";

const sessionKey = "agent:main:main";

function completeMessage(id: string, text = id) {
    return {
        content: {
            kind: "complete" as const,
            parts: [{ id: `${id}-text`, kind: "text" as const, text }],
        },
        id,
        role: "assistant" as const,
        source: "gateway-history" as const,
    };
}

type CompleteChatParts = Extract<ChatMessage["content"], { kind: "complete" }>["parts"];

function toolHistoryMessage({
    id,
    parts,
    providerRunId,
    role,
}: Readonly<{
    id: string;
    parts: CompleteChatParts;
    providerRunId?: string;
    role: "assistant" | "tool";
}>): ChatMessage {
    return {
        content: { kind: "complete", parts },
        id,
        ...(providerRunId === undefined ? {} : { runId: providerRunId }),
        role,
        source: "gateway-history",
    };
}

function syntheticToolMessage({
    callId,
    id,
    input,
    name = "search",
    output,
    phase,
    role,
}: Readonly<{
    callId: string;
    id: string;
    input?: string;
    name?: string;
    output?: string;
    phase: "started" | "succeeded";
    role: "assistant" | "tool";
}>) {
    return toolHistoryMessage({
        id,
        parts: [
            {
                callId,
                callIdSource: "synthetic",
                id: `${id}-part`,
                ...(input === undefined ? {} : { input }),
                isError: false,
                kind: "tool",
                name,
                ...(output === undefined ? {} : { output }),
                phase,
            },
        ],
        role,
    });
}

function userMessage(id: string, text = id): ChatMessage {
    return {
        content: {
            kind: "complete",
            parts: [{ id: `${id}-text`, kind: "text", text }],
        },
        id,
        role: "user",
        source: "gateway-history",
    };
}

function projectSinglePage(messages: ChatMessage[]) {
    return projectChatHistory(
        {
            pageParams: ["0"],
            pages: [
                {
                    messages,
                    providerPagesRead: 1,
                    sessionId: "provider-session-a",
                    sessionKey,
                    truncated: false,
                },
            ],
        },
        sessionKey
    );
}

function chatAttachmentPart(
    id: string,
    mediaId: string,
    fileName: string
): CompleteChatParts[number] {
    return {
        downloadUrl: `/api/chat/media/${mediaId}?disposition=download`,
        fileName,
        id,
        kind: "attachment",
        mediaType: "text/plain",
        renderPolicy: "bounded-text",
        sizeBytes: 12,
        url: `/api/chat/media/${mediaId}?disposition=preview`,
    };
}

describe("chat view projection", () => {
    test("retains provider auto fast mode beside its effective speed", () => {
        const observedAtMs = 1_800_000_000_000;
        const session: GatewaySession = {
            displayName: "Mira main",
            effectiveFastMode: false,
            fastMode: "auto",
            hasActiveRun: false,
            key: sessionKey,
            kind: "main",
            totalTokensFresh: false,
        };
        const snapshot: ListGatewaySessionsResult = {
            filter: "ALL",
            projectionTruncated: false,
            sessions: [session],
            source: {
                checkedAtMs: observedAtMs,
                connection: "connected",
                freshness: "fresh",
                observedAtMs,
            },
            stats: deriveGatewaySessionStats([session], observedAtMs),
        };

        expect(projectChatSessions(snapshot, undefined)[0]).toMatchObject({
            fastMode: "auto",
            speed: "standard",
        });
    });

    test("retains a truncated preview until its one explicit detail is available", () => {
        const data = {
            pageParams: ["0"],
            pages: [
                {
                    messages: [
                        {
                            content: {
                                kind: "hydration-required" as const,
                                preview: "Preview",
                                reason: "response-budget" as const,
                            },
                            id: "message-1",
                            role: "assistant" as const,
                            source: "gateway-history" as const,
                        },
                    ],
                    providerPagesRead: 1,
                    sessionKey,
                    truncated: true,
                },
            ],
        };
        expect(projectChatHistory(data, sessionKey)[0]).toMatchObject({
            hydration: "required",
            parts: [{ text: "Preview" }],
        });
        expect(
            projectChatHistory(data, sessionKey, {
                detail: {
                    message: {
                        content: {
                            kind: "complete",
                            parts: [{ id: "text-1", kind: "text", text: "Full" }],
                        },
                        id: "message-1",
                        role: "assistant",
                        source: "gateway-history",
                    },
                    status: "available",
                },
                messageId: "message-1",
            })[0]
        ).toMatchObject({ parts: [{ kind: "text", text: "Full" }] });
    });

    test("keeps local hiding separate from canonical history", () => {
        const message = {
            attachments: [],
            id: "message-1",
            parts: [{ kind: "text" as const, text: "Visible" }],
            role: "assistant" as const,
            sequence: 1,
            sessionKey,
        };
        expect(mergeChatMessages([message], [], new Set([message.id]))).toEqual([]);
        expect(message.parts[0]?.text).toBe("Visible");
    });

    test("deduplicates overlapping history pages with newest-page identity authoritative", () => {
        const projected = projectChatHistory(
            {
                pageParams: ["0", "2"],
                pages: [
                    {
                        messages: [
                            completeMessage("message-2", "newest copy"),
                            completeMessage("message-3", "newest"),
                        ],
                        providerPagesRead: 1,
                        sessionId: "provider-session-a",
                        sessionKey,
                        truncated: false,
                    },
                    {
                        messages: [
                            completeMessage("message-1", "oldest"),
                            completeMessage("message-2", "stale copy"),
                        ],
                        providerPagesRead: 1,
                        sessionId: "provider-session-a",
                        sessionKey,
                        truncated: false,
                    },
                ],
            },
            sessionKey
        );
        expect(projected.map(({ id }) => id)).toEqual([
            "message-1",
            "message-2",
            "message-3",
        ]);
        expect(projected[1]?.parts).toEqual([{ kind: "text", text: "newest copy" }]);
    });

    test("folds a paginated tool-result row into its assistant call", () => {
        const projected = projectChatHistory(
            {
                pageParams: ["0", "1"],
                pages: [
                    {
                        messages: [
                            {
                                content: {
                                    kind: "complete",
                                    parts: [
                                        {
                                            callId: "call-1",
                                            id: "result-1",
                                            isError: false,
                                            kind: "tool",
                                            name: "tool",
                                            output: "command output",
                                            phase: "succeeded",
                                        },
                                    ],
                                },
                                id: "tool-result-message",
                                role: "tool",
                                source: "gateway-history",
                            },
                        ],
                        providerPagesRead: 1,
                        sessionId: "provider-session-a",
                        sessionKey,
                        truncated: false,
                    },
                    {
                        messages: [
                            {
                                content: {
                                    kind: "complete",
                                    parts: [
                                        {
                                            callId: "call-1",
                                            id: "call-1",
                                            input: '{"cmd":"bun test"}',
                                            isError: false,
                                            kind: "tool",
                                            name: "functions.exec_command",
                                            phase: "started",
                                        },
                                    ],
                                },
                                id: "assistant-tool-message",
                                role: "assistant",
                                source: "gateway-history",
                            },
                        ],
                        providerPagesRead: 1,
                        sessionId: "provider-session-a",
                        sessionKey,
                        truncated: false,
                    },
                ],
            },
            sessionKey
        );

        expect(projected).toHaveLength(1);
        expect(projected[0]).toMatchObject({
            id: "assistant-tool-message",
            parts: [
                {
                    callId: "call-1",
                    input: '{"cmd":"bun test"}',
                    name: "functions.exec_command",
                    output: "command output",
                    status: "completed",
                },
            ],
            role: "assistant",
        });
    });

    test("moves unique result attachments onto the tool call without losing provider notices", () => {
        const firstMediaId = "019fe633-9133-4ba0-8b80-809dd80dfb40";
        const secondMediaId = "019fe633-9133-4ba0-8b80-809dd80dfb41";
        const projected = projectSinglePage([
            toolHistoryMessage({
                id: "assistant-tool-message",
                parts: [
                    {
                        callId: "call-with-media",
                        id: "call-with-media",
                        input: '{"cmd":"inspect"}',
                        isError: false,
                        kind: "tool",
                        name: "functions.exec_command",
                        phase: "started",
                    },
                    chatAttachmentPart("assistant-media", firstMediaId, "first.txt"),
                ],
                role: "assistant",
            }),
            toolHistoryMessage({
                id: "tool-result-message",
                parts: [
                    {
                        callId: "call-with-media",
                        id: "tool-result",
                        isError: false,
                        kind: "tool",
                        name: "functions.exec_command",
                        output: "done",
                        phase: "succeeded",
                    },
                    chatAttachmentPart("duplicate-media", firstMediaId, "first.txt"),
                    chatAttachmentPart("new-media", secondMediaId, "second.txt"),
                    {
                        id: "provider-notice",
                        kind: "control",
                        text: "Provider retained a diagnostic notice.",
                    },
                ],
                role: "tool",
            }),
        ]);

        expect(projected).toHaveLength(2);
        expect(projected[0]).toMatchObject({
            attachments: [
                { id: "assistant-media", name: "first.txt" },
                { id: "new-media", name: "second.txt" },
            ],
            parts: [
                {
                    callId: "call-with-media",
                    input: '{"cmd":"inspect"}',
                    output: "done",
                    status: "completed",
                },
            ],
            role: "assistant",
        });
        expect(projected[1]).toMatchObject({
            attachments: [],
            parts: [
                {
                    kind: "control",
                    text: "Provider retained a diagnostic notice.",
                },
            ],
            role: "control",
        });
    });

    test("folds synthetic same-name results across a page boundary without trusting their indexes", () => {
        const projected = projectChatHistory(
            {
                pageParams: ["0", "1"],
                pages: [
                    {
                        messages: [
                            syntheticToolMessage({
                                callId: "1",
                                id: "result-message",
                                output: "found",
                                phase: "succeeded",
                                role: "tool",
                            }),
                        ],
                        providerPagesRead: 1,
                        sessionId: "provider-session-a",
                        sessionKey,
                        truncated: false,
                    },
                    {
                        messages: [
                            syntheticToolMessage({
                                callId: "7",
                                id: "call-message",
                                input: '{"query":"runtime"}',
                                phase: "started",
                                role: "assistant",
                            }),
                        ],
                        providerPagesRead: 1,
                        sessionId: "provider-session-a",
                        sessionKey,
                        truncated: false,
                    },
                ],
            },
            sessionKey
        );

        expect(projected).toHaveLength(1);
        expect(projected[0]?.parts).toEqual([
            {
                callId: "7",
                callIdSource: "synthetic",
                input: '{"query":"runtime"}',
                kind: "tool",
                name: "search",
                output: "found",
                status: "completed",
            },
        ]);
    });

    test("does not fold a synthetic result into a same-name call from an older user turn", () => {
        const projected = projectChatHistory(
            {
                pageParams: ["0"],
                pages: [
                    {
                        messages: [
                            syntheticToolMessage({
                                callId: "1",
                                id: "old-call",
                                phase: "started",
                                role: "assistant",
                            }),
                            {
                                content: {
                                    kind: "complete" as const,
                                    parts: [
                                        {
                                            id: "new-user-text",
                                            kind: "text" as const,
                                            text: "New turn",
                                        },
                                    ],
                                },
                                id: "new-user",
                                role: "user" as const,
                                source: "gateway-history" as const,
                            },
                            syntheticToolMessage({
                                callId: "1",
                                id: "orphan-result",
                                output: "new result",
                                phase: "succeeded",
                                role: "tool",
                            }),
                        ],
                        providerPagesRead: 1,
                        sessionId: "provider-session-a",
                        sessionKey,
                        truncated: false,
                    },
                ],
            },
            sessionKey
        );

        expect(projected.map(({ id }) => id)).toEqual([
            "old-call",
            "new-user",
            "orphan-result",
        ]);
        expect(projected[0]?.parts[0]).toMatchObject({ status: "running" });
        expect(projected[2]?.parts[0]).toMatchObject({
            output: "new result",
            status: "completed",
        });
    });

    test("folds an exact provider call id across an intervening user row", () => {
        const projected = projectSinglePage([
            toolHistoryMessage({
                id: "call-message",
                parts: [
                    {
                        callId: "provider-call-1",
                        id: "call-part",
                        input: "first",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        phase: "started",
                    },
                ],
                role: "assistant",
            }),
            userMessage("new-user"),
            toolHistoryMessage({
                id: "result-message",
                parts: [
                    {
                        callId: "provider-call-1",
                        id: "result-part",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        output: "found",
                        phase: "succeeded",
                    },
                ],
                role: "tool",
            }),
        ]);

        expect(projected.map(({ id }) => id)).toEqual(["call-message", "new-user"]);
        expect(projected[0]?.parts[0]).toMatchObject({
            input: "first",
            output: "found",
            status: "completed",
        });
    });

    test("folds an exact call id when only the result exposes its provider run", () => {
        const projected = projectSinglePage([
            toolHistoryMessage({
                id: "call-message",
                parts: [
                    {
                        callId: "provider-call-1",
                        id: "call-part",
                        input: "first",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        phase: "started",
                    },
                ],
                role: "assistant",
            }),
            toolHistoryMessage({
                id: "result-message",
                parts: [
                    {
                        callId: "provider-call-1",
                        id: "result-part",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        output: "found",
                        phase: "succeeded",
                    },
                ],
                providerRunId: "provider-run-1",
                role: "tool",
            }),
        ]);

        expect(projected.map(({ id }) => id)).toEqual(["call-message"]);
        expect(projected[0]?.parts[0]).toMatchObject({
            input: "first",
            output: "found",
            status: "completed",
        });
    });

    test("folds separate synthetic same-name results in provider order", () => {
        const projected = projectSinglePage([
            toolHistoryMessage({
                id: "calls",
                parts: [
                    {
                        callId: "call-index-1",
                        callIdSource: "synthetic",
                        id: "call-part-1",
                        input: "first",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        phase: "started",
                    },
                    {
                        callId: "call-index-2",
                        callIdSource: "synthetic",
                        id: "call-part-2",
                        input: "second",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        phase: "started",
                    },
                ],
                role: "assistant",
            }),
            syntheticToolMessage({
                callId: "result-index-1",
                id: "result-1",
                output: "first output",
                phase: "succeeded",
                role: "tool",
            }),
            syntheticToolMessage({
                callId: "result-index-2",
                id: "result-2",
                output: "second output",
                phase: "succeeded",
                role: "tool",
            }),
        ]);

        expect(projected).toHaveLength(1);
        expect(projected[0]?.parts).toEqual([
            {
                callId: "call-index-1",
                callIdSource: "synthetic",
                input: "first",
                kind: "tool",
                name: "search",
                output: "first output",
                status: "completed",
            },
            {
                callId: "call-index-2",
                callIdSource: "synthetic",
                input: "second",
                kind: "tool",
                name: "search",
                output: "second output",
                status: "completed",
            },
        ]);
    });

    test("folds multiple synthetic results from one row in provider order", () => {
        const projected = projectSinglePage([
            toolHistoryMessage({
                id: "calls",
                parts: [
                    {
                        callId: "call-1",
                        callIdSource: "synthetic",
                        id: "call-part-1",
                        input: "first",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        phase: "started",
                    },
                    {
                        callId: "call-2",
                        callIdSource: "synthetic",
                        id: "call-part-2",
                        input: "second",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        phase: "started",
                    },
                ],
                role: "assistant",
            }),
            toolHistoryMessage({
                id: "results",
                parts: [
                    {
                        callId: "result-1",
                        callIdSource: "synthetic",
                        id: "result-part-1",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        output: "first output",
                        phase: "succeeded",
                    },
                    {
                        callId: "result-2",
                        callIdSource: "synthetic",
                        id: "result-part-2",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        output: "second output",
                        phase: "succeeded",
                    },
                ],
                role: "tool",
            }),
        ]);

        expect(projected).toHaveLength(1);
        expect(projected[0]?.parts).toEqual([
            expect.objectContaining({ input: "first", output: "first output" }),
            expect.objectContaining({ input: "second", output: "second output" }),
        ]);
    });

    test("retains a duplicate explicit terminal result as a standalone control row", () => {
        const call = toolHistoryMessage({
            id: "call",
            parts: [
                {
                    callId: "provider-call-1",
                    id: "call-part",
                    isError: false,
                    kind: "tool",
                    name: "search",
                    phase: "started",
                },
            ],
            role: "assistant",
        });
        const result = (id: string, output: string) =>
            toolHistoryMessage({
                id,
                parts: [
                    {
                        callId: "provider-call-1",
                        id: `${id}-part`,
                        isError: false,
                        kind: "tool",
                        name: "search",
                        output,
                        phase: "succeeded",
                    },
                ],
                role: "tool",
            });
        const projected = projectSinglePage([
            call,
            result("first-result", "first output"),
            result("duplicate-result", "duplicate output"),
        ]);

        expect(projected.map(({ id }) => id)).toEqual(["call", "duplicate-result"]);
        expect(projected[0]?.parts[0]).toMatchObject({ output: "first output" });
        expect(projected[1]?.parts[0]).toMatchObject({ output: "duplicate output" });
    });

    test("uses provider run scope for synthetic cross-turn folding and rejects mismatches", () => {
        const call = toolHistoryMessage({
            id: "call",
            parts: [
                {
                    callId: "call-index",
                    callIdSource: "synthetic",
                    id: "call-part",
                    isError: false,
                    kind: "tool",
                    name: "search",
                    phase: "started",
                },
            ],
            providerRunId: "provider-run-1",
            role: "assistant",
        });
        const result = (providerRunId: string) =>
            toolHistoryMessage({
                id: `result-${providerRunId}`,
                parts: [
                    {
                        callId: "result-index",
                        callIdSource: "synthetic",
                        id: "result-part",
                        isError: false,
                        kind: "tool",
                        name: "search",
                        output: "found",
                        phase: "succeeded",
                    },
                ],
                providerRunId,
                role: "tool",
            });

        expect(
            projectSinglePage([call, userMessage("new-user"), result("provider-run-1")])
        ).toHaveLength(2);
        expect(
            projectSinglePage([call, userMessage("new-user"), result("provider-run-2")])
        ).toHaveLength(3);
    });

    test("does not use anonymous fallback names as synthetic match identity", () => {
        const projected = projectSinglePage([
            toolHistoryMessage({
                id: "anonymous-call",
                parts: [
                    {
                        callId: "call-index",
                        callIdSource: "synthetic",
                        id: "call-part",
                        isError: false,
                        kind: "tool",
                        name: "tool",
                        nameSource: "synthetic",
                        phase: "started",
                    },
                ],
                role: "assistant",
            }),
            toolHistoryMessage({
                id: "anonymous-result",
                parts: [
                    {
                        callId: "result-index",
                        callIdSource: "synthetic",
                        id: "result-part",
                        isError: false,
                        kind: "tool",
                        name: "tool",
                        nameSource: "synthetic",
                        output: "unknown",
                        phase: "succeeded",
                    },
                ],
                role: "tool",
            }),
        ]);

        expect(projected.map(({ id }) => id)).toEqual([
            "anonymous-call",
            "anonymous-result",
        ]);
    });

    test("does not splice older pages from a different provider session identity", () => {
        const projected = projectChatHistory(
            {
                pageParams: ["0", "1"],
                pages: [
                    {
                        messages: [completeMessage("new-session-message")],
                        providerPagesRead: 1,
                        sessionId: "provider-session-b",
                        sessionKey,
                        truncated: false,
                    },
                    {
                        messages: [completeMessage("old-session-message")],
                        providerPagesRead: 1,
                        sessionId: "provider-session-a",
                        sessionKey,
                        truncated: false,
                    },
                ],
            },
            sessionKey
        );
        expect(projected.map(({ id }) => id)).toEqual(["new-session-message"]);
    });

    test("preserves canonical provider order when timestamps are missing", () => {
        const canonical = [
            {
                attachments: [],
                id: "message-1",
                parts: [{ kind: "text" as const, text: "Older" }],
                role: "assistant" as const,
                sequence: 1,
                sessionKey,
                timestampMs: 1_800_000_000_000,
            },
            {
                attachments: [],
                id: "message-2",
                parts: [{ kind: "text" as const, text: "Newer" }],
                role: "assistant" as const,
                sequence: 2,
                sessionKey,
            },
        ];
        const runtime = [
            {
                attachments: [],
                id: "runtime-2",
                parts: [],
                role: "assistant" as const,
                sequence: 4,
                sessionKey,
                timestampMs: 1_800_000_000_002,
            },
            {
                attachments: [],
                id: "runtime-1",
                parts: [],
                role: "assistant" as const,
                sequence: 3,
                sessionKey,
                timestampMs: 1_800_000_000_001,
            },
        ];
        expect(
            mergeChatMessages(canonical, runtime, new Set()).map(({ id }) => id)
        ).toEqual(["message-1", "message-2", "runtime-1", "runtime-2"]);
    });

    test("sorts provider groups transitively and independently of input order", () => {
        const providerLaterSequence = {
            attachments: [],
            id: "provider-later-sequence",
            parts: [],
            providerRunId: "provider-group",
            role: "assistant" as const,
            sequence: 2,
            sessionKey,
            timestampMs: 100,
        };
        const providerEarlierSequence = {
            ...providerLaterSequence,
            id: "provider-earlier-sequence",
            sequence: 1,
            timestampMs: 300,
        };
        const ordinary = {
            ...providerLaterSequence,
            id: "ordinary",
            providerRunId: undefined,
            sequence: 3,
            timestampMs: 200,
        };
        const permutations = [
            [providerLaterSequence, providerEarlierSequence, ordinary],
            [providerLaterSequence, ordinary, providerEarlierSequence],
            [providerEarlierSequence, providerLaterSequence, ordinary],
            [providerEarlierSequence, ordinary, providerLaterSequence],
            [ordinary, providerLaterSequence, providerEarlierSequence],
            [ordinary, providerEarlierSequence, providerLaterSequence],
        ];

        expect(
            permutations.map((messages) =>
                sortChatDisplayMessages(messages).map(({ id }) => id)
            )
        ).toEqual(
            Array.from({ length: permutations.length }, () => [
                "provider-earlier-sequence",
                "provider-later-sequence",
                "ordinary",
            ])
        );
    });

    test("orders canonically equivalent distinct ids and run groups deterministically", () => {
        const nfc = "é";
        const nfd = "e\u0301";
        const messageWith = (id: string, providerRunId: string) => ({
            attachments: [],
            id,
            parts: [],
            providerRunId,
            role: "assistant" as const,
            sequence: 1,
            sessionKey,
            timestampMs: 100,
        });
        const equivalentIds = [
            messageWith(`message-${nfc}`, "same-run"),
            messageWith(`message-${nfd}`, "same-run"),
        ];
        const equivalentGroups = [
            messageWith("shared-message", `run-${nfc}`),
            messageWith("shared-message", `run-${nfd}`),
        ];

        for (const input of [equivalentIds, equivalentIds.toReversed()]) {
            expect(sortChatDisplayMessages(input).map(({ id }) => id)).toEqual([
                `message-${nfd}`,
                `message-${nfc}`,
            ]);
        }
        for (const input of [equivalentGroups, equivalentGroups.toReversed()]) {
            expect(
                sortChatDisplayMessages(input).map(({ providerRunId }) => providerRunId)
            ).toEqual([`run-${nfd}`, `run-${nfc}`]);
        }
    });

    test("anchors repeated same-text steers to the exact canonical message id", () => {
        const canonicalUser = (id: string, providerRunId: string, sequence: number) => ({
            attachments: [],
            id,
            parts: [{ kind: "text" as const, text: "Continue" }],
            providerRunId,
            role: "user" as const,
            sequence,
            sessionKey,
        });
        const external = (
            id: string,
            sequence: number,
            precedingUserTextAnchor?: string,
            precedingUserMessageIdAnchor?: string
        ) => ({
            attachments: [],
            id,
            parts: [{ kind: "thinking" as const, status: "running" as const, text: id }],
            ...(precedingUserMessageIdAnchor === undefined
                ? {}
                : { precedingUserMessageIdAnchor }),
            ...(precedingUserTextAnchor === undefined ? {} : { precedingUserTextAnchor }),
            providerRunId: "provider-current",
            role: "assistant" as const,
            sequence,
            sessionKey,
        });
        const activityBeforeId = "external:provider-current:segment:activity-before";
        const activityAfterId = "external:provider-current:segment:activity-after";
        const merged = mergeChatMessages(
            [
                canonicalUser("older-same-text", "provider-current", 1),
                canonicalUser("current-steer", "provider-current", 3),
            ],
            [
                external(activityBeforeId, 2),
                external(activityAfterId, 4, "Continue", "current-steer"),
            ],
            new Set()
        );

        expect(merged.map(({ id }) => id)).toEqual([
            "older-same-text",
            activityBeforeId,
            "current-steer",
            activityAfterId,
        ]);
    });

    test("does not text-fallback when an exact user anchor is outside the history window", () => {
        const external = (
            id: string,
            sequence: number,
            precedingUserMessageIdAnchor?: string
        ) => ({
            attachments: [],
            id,
            parts: [{ kind: "thinking" as const, status: "running" as const, text: id }],
            ...(precedingUserMessageIdAnchor === undefined
                ? {}
                : {
                      precedingUserMessageIdAnchor,
                      precedingUserTextAnchor: "Continue",
                  }),
            providerRunId: "provider-current",
            role: "assistant" as const,
            sequence,
            sessionKey,
        });
        const activityBeforeId = "external:provider-current:segment:activity-before";
        const activityAfterId = "external:provider-current:segment:activity-after";
        const merged = mergeChatMessages(
            [
                {
                    attachments: [],
                    id: "older-same-text",
                    parts: [{ kind: "text" as const, text: "Continue" }],
                    providerRunId: "provider-current",
                    role: "user" as const,
                    sequence: 1,
                    sessionKey,
                },
            ],
            [
                external(activityBeforeId, 2),
                external(activityAfterId, 4, "current-steer-not-loaded"),
            ],
            new Set()
        );

        expect(merged.map(({ id }) => id)).toEqual([
            "older-same-text",
            activityBeforeId,
            activityAfterId,
        ]);
    });

    test("merges richer live activity into an incomplete canonical assistant snapshot", () => {
        const runtime = [
            {
                attachments: [],
                id: "external:provider:segment:thinking",
                parts: [
                    {
                        kind: "thinking" as const,
                        status: "running" as const,
                        text: "Working",
                    },
                ],
                providerRunId: "provider-covered",
                role: "assistant" as const,
                sequence: 1,
                sessionKey,
            },
            {
                attachments: [],
                id: "external:provider:segment:tool",
                parts: [
                    {
                        callId: "call-1",
                        kind: "tool" as const,
                        name: "bash",
                        status: "completed" as const,
                    },
                ],
                providerRunId: "provider-covered",
                role: "assistant" as const,
                sequence: 2,
                sessionKey,
            },
        ];
        const canonicalUser = {
            attachments: [],
            id: "canonical-user",
            parts: [{ kind: "text" as const, text: "Prompt" }],
            providerRunId: "provider-covered",
            role: "user" as const,
            sequence: 1,
            sessionKey,
        };
        expect(
            mergeChatMessages([canonicalUser], runtime, new Set()).map(({ id }) => id)
        ).toContain("external:provider:segment:tool");

        const merged = mergeChatMessages(
            [
                canonicalUser,
                {
                    ...canonicalUser,
                    id: "canonical-assistant",
                    parts: [{ kind: "text" as const, text: "Done" }],
                    role: "assistant" as const,
                    sequence: 2,
                },
            ],
            runtime,
            new Set()
        );
        expect(merged.map(({ id }) => id)).toEqual([
            "canonical-user",
            "canonical-assistant",
        ]);
        expect(merged[1]?.parts).toEqual([
            { kind: "thinking", status: "running", text: "Working" },
            {
                callId: "call-1",
                kind: "tool",
                name: "bash",
                status: "completed",
            },
            { kind: "text", text: "Done" },
        ]);
    });

    test("keeps canonical steer between active-run lanes during history echo", () => {
        const providerRunId = "provider-active-steer";
        const store = createChatRuntimeStore();
        store.installExternalRuns(sessionKey, [
            projectChatExternalRun({
                continuity: "complete",
                lifecycle: "active" as const,
                hasUnprojectedActivity: false,
                observationEpoch: 1,
                observedAtMs: 1_800_000_000_000,
                parts: [
                    {
                        kind: "thinking",
                        segmentId: "thinking-before-steer",
                        sequence: 1,
                        streamId: "agent:reasoning",
                        text: "Reasoning before the steer with live detail",
                    },
                    {
                        callId: "tool-before-steer",
                        input: '{"cmd":"inspect"}',
                        isError: false,
                        kind: "tool",
                        name: "bash",
                        phase: "started",
                        sequence: 2,
                    },
                    {
                        kind: "user",
                        messageId: "canonical-steer",
                        sequence: 3,
                        text: "Adjust the active run",
                    },
                    {
                        kind: "thinking",
                        segmentId: "thinking-after-steer",
                        sequence: 4,
                        streamId: "agent:reasoning",
                        text: "Reasoning after the steer",
                    },
                    {
                        callId: "tool-after-steer",
                        input: '{"cmd":"continue"}',
                        isError: false,
                        kind: "tool",
                        name: "bash",
                        phase: "started",
                        sequence: 5,
                    },
                ],
                projectionTruncated: false,
                providerRunId,
                sessionKey,
                source: "provider-runtime",
                text: "",
                updatedAtMs: 1_800_000_000_000,
            }),
        ]);
        const canonicalUser = {
            attachments: [],
            id: "canonical-steer",
            idempotencyKey: "steer-idempotency-key",
            parts: [{ kind: "text" as const, text: "Adjust the active run" }],
            role: "user" as const,
            sequence: 3,
            sessionKey,
        };
        const canonicalAssistant = {
            attachments: [],
            id: "canonical-active-assistant",
            parts: [
                {
                    kind: "thinking" as const,
                    status: "complete" as const,
                    text: "Reasoning before the steer",
                },
                {
                    callId: "tool-before-steer",
                    kind: "tool" as const,
                    name: "bash",
                    output: "inspected",
                    status: "completed" as const,
                },
                {
                    callId: "tool-after-steer",
                    kind: "tool" as const,
                    name: "bash",
                    output: "continued",
                    status: "completed" as const,
                },
                { kind: "text" as const, text: "Continuing with the adjustment." },
            ],
            providerRunId,
            role: "assistant" as const,
            sequence: 6,
            sessionKey,
        };
        const afterEcho = mergeChatMessages(
            [canonicalUser, canonicalAssistant],
            chatRuntimeMessages(store.state, sessionKey),
            new Set()
        );

        expect(afterEcho.map(({ id }) => id)).toEqual([
            `external:${sessionKey}:${providerRunId}:segment:thinking:thinking-before-steer`,
            `external:${sessionKey}:${providerRunId}:segment:tool:tool-before-steer`,
            canonicalUser.id,
            `external:${sessionKey}:${providerRunId}:segment:thinking:thinking-after-steer`,
            `external:${sessionKey}:${providerRunId}:segment:tool:tool-after-steer`,
            canonicalAssistant.id,
        ]);
        expect(afterEcho[0]?.parts).toEqual([
            {
                kind: "thinking",
                sourceKey: `${providerRunId}:thinking-before-steer`,
                sourceStreamKey: `${providerRunId}:agent:reasoning`,
                status: "complete",
                text: "Reasoning before the steer with live detail",
            },
        ]);
        expect(afterEcho[1]?.parts).toEqual([
            {
                callId: "tool-before-steer",
                input: '{"cmd":"inspect"}',
                kind: "tool",
                name: "bash",
                output: "inspected",
                status: "completed",
            },
        ]);
        expect(afterEcho[3]?.parts).toEqual([
            expect.objectContaining({
                kind: "thinking",
                text: "Reasoning after the steer",
            }),
        ]);
        expect(afterEcho[4]?.parts).toEqual([
            {
                callId: "tool-after-steer",
                input: '{"cmd":"continue"}',
                kind: "tool",
                name: "bash",
                output: "continued",
                status: "completed",
            },
        ]);
        expect(afterEcho[5]?.parts).toEqual([
            { kind: "text", text: "Continuing with the adjustment." },
        ]);
    });

    test("keeps a cumulative canonical thinking suffix after the steer boundary", () => {
        const providerRunId = "provider-cumulative-steer";
        const externalThinking = (
            id: string,
            sequence: number,
            text: string,
            anchored = false
        ) => ({
            attachments: [],
            id: `external:${providerRunId}:segment:thinking:${id}`,
            parts: [{ kind: "thinking" as const, status: "running" as const, text }],
            ...(anchored
                ? {
                      precedingUserMessageIdAnchor: "canonical-cumulative-steer",
                      precedingUserTextAnchor: "Adjust the active run",
                  }
                : {}),
            providerRunId,
            role: "assistant" as const,
            sequence,
            sessionKey,
        });
        const before = externalThinking("before", 1, "Before the steer. ");
        const after = externalThinking("after", 4, "After the steer.", true);
        const steer = {
            attachments: [],
            id: "canonical-cumulative-steer",
            parts: [{ kind: "text" as const, text: "Adjust the active run" }],
            role: "user" as const,
            sequence: 3,
            sessionKey,
        };
        const canonicalAssistant = {
            attachments: [],
            id: "canonical-cumulative-assistant",
            parts: [
                {
                    kind: "thinking" as const,
                    status: "complete" as const,
                    text: "Before the steer. After the steer.",
                },
                { kind: "text" as const, text: "Done." },
            ],
            providerRunId,
            role: "assistant" as const,
            sequence: 5,
            sessionKey,
        };

        const merged = mergeChatMessages(
            [steer, canonicalAssistant],
            [before, after],
            new Set()
        );

        expect(merged.map(({ id }) => id)).toEqual([
            before.id,
            steer.id,
            after.id,
            canonicalAssistant.id,
        ]);
        expect(merged[0]?.parts).toEqual([
            { kind: "thinking", status: "running", text: "Before the steer. " },
        ]);
        expect(merged[2]?.parts).toEqual([
            { kind: "thinking", status: "complete", text: "After the steer." },
        ]);
        expect(merged[3]?.parts).toEqual([{ kind: "text", text: "Done." }]);
    });

    test("does not downgrade a rich live turn across reconnect and history resync", () => {
        const providerRunId = "provider-reconnect";
        const store = createChatRuntimeStore();
        store.installExternalRuns(sessionKey, [
            projectChatExternalRun({
                continuity: "complete",
                lifecycle: "active" as const,
                hasUnprojectedActivity: false,
                observationEpoch: 1,
                observedAtMs: 1_800_000_000_000,
                parts: [
                    {
                        kind: "thinking",
                        segmentId: "reasoning-1",
                        sequence: 1,
                        streamId: "agent:reasoning",
                        text: "Inspecting the configuration.",
                    },
                    {
                        callId: "call-1",
                        input: '{"cmd":"inspect"}',
                        isError: false,
                        kind: "tool",
                        name: "bash",
                        output: "done",
                        phase: "succeeded",
                        sequence: 2,
                    },
                    {
                        kind: "assistant",
                        segmentId: "answer-1",
                        sequence: 3,
                        streamId: "assistant",
                        text: "Finished.",
                    },
                ],
                projectionTruncated: false,
                providerRunId,
                sessionKey,
                source: "provider-runtime",
                text: "Finished.",
                updatedAtMs: 1_800_000_000_000,
            }),
        ]);
        store.installExternalRuns(sessionKey, [
            projectChatExternalRun({
                continuity: "complete",
                lifecycle: "active" as const,
                hasUnprojectedActivity: false,
                observationEpoch: 2,
                observedAtMs: 1_800_000_000_100,
                parts: [
                    {
                        kind: "assistant",
                        segmentId: "answer-1",
                        sequence: 3,
                        streamId: "assistant",
                        text: "Finished.",
                    },
                ],
                projectionTruncated: false,
                providerRunId,
                sessionKey,
                source: "provider-in-flight",
                text: "Finished.",
                updatedAtMs: 1_800_000_000_100,
            }),
        ]);
        store.installExternalRuns(sessionKey, []);
        store.installExternalRuns(sessionKey, []);

        const canonicalUser = {
            attachments: [],
            id: "canonical-reconnect-user",
            parts: [{ kind: "text" as const, text: "Inspect" }],
            providerRunId,
            role: "user" as const,
            sequence: 1,
            sessionKey,
        };
        const canonicalAssistant = {
            attachments: [],
            id: "canonical-reconnect-assistant",
            parts: [{ kind: "text" as const, text: "Finished." }],
            providerRunId,
            role: "assistant" as const,
            sequence: 3,
            sessionKey,
        };
        const merged = mergeChatMessages(
            [canonicalUser, canonicalAssistant],
            chatRuntimeMessages(store.state, sessionKey),
            new Set()
        );

        expect(
            store.state.sessions[sessionKey]?.externalRuns[providerRunId]?.omissionCount
        ).toBe(2);
        expect(merged.map(({ id }) => id)).toEqual([
            canonicalUser.id,
            canonicalAssistant.id,
        ]);
        expect(merged[1]?.parts).toEqual([
            {
                kind: "thinking",
                sourceKey: `${providerRunId}:reasoning-1`,
                sourceStreamKey: `${providerRunId}:agent:reasoning`,
                status: "complete",
                text: "Inspecting the configuration.",
            },
            {
                callId: "call-1",
                input: '{"cmd":"inspect"}',
                kind: "tool",
                name: "bash",
                output: "done",
                status: "completed",
            },
            { kind: "text", text: "Finished." },
        ]);
    });

    test("keeps repeated synthetic same-name tool calls distinct during live-history merge", () => {
        const providerRunId = "provider-repeated-tools";
        const canonical = [
            {
                attachments: [],
                id: "canonical-repeated-tools",
                parts: [
                    {
                        callId: "history-call-1",
                        callIdSource: "synthetic" as const,
                        input: '{"cmd":"pwd"}',
                        kind: "tool" as const,
                        name: "bash",
                        output: "/workspace",
                        status: "completed" as const,
                    },
                    {
                        callId: "history-call-2",
                        callIdSource: "synthetic" as const,
                        input: '{"cmd":"pwd"}',
                        kind: "tool" as const,
                        name: "bash",
                        output: "/workspace",
                        status: "completed" as const,
                    },
                ],
                providerRunId,
                role: "assistant" as const,
                sequence: 3,
                sessionKey,
            },
        ];
        const runtime = [1, 2].map((sequence) => ({
            attachments: [],
            id: `external:${providerRunId}:segment:tool-${sequence}`,
            parts: [
                {
                    callId: `runtime-call-${sequence}`,
                    callIdSource: "synthetic" as const,
                    input: '{"cmd":"pwd"}',
                    kind: "tool" as const,
                    name: "bash",
                    output: "/workspace",
                    status: "completed" as const,
                },
            ],
            providerRunId,
            role: "assistant" as const,
            sequence,
            sessionKey,
        }));

        const merged = mergeChatMessages(canonical, runtime, new Set());
        const tools = merged[0]?.parts.filter((part) => part.kind === "tool");
        expect(tools).toHaveLength(2);
        expect(tools?.map((part) => (part.kind === "tool" ? part.callId : ""))).toEqual([
            "history-call-1",
            "history-call-2",
        ]);
    });
});
