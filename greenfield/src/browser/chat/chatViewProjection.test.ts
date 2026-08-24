import { describe, expect, test } from "bun:test";

import {
    deriveGatewaySessionStats,
    type GatewaySession,
    type ListGatewaySessionsResult,
} from "../../contracts/gatewaySessions.ts";
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
});
