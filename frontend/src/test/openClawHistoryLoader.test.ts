import { describe, expect, it } from "bun:test";

import { OpenClawChatAdapter } from "../components/features/chat/transport/openClawChatAdapter";
import {
    OpenClawHistoryLoader as CanonicalOpenClawHistoryLoader,
    type OpenClawHistoryMessageRequest,
    type OpenClawHistoryPageRequest,
} from "../components/features/chat/transport/openClawHistoryLoader";
import {
    canonicalHistoryMessageResult,
    canonicalHistoryPage,
} from "./support/canonicalChatHistory";

const SESSION = "agent:main:main";

class OpenClawHistoryLoader extends CanonicalOpenClawHistoryLoader {
    constructor(
        adapter: OpenClawChatAdapter,
        requestPage: (request: OpenClawHistoryPageRequest) => unknown,
        requestFullMessage?: (request: OpenClawHistoryMessageRequest) => unknown
    ) {
        super(
            adapter,
            async (request) => canonicalHistoryPage(await requestPage(request), request),
            requestFullMessage
                ? async (request) =>
                      canonicalHistoryMessageResult(
                          await requestFullMessage(request),
                          request
                      )
                : undefined
        );
    }
}

function rawMessage(
    sequence: number,
    role: string,
    content: unknown,
    details: Record<string, unknown> = {}
) {
    return {
        __openclaw: {
            id: `message-${sequence}`,
            seq: sequence,
        },
        content,
        role,
        timestamp: `2026-07-18T16:35:${String(sequence).padStart(2, "0")}.000Z`,
        ...details,
    };
}

function rawMessageWithoutSequence(id: string, role: string, content: unknown) {
    return {
        __openclaw: { id },
        content,
        role,
        timestamp: "2026-07-18T16:36:00.000Z",
    };
}

describe("OpenClaw history loader", () => {
    it("hydrates lightweight assistant previews once before exposing history", async () => {
        const preview = `${"preview ".repeat(1000)}\n...(truncated)...`;
        const fullText = `${"complete ".repeat(1500)}finished`;
        const fullRequests: OpenClawHistoryMessageRequest[] = [];
        const loader = new OpenClawHistoryLoader(
            new OpenClawChatAdapter(),
            () => ({
                hasMore: false,
                messages: [rawMessage(1, "assistant", [{ text: preview, type: "text" }])],
                offset: 0,
                sessionId: "session-1",
                totalMessages: 1,
            }),
            (request) => {
                fullRequests.push(request);
                return {
                    message: rawMessage(1, "assistant", [
                        { text: fullText, type: "text" },
                    ]),
                    ok: true,
                };
            }
        );

        const first = await loader.history(SESSION, 100);
        const cached = await loader.history(SESSION, 100);

        expect(first[0]?.text).toBe(fullText);
        expect(cached).toBe(first);
        expect(fullRequests).toEqual([
            {
                maxChars: 2_000_000,
                messageId: "message-1",
                sessionKey: SESSION,
            },
        ]);
    });

    it("keeps the bounded preview when the full message is unavailable", async () => {
        const preview = "partial answer\n...(truncated)...";
        const loader = new OpenClawHistoryLoader(
            new OpenClawChatAdapter(),
            () => ({
                hasMore: false,
                messages: [rawMessage(1, "assistant", preview)],
                offset: 0,
                sessionId: "session-1",
                totalMessages: 1,
            }),
            () => ({ ok: false, unavailableReason: "oversized" })
        );

        const messages = await loader.history(SESSION, 100);
        expect(messages[0]?.text).toBe(preview);
    });

    it("loads every offset page and folds tools split across a page boundary", async () => {
        const requests: Array<{ limit: number; offset: number; sessionKey: string }> = [];
        const pages = new Map<number, unknown>([
            [
                0,
                {
                    hasMore: true,
                    messages: [
                        rawMessage(3, "tool", "completed", {
                            toolCallId: "call-1",
                            toolName: "bash",
                        }),
                        rawMessage(4, "assistant", [{ text: "answer", type: "text" }]),
                    ],
                    nextOffset: 2,
                    offset: 0,
                    sessionId: "session-1",
                    totalMessages: 4,
                },
            ],
            [
                2,
                {
                    hasMore: false,
                    messages: [
                        rawMessage(1, "user", [{ text: "question", type: "text" }]),
                        rawMessage(2, "assistant", [
                            {
                                arguments: { command: "gh api graphql" },
                                id: "call-1",
                                name: "bash",
                                type: "toolCall",
                            },
                        ]),
                    ],
                    offset: 2,
                    sessionId: "session-1",
                    totalMessages: 4,
                },
            ],
        ]);
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), (request) => {
            return Promise.try(() => {
                requests.push(request);
                return pages.get(request.offset);
            });
        });

        const first = await loader.history(SESSION, 2);

        expect(requests.map((request) => request.offset)).toEqual([0, 2]);
        expect(first.map((message) => message.text)).toEqual(["question", "", "answer"]);
        expect(first[1]?.toolCalls?.[0]?.toolResult?.content).toBe("completed");

        const cached = await loader.history(SESSION, 2);

        expect(requests.map((request) => request.offset)).toEqual([0, 2, 0]);
        expect(cached).toBe(first);
    });

    it("deduplicates concurrent loads for the same session and page size", async () => {
        let requestCount = 0;
        const { promise: page, resolve: resolvePage } = Promise.withResolvers<unknown>();
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), async () => {
            requestCount += 1;
            return page;
        });

        const firstRequest = loader.history(SESSION, 1000);
        const secondRequest = loader.history(SESSION, 1000);
        expect(requestCount).toBe(1);
        resolvePage({
            hasMore: false,
            messages: [rawMessage(1, "assistant", "answer")],
            offset: 0,
            sessionId: "session-1",
            totalMessages: 1,
        });

        const first = await firstRequest;
        const second = await secondRequest;
        expect(second).toBe(first);
    });

    it("revalidates rewritten first-page rows without reloading older pages", async () => {
        let output = "stale output";
        const requests: number[] = [];
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), (request) => {
            return Promise.try(() => {
                requests.push(request.offset);
                return request.offset === 0
                    ? {
                          hasMore: true,
                          messages: [
                              rawMessage(2, "tool", output, {
                                  toolCallId: "call-1",
                                  toolName: "bash",
                              }),
                          ],
                          nextOffset: 1,
                          offset: 0,
                          sessionId: "session-1",
                          totalMessages: 2,
                      }
                    : {
                          hasMore: false,
                          messages: [
                              rawMessage(1, "assistant", [
                                  {
                                      id: "call-1",
                                      name: "bash",
                                      type: "toolCall",
                                  },
                              ]),
                          ],
                          offset: 1,
                          sessionId: "session-1",
                          totalMessages: 2,
                      };
            });
        });

        const initial = await loader.history(SESSION, 1);
        output = "current output";
        const refreshed = await loader.history(SESSION, 1);

        expect(requests).toEqual([0, 1, 0]);
        expect(initial[0]?.toolCalls?.[0]?.toolResult?.content).toBe("stale output");
        expect(refreshed[0]?.toolCalls?.[0]?.toolResult?.content).toBe("current output");
    });

    it("caches same-sequence sibling rows without collapsing rewritten rows", async () => {
        let output = "stale output";
        const requests: number[] = [];
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), (request) => {
            return Promise.try(() => {
                requests.push(request.offset);
                return {
                    hasMore: false,
                    messages: [
                        rawMessage(
                            1,
                            "assistant",
                            [
                                {
                                    id: "call-1",
                                    name: "bash",
                                    type: "toolCall",
                                },
                            ],
                            {
                                __openclaw: {
                                    id: "tool-call-message",
                                    seq: 1,
                                },
                            }
                        ),
                        rawMessage(1, "tool", output, {
                            __openclaw: {
                                id: "tool-result-message",
                                seq: 1,
                            },
                            toolCallId: "call-1",
                            toolName: "bash",
                        }),
                    ],
                    offset: 0,
                    sessionId: "session-1",
                    totalMessages: 2,
                };
            });
        });

        const initial = await loader.history(SESSION, 2);
        const cached = await loader.history(SESSION, 2);
        output = "current output";
        const refreshed = await loader.history(SESSION, 2);

        expect(requests).toEqual([0, 0, 0]);
        expect(cached).toBe(initial);
        expect(initial[0]?.toolCalls?.[0]?.toolResult?.content).toBe("stale output");
        expect(refreshed).toHaveLength(1);
        expect(refreshed[0]?.toolCalls?.[0]?.toolResult?.content).toBe("current output");
    });

    it("loads a cached same-sequence sibling beyond the refresh boundary", async () => {
        let includeResult = false;
        const requests: number[] = [];
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), (request) => {
            requests.push(request.offset);
            const call = rawMessage(
                1,
                "assistant",
                [{ id: "call-1", name: "bash", type: "toolCall" }],
                {
                    __openclaw: {
                        id: "tool-call-message",
                        seq: 1,
                    },
                }
            );
            if (!includeResult) {
                return {
                    hasMore: false,
                    messages: [call],
                    offset: 0,
                    sessionId: "session-1",
                    totalMessages: 1,
                };
            }
            return request.offset === 0
                ? {
                      hasMore: true,
                      messages: [
                          rawMessage(1, "tool", "current output", {
                              __openclaw: {
                                  id: "tool-result-message",
                                  seq: 1,
                              },
                              toolCallId: "call-1",
                              toolName: "bash",
                          }),
                      ],
                      nextOffset: 1,
                      offset: 0,
                      sessionId: "session-1",
                      totalMessages: 2,
                  }
                : {
                      hasMore: false,
                      messages: [call],
                      offset: 1,
                      sessionId: "session-1",
                      totalMessages: 2,
                  };
        });

        const initial = await loader.history(SESSION, 1);
        includeResult = true;
        const refreshed = await loader.history(SESSION, 1);

        expect(requests).toEqual([0, 0, 1]);
        expect(initial[0]?.toolCalls?.[0]?.toolResult).toBeUndefined();
        expect(refreshed).toHaveLength(1);
        expect(refreshed[0]?.toolCalls?.[0]?.toolResult?.content).toBe("current output");
    });

    it("replaces a rewritten seq-only row instead of retaining stale content", async () => {
        let content = "stale answer";
        const requests: number[] = [];
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), (request) => {
            requests.push(request.offset);
            return {
                hasMore: false,
                messages: [
                    rawMessage(1, "assistant", content, {
                        __openclaw: { seq: 1 },
                    }),
                ],
                offset: 0,
                sessionId: "session-1",
                totalMessages: 1,
            };
        });

        const initial = await loader.history(SESSION, 10);
        content = "current answer";
        const refreshed = await loader.history(SESSION, 10);

        expect(requests).toEqual([0, 0]);
        expect(initial.map((message) => message.text)).toEqual(["stale answer"]);
        expect(refreshed.map((message) => message.text)).toEqual(["current answer"]);
    });

    it("updates provider rows beside a rewritten seq-only sibling", async () => {
        let fingerprintContent = "stale fingerprint";
        let providerContent = "stale provider";
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), () => {
            return {
                hasMore: false,
                messages: [
                    rawMessage(1, "assistant", fingerprintContent, {
                        __openclaw: { seq: 1 },
                    }),
                    rawMessage(1, "assistant", providerContent, {
                        __openclaw: { id: "provider-message", seq: 1 },
                    }),
                ],
                offset: 0,
                sessionId: "session-1",
                totalMessages: 2,
            };
        });

        const initial = await loader.history(SESSION, 10);
        fingerprintContent = "current fingerprint";
        providerContent = "current provider";
        const refreshed = await loader.history(SESSION, 10);

        expect(initial.map((message) => message.text)).toEqual([
            "stale fingerprint",
            "stale provider",
        ]);
        expect(refreshed.map((message) => message.text).toSorted()).toEqual([
            "current fingerprint",
            "current provider",
        ]);
    });

    it("preserves fresh same-sequence order when a fingerprint row is rewritten", async () => {
        let command = "echo stale";
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), () => {
            return {
                hasMore: false,
                messages: [
                    rawMessage(
                        1,
                        "assistant",
                        [
                            {
                                arguments: { command },
                                id: "call-1",
                                name: "bash",
                                type: "toolCall",
                            },
                        ],
                        { __openclaw: { seq: 1 } }
                    ),
                    rawMessage(1, "tool", "completed", {
                        __openclaw: {
                            id: "provider-result",
                            seq: 1,
                        },
                        toolCallId: "call-1",
                        toolName: "bash",
                    }),
                ],
                offset: 0,
                sessionId: "session-1",
                totalMessages: 2,
            };
        });

        const initial = await loader.history(SESSION, 10);
        command = "echo current";
        const refreshed = await loader.history(SESSION, 10);

        expect(initial).toHaveLength(1);
        expect(refreshed).toHaveLength(1);
        expect(refreshed[0]?.toolCalls?.[0]?.arguments).toEqual({
            command: "echo current",
        });
        expect(refreshed[0]?.toolCalls?.[0]?.toolResult?.content).toBe("completed");
    });

    it("preserves seq-only siblings while replacing a rewritten member", async () => {
        let output = "stale output";
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), () => {
            return {
                hasMore: false,
                messages: [
                    rawMessage(
                        1,
                        "assistant",
                        [{ id: "call-1", name: "bash", type: "toolCall" }],
                        { __openclaw: { seq: 1 } }
                    ),
                    rawMessage(1, "tool", output, {
                        __openclaw: { seq: 1 },
                        toolCallId: "call-1",
                        toolName: "bash",
                    }),
                ],
                offset: 0,
                sessionId: "session-1",
                totalMessages: 2,
            };
        });

        const initial = await loader.history(SESSION, 10);
        output = "current output";
        const refreshed = await loader.history(SESSION, 10);

        expect(initial).toHaveLength(1);
        expect(initial[0]?.toolCalls?.[0]?.toolResult?.content).toBe("stale output");
        expect(refreshed).toHaveLength(1);
        expect(refreshed[0]?.toolCalls?.[0]?.toolResult?.content).toBe("current output");
    });

    it("evicts seq-only siblings missing from a refreshed sequence", async () => {
        let includeSecond = true;
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), () => {
            return {
                hasMore: false,
                messages: [
                    rawMessage(1, "assistant", "first", {
                        __openclaw: { seq: 1 },
                    }),
                    ...(includeSecond
                        ? [
                              rawMessage(1, "assistant", "second", {
                                  __openclaw: { seq: 1 },
                              }),
                          ]
                        : []),
                ],
                offset: 0,
                sessionId: "session-1",
                totalMessages: 2,
            };
        });

        const initial = await loader.history(SESSION, 10);
        includeSecond = false;
        const refreshed = await loader.history(SESSION, 10);

        expect(initial.map((message) => message.text)).toEqual(["first", "second"]);
        expect(refreshed.map((message) => message.text)).toEqual(["first"]);
    });

    it("evicts a seq-only row when the refreshed row gains provider identity", async () => {
        let hasProviderIdentity = false;
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), () => {
            return {
                hasMore: false,
                messages: [
                    rawMessage(
                        1,
                        "assistant",
                        hasProviderIdentity ? "current answer" : "stale answer",
                        {
                            __openclaw: {
                                ...(hasProviderIdentity ? { id: "provider-answer" } : {}),
                                seq: 1,
                            },
                        }
                    ),
                ],
                offset: 0,
                sessionId: "session-1",
                totalMessages: 1,
            };
        });

        const initial = await loader.history(SESSION, 10);
        hasProviderIdentity = true;
        const refreshed = await loader.history(SESSION, 10);

        expect(initial.map((message) => message.text)).toEqual(["stale answer"]);
        expect(refreshed.map((message) => message.text)).toEqual(["current answer"]);
    });

    it("evicts a provider row replaced by a new provider identity", async () => {
        let providerId = "stale-provider-answer";
        let content = "stale answer";
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), () => {
            return {
                hasMore: false,
                messages: [
                    rawMessage(1, "assistant", content, {
                        __openclaw: { id: providerId, seq: 1 },
                    }),
                ],
                offset: 0,
                sessionId: "session-1",
                totalMessages: 1,
            };
        });

        const initial = await loader.history(SESSION, 10);
        providerId = "current-provider-answer";
        content = "current answer";
        const refreshed = await loader.history(SESSION, 10);

        expect(initial.map((message) => message.text)).toEqual(["stale answer"]);
        expect(refreshed.map((message) => message.text)).toEqual(["current answer"]);
    });

    it("preserves fresh order when a provider row is added to a cached sequence", async () => {
        let includeCall = false;
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), () => {
            return {
                hasMore: false,
                messages: [
                    ...(includeCall
                        ? [
                              rawMessage(
                                  1,
                                  "assistant",
                                  [{ id: "call-1", name: "bash", type: "toolCall" }],
                                  {
                                      __openclaw: {
                                          id: "tool-call-message",
                                          seq: 1,
                                      },
                                  }
                              ),
                          ]
                        : []),
                    rawMessage(1, "tool", "current output", {
                        __openclaw: {
                            id: "tool-result-message",
                            seq: 1,
                        },
                        toolCallId: "call-1",
                        toolName: "bash",
                    }),
                ],
                offset: 0,
                sessionId: "session-1",
                totalMessages: includeCall ? 2 : 1,
            };
        });

        const initial = await loader.history(SESSION, 10);
        includeCall = true;
        const refreshed = await loader.history(SESSION, 10);

        expect(initial[0]?.toolResult?.content).toBe("current output");
        expect(refreshed).toHaveLength(1);
        expect(refreshed[0]?.toolCalls?.[0]?.toolResult?.content).toBe("current output");
    });

    it("rebuilds cached history when a new row shares a cached sequence", async () => {
        let includeResult = false;
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), () => {
            return Promise.resolve({
                hasMore: false,
                messages: [
                    rawMessage(
                        1,
                        "assistant",
                        [
                            {
                                id: "call-1",
                                name: "bash",
                                type: "toolCall",
                            },
                        ],
                        {
                            __openclaw: {
                                id: "tool-call-message",
                                seq: 1,
                            },
                        }
                    ),
                    ...(includeResult
                        ? [
                              rawMessage(1, "tool", "current output", {
                                  __openclaw: {
                                      id: "tool-result-message",
                                      seq: 1,
                                  },
                                  toolCallId: "call-1",
                                  toolName: "bash",
                              }),
                          ]
                        : []),
                ],
                offset: 0,
                sessionId: "session-1",
                totalMessages: includeResult ? 2 : 1,
            });
        });

        const initial = await loader.history(SESSION, 2);
        includeResult = true;
        const refreshed = await loader.history(SESSION, 2);

        expect(initial[0]?.toolCalls?.[0]?.toolResult).toBeUndefined();
        expect(refreshed).toHaveLength(1);
        expect(refreshed[0]?.toolCalls?.[0]?.toolResult?.content).toBe("current output");
    });

    it("appends newly persisted messages without reloading older cached pages", async () => {
        let totalMessages = 4;
        const requests: number[] = [];
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), (request) => {
            return Promise.try(() => {
                requests.push(request.offset);
                if (totalMessages === 4 && request.offset === 0) {
                    return {
                        hasMore: true,
                        messages: [
                            rawMessage(3, "assistant", "three"),
                            rawMessage(4, "assistant", "four"),
                        ],
                        nextOffset: 2,
                        offset: 0,
                        sessionId: "session-1",
                        totalMessages,
                    };
                }
                if (totalMessages === 4 && request.offset === 2) {
                    return {
                        hasMore: false,
                        messages: [
                            rawMessage(1, "assistant", "one"),
                            rawMessage(2, "assistant", "two"),
                        ],
                        offset: 2,
                        sessionId: "session-1",
                        totalMessages,
                    };
                }
                return {
                    hasMore: true,
                    messages: [
                        rawMessage(3, "assistant", "three"),
                        rawMessage(4, "assistant", "four"),
                        rawMessage(5, "assistant", "five"),
                        rawMessage(6, "assistant", "six"),
                    ],
                    nextOffset: 4,
                    offset: 0,
                    sessionId: "session-1",
                    totalMessages,
                };
            });
        });

        const initial = await loader.history(SESSION, 2);
        totalMessages = 6;
        const updated = await loader.history(SESSION, 2);

        expect(requests).toEqual([0, 2, 0]);
        expect(initial.map((message) => message.text)).toEqual([
            "one",
            "two",
            "three",
            "four",
        ]);
        expect(updated.map((message) => message.text)).toEqual([
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
        ]);
    });

    it("walks backward until a large append overlaps the cached transcript", async () => {
        let isInitialLoad = true;
        const requests: number[] = [];
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), (request) => {
            return Promise.try(() => {
                requests.push(request.offset);
                if (isInitialLoad) {
                    return {
                        hasMore: false,
                        messages: [
                            rawMessage(1, "assistant", "one"),
                            rawMessage(2, "assistant", "two"),
                        ],
                        offset: 0,
                        sessionId: "session-1",
                        totalMessages: 2,
                    };
                }
                const page = {
                    0: {
                        messages: [
                            rawMessage(9, "assistant", "nine"),
                            rawMessage(10, "assistant", "ten"),
                        ],
                        nextOffset: 2,
                    },
                    2: {
                        messages: [
                            rawMessage(5, "assistant", "five"),
                            rawMessage(6, "assistant", "six"),
                            rawMessage(7, "assistant", "seven"),
                            rawMessage(8, "assistant", "eight"),
                        ],
                        nextOffset: 6,
                    },
                    6: {
                        messages: [
                            rawMessage(3, "assistant", "three"),
                            rawMessage(4, "assistant", "four"),
                        ],
                        nextOffset: 8,
                    },
                }[request.offset];
                return {
                    hasMore: true,
                    offset: request.offset,
                    sessionId: "session-1",
                    totalMessages: 10,
                    ...page,
                };
            });
        });

        await loader.history(SESSION, 2);
        isInitialLoad = false;
        const updated = await loader.history(SESSION, 2);

        expect(requests).toEqual([0, 0, 2, 6]);
        expect(updated.map((message) => message.text)).toEqual([
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
            "seven",
            "eight",
            "nine",
            "ten",
        ]);
    });

    it("does not reuse or advance the cache when sequence metadata is incomplete", async () => {
        let hasIncompleteAppend = false;
        const requests: number[] = [];
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), (request) => {
            return Promise.try(() => {
                requests.push(request.offset);
                if (!hasIncompleteAppend) {
                    return {
                        hasMore: false,
                        messages: [
                            rawMessage(1, "assistant", "one"),
                            rawMessage(2, "assistant", "two"),
                        ],
                        offset: 0,
                        sessionId: "session-1",
                        totalMessages: 2,
                    };
                }
                return request.offset === 0
                    ? {
                          hasMore: true,
                          messages: [
                              rawMessage(2, "assistant", "two"),
                              rawMessageWithoutSequence(
                                  "message-3",
                                  "assistant",
                                  "three"
                              ),
                          ],
                          nextOffset: 2,
                          offset: 0,
                          sessionId: "session-1",
                          totalMessages: 3,
                      }
                    : {
                          hasMore: false,
                          messages: [rawMessage(1, "assistant", "one")],
                          offset: 2,
                          sessionId: "session-1",
                          totalMessages: 3,
                      };
            });
        });

        await loader.history(SESSION, 2);
        hasIncompleteAppend = true;
        const firstUncached = await loader.history(SESSION, 2);
        const secondUncached = await loader.history(SESSION, 2);

        expect(requests).toEqual([0, 0, 2, 0, 2]);
        expect(firstUncached.map((message) => message.text)).toEqual([
            "one",
            "two",
            "three",
        ]);
        expect(secondUncached.map((message) => message.text)).toEqual([
            "one",
            "two",
            "three",
        ]);
        expect(secondUncached).not.toBe(firstUncached);
    });

    it("bounds complete transcript caches while preserving recent sessions", async () => {
        const requests: string[] = [];
        const loader = new OpenClawHistoryLoader(new OpenClawChatAdapter(), (request) => {
            return Promise.try(() => {
                requests.push(`${request.sessionKey}:${request.offset}`);
                return request.offset === 0
                    ? {
                          hasMore: true,
                          messages: [rawMessage(2, "assistant", "two")],
                          nextOffset: 1,
                          offset: 0,
                          sessionId: request.sessionKey,
                          totalMessages: 2,
                      }
                    : {
                          hasMore: false,
                          messages: [rawMessage(1, "assistant", "one")],
                          offset: 1,
                          sessionId: request.sessionKey,
                          totalMessages: 2,
                      };
            });
        });

        await loader.history("agent:main:first", 1);
        await loader.history("agent:main:second", 1);
        await loader.history("agent:main:third", 1);
        await loader.history("agent:main:first", 1);

        expect(
            requests.filter((request) => request.startsWith("agent:main:first:"))
        ).toEqual([
            "agent:main:first:0",
            "agent:main:first:1",
            "agent:main:first:0",
            "agent:main:first:1",
        ]);
    });
});
