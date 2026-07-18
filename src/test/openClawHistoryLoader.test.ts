import { describe, expect, it } from "bun:test";

import { OpenClawChatAdapter } from "../components/features/chat/transport/openClawChatAdapter";
import { OpenClawHistoryLoader } from "../components/features/chat/transport/openClawHistoryLoader";

const SESSION = "agent:main:main";

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
        const loader = new OpenClawHistoryLoader(
            new OpenClawChatAdapter(),
            async (request) => {
                requests.push(request);
                return pages.get(request.offset);
            }
        );

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
        const loader = new OpenClawHistoryLoader(
            new OpenClawChatAdapter(),
            async (request) => {
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
            }
        );

        const initial = await loader.history(SESSION, 1);
        output = "current output";
        const refreshed = await loader.history(SESSION, 1);

        expect(requests).toEqual([0, 1, 0]);
        expect(initial[0]?.toolCalls?.[0]?.toolResult?.content).toBe("stale output");
        expect(refreshed[0]?.toolCalls?.[0]?.toolResult?.content).toBe("current output");
    });

    it("appends newly persisted messages without reloading older cached pages", async () => {
        let totalMessages = 4;
        const requests: number[] = [];
        const loader = new OpenClawHistoryLoader(
            new OpenClawChatAdapter(),
            async (request) => {
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
            }
        );

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
        const loader = new OpenClawHistoryLoader(
            new OpenClawChatAdapter(),
            async (request) => {
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
            }
        );

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
        const loader = new OpenClawHistoryLoader(
            new OpenClawChatAdapter(),
            async (request) => {
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
            }
        );

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
        const loader = new OpenClawHistoryLoader(
            new OpenClawChatAdapter(),
            async (request) => {
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
            }
        );

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
