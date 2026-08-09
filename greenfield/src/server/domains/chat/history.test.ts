/* oxlint-disable typescript/require-await -- Async test doubles mirror production promise ports. */
import { describe, expect, test } from "bun:test";

import type { ChatMessage } from "../../../contracts/chatModel.ts";
import { ChatHistoryService } from "./history.ts";
import type { ChatProvider, ChatProviderHistoryPage } from "./provider.ts";

const sessionKey = "agent:main:main";
const localRunId = "019fe5a1-6cb9-7e51-ad2a-bf1f69861218";

function message(id: string, text = id, runId?: string): ChatMessage {
    return {
        content: { kind: "complete", parts: [{ id: "1", kind: "text", text }] },
        id,
        role: "assistant",
        ...(runId === undefined ? {} : { runId }),
        source: "gateway-history",
    };
}

function fakeProvider(
    pages: readonly ChatProviderHistoryPage[],
    hydrated: ChatMessage = message("hydrated")
): ChatProvider {
    let pageIndex = 0;
    return {
        getMessage: async () => ({ message: hydrated, status: "available" }),
        history: async () => {
            const page = pages[pageIndex];
            pageIndex += 1;
            if (page === undefined) throw new Error("Unexpected history page");
            return page;
        },
    } as unknown as ChatProvider;
}

async function failureOf(operation: () => Promise<unknown>): Promise<unknown> {
    try {
        await operation();
        return new Error("Expected rejection");
    } catch (error) {
        return error;
    }
}

describe("chat history service", () => {
    test("prepends older second pages and uses the provider nextOffset verbatim", async () => {
        const service = new ChatHistoryService(
            fakeProvider([
                {
                    hasMore: true,
                    messages: [message("m4")],
                    nextOffset: 17,
                },
                {
                    hasMore: true,
                    messages: [message("m1"), message("m2"), message("m3")],
                    nextOffset: 41,
                },
            ])
        );

        const output = await service.history({
            cursor: "0",
            limit: 4,
            sessionKey,
        });

        expect(output.messages.map(({ id }) => id)).toEqual(["m1", "m2", "m3", "m4"]);
        expect(output.nextCursor).toBe("41");
        expect(output.providerPagesRead).toBe(2);
        expect(output.truncated).toBeTrue();
    });

    test("deduplicates overlapping pages while retaining the newest occurrence", async () => {
        const service = new ChatHistoryService(
            fakeProvider([
                {
                    hasMore: true,
                    messages: [message("m4"), message("overlap", "new")],
                    nextOffset: 9,
                },
                {
                    hasMore: false,
                    messages: [message("m2"), message("overlap", "old")],
                },
            ])
        );

        const output = await service.history({
            cursor: "0",
            limit: 4,
            sessionKey,
        });

        expect(output.messages.map(({ id }) => id)).toEqual(["m2", "m4", "overlap"]);
        expect(output.messages.at(-1)?.content).toEqual({
            kind: "complete",
            parts: [{ id: "1", kind: "text", text: "new" }],
        });
        expect(output.nextCursor).toBeUndefined();
        expect(output.truncated).toBeFalse();
    });

    test("keeps the newest complete row and placeholders older oversized rows", async () => {
        const large = "x".repeat(256 * 1024);
        const service = new ChatHistoryService(
            fakeProvider([
                {
                    hasMore: false,
                    messages: [message("older", large), message("newest", large)],
                },
            ])
        );

        const output = await service.history({
            cursor: "0",
            limit: 2,
            sessionKey,
        });

        expect(output.messages.map(({ id }) => id)).toEqual(["older", "newest"]);
        expect(output.messages[0]?.content.kind).toBe("hydration-required");
        expect(output.messages[1]?.content.kind).toBe("complete");
        expect(output.nextCursor).toBeUndefined();
        expect(output.truncated).toBeTrue();
    });

    test("observes only the newest-page in-flight snapshot and promotes aliases", async () => {
        const observations: unknown[] = [];
        const service = new ChatHistoryService(
            fakeProvider([
                {
                    hasMore: true,
                    inFlightRun: { runId: "provider-1", text: "working" },
                    messages: [message("m2", "two", "provider-1")],
                    nextOffset: 8,
                },
                { hasMore: false, messages: [message("m1")] },
            ]),
            {
                resolveLocalRunId: ({ providerRunId }) =>
                    providerRunId === "provider-1" ? localRunId : undefined,
            },
            {
                observeHistoryMessages: () => {},
                observeInFlightRun: (observedSessionKey, inFlightRun) => {
                    observations.push({ inFlightRun, sessionKey: observedSessionKey });
                },
            }
        );

        const output = await service.history({
            cursor: "0",
            limit: 2,
            sessionKey,
        });

        expect(output.messages.find(({ id }) => id === "m2")?.localRunId).toBe(
            localRunId
        );
        expect(observations).toEqual([
            {
                inFlightRun: { runId: "provider-1", text: "working" },
                sessionKey,
            },
        ]);
    });

    test("promotes the same local alias during exact-message hydration", async () => {
        const service = new ChatHistoryService(
            fakeProvider([], message("m1", "done", "provider-1")),
            { resolveLocalRunId: () => localRunId }
        );

        const output = await service.getMessage({ messageId: "m1", sessionKey });
        expect(output.status).toBe("available");
        if (output.status === "available") {
            expect(output.message.localRunId).toBe(localRunId);
        }
    });

    test("rejects nonadvancing provider cursors", async () => {
        const service = new ChatHistoryService(
            fakeProvider([{ hasMore: true, messages: [message("m1")], nextOffset: 0 }])
        );

        expect(
            await failureOf(() => service.history({ cursor: "0", limit: 2, sessionKey }))
        ).toBeInstanceOf(Error);
    });
});
