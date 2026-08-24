import { describe, expect, jest, test } from "bun:test";

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { chatHistoryQueryKey, chatRuntimeQueryKey } from "./chatQueries.ts";
import {
    chatRuntimeMessages,
    createChatRuntimeStore,
    type ChatRuntimeStore,
} from "./chatRuntimeStore.ts";
import { useChatRuntimeProjection } from "./useChatRuntimeProjection.ts";

const { act, render, waitFor } = await import("@testing-library/react");
const runId = "019fe633-9133-7ba0-8b80-809dd80dfb39";

function Harness({
    client,
    sessionKey,
    store,
}: Readonly<{
    client: DashboardTrpcClient;
    sessionKey: string;
    store: ChatRuntimeStore;
}>) {
    useChatRuntimeProjection(client, sessionKey, store);
    return null;
}

function HistoryProbe({
    onRead,
    sessionKey,
}: Readonly<{ onRead: () => void; sessionKey: string }>) {
    useQuery({
        queryFn: () => {
            onRead();
            return Promise.resolve({ messages: [], sessionKey, truncated: false });
        },
        queryKey: chatHistoryQueryKey(sessionKey),
        staleTime: Number.POSITIVE_INFINITY,
    });
    return null;
}

function page(sessionKey: string, cursor: string, sequence: number, hasMore: boolean) {
    return {
        cursor,
        events: [
            {
                cursor,
                event: {
                    historyMessageId: `message-${sequence}`,
                    kind: "reconciled" as const,
                    occurredAtMs: 1_800_000_000_000 + sequence,
                    runId,
                    sequence,
                },
            },
        ],
        externalRuns: [],
        externalRunsTruncated: false,
        hasMore,
        resetRequired: false,
        runs: [],
        sessionKey,
        transcriptGeneration: 1,
    };
}

describe("chat runtime projection", () => {
    test("settles an identical catch-up read without repeatedly invalidating static truncation", async () => {
        const sessionKey = "agent:main:main";
        const store = createChatRuntimeStore();
        const truncatedPage = {
            cursor: "0",
            events: [],
            externalRuns: [],
            externalRunsTruncated: true,
            hasMore: false,
            resetRequired: false,
            runs: [],
            sessionKey,
            transcriptGeneration: 1,
        } as const;
        const query = jest.fn(() => Promise.resolve(truncatedPage));
        const historyRead = jest.fn();
        const client = { query } as unknown as DashboardTrpcClient;
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const rendered = render(
            <QueryClientProvider client={queryClient}>
                <HistoryProbe onRead={historyRead} sessionKey={sessionKey} />
                <Harness client={client} sessionKey={sessionKey} store={store} />
            </QueryClientProvider>
        );
        try {
            await waitFor(() => expect(historyRead).toHaveBeenCalledTimes(2));
            expect(store.state.connection).toBe("connected");
            store.setConnection("reconnecting");
            await new Promise((resolve) => setTimeout(resolve, 2));

            await act(async () => {
                await queryClient.invalidateQueries({
                    exact: true,
                    queryKey: chatRuntimeQueryKey(sessionKey),
                });
            });

            await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
            expect(store.state.connection).toBe("connected");
            expect(historyRead).toHaveBeenCalledTimes(2);
        } finally {
            rendered.unmount();
            queryClient.clear();
        }
    });

    test("serially drains clear bounded pages from each newly advanced cursor", async () => {
        const store = createChatRuntimeStore();
        const cursors: string[] = [];
        const generations: number[] = [];
        let invocation = 0;
        const query = jest.fn(
            (
                _: string,
                input: Readonly<{
                    afterCursor: string;
                    afterTranscriptGeneration: number;
                }>
            ) => {
                cursors.push(input.afterCursor);
                generations.push(input.afterTranscriptGeneration);
                invocation += 1;
                return Promise.resolve(
                    invocation === 1
                        ? page("agent:main:main", "1", 1, true)
                        : page("agent:main:main", "2", 2, false)
                );
            }
        );
        const client = { query } as unknown as DashboardTrpcClient;
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const rendered = render(
            <QueryClientProvider client={queryClient}>
                <Harness client={client} sessionKey="agent:main:main" store={store} />
            </QueryClientProvider>
        );
        try {
            await waitFor(() => expect(store.cursorFor("agent:main:main")).toBe(2));
            expect(cursors).toEqual(["0", "1"]);
            expect(generations).toEqual([0, 1]);
            expect(query).toHaveBeenCalledTimes(2);
        } finally {
            rendered.unmount();
            queryClient.clear();
        }
    });

    test("refetches exact history after an old cursor receives a terminal reset snapshot", async () => {
        const sessionKey = "agent:main:main";
        const store = createChatRuntimeStore();
        store.installSnapshots(sessionKey, [], 7, true, 1);
        const terminalResetPage = {
            cursor: "12",
            events: [],
            externalRuns: [
                {
                    continuity: "complete" as const,
                    hasUnprojectedActivity: false,
                    projectionTruncated: false,
                    providerRunId: "provider-after-reset",
                    sessionKey,
                    source: "provider-runtime" as const,
                    text: "New transcript activity",
                    updatedAtMs: 1_800_000_000_200,
                },
            ],
            externalRunsTruncated: false,
            hasMore: false,
            resetRequired: true,
            runs: [
                {
                    firstSequence: 8,
                    parts: [],
                    projectionTruncated: false,
                    run: {
                        admittedAtMs: 1_800_000_000_000,
                        id: runId,
                        reconciliation: "runtime-authoritative",
                        sessionKey,
                        state: "completed",
                        stateVersion: 2,
                        updatedAtMs: 1_800_000_000_100,
                    },
                    throughSequence: 12,
                },
            ],
            sessionKey,
            transcriptGeneration: 2,
        } as const;
        const resetPage = Promise.withResolvers<typeof terminalResetPage>();
        const query = jest.fn(
            (
                _: string,
                input: Readonly<{
                    afterCursor: string;
                    afterTranscriptGeneration: number;
                }>
            ) => {
                expect(input.afterCursor).toBe("7");
                expect(input.afterTranscriptGeneration).toBe(1);
                return resetPage.promise;
            }
        );
        const historyRead = jest.fn();
        const client = { query } as unknown as DashboardTrpcClient;
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const rendered = render(
            <QueryClientProvider client={queryClient}>
                <HistoryProbe onRead={historyRead} sessionKey={sessionKey} />
                <Harness client={client} sessionKey={sessionKey} store={store} />
            </QueryClientProvider>
        );
        try {
            await waitFor(() => expect(historyRead).toHaveBeenCalledTimes(1));
            resetPage.resolve(terminalResetPage);
            await waitFor(() => expect(store.cursorFor(sessionKey)).toBe(12));
            expect(store.transcriptGenerationFor(sessionKey)).toBe(2);
            expect(
                store.state.sessions[sessionKey]?.externalRuns["provider-after-reset"]
            ).toBeDefined();
            await waitFor(() => expect(historyRead).toHaveBeenCalledTimes(2));
        } finally {
            resetPage.resolve(terminalResetPage);
            rendered.unmount();
            queryClient.clear();
        }
    });

    test("does not reduce a late page after the selected session switches", async () => {
        const store = createChatRuntimeStore();
        let resolveOld: ((value: ReturnType<typeof page>) => void) | undefined;
        const oldPage = new Promise<ReturnType<typeof page>>((resolve) => {
            resolveOld = resolve;
        });
        const query = jest.fn((_: string, input: { sessionKey: string }) =>
            input.sessionKey === "agent:main:main"
                ? oldPage
                : Promise.resolve(page("agent:other:main", "3", 1, false))
        );
        const client = { query } as unknown as DashboardTrpcClient;
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const rendered = render(
            <QueryClientProvider client={queryClient}>
                <Harness client={client} sessionKey="agent:main:main" store={store} />
            </QueryClientProvider>
        );
        rendered.rerender(
            <QueryClientProvider client={queryClient}>
                <Harness client={client} sessionKey="agent:other:main" store={store} />
            </QueryClientProvider>
        );
        resolveOld?.(page("agent:main:main", "2", 1, false));
        try {
            await waitFor(() => expect(store.cursorFor("agent:other:main")).toBe(3));
            expect(store.cursorFor("agent:main:main")).toBe(0);
        } finally {
            rendered.unmount();
            queryClient.clear();
        }
    });

    test("retains one empty runtime read before authoritative removal", async () => {
        const sessionKey = "agent:main:main";
        const store = createChatRuntimeStore();
        let invocation = 0;
        const query = jest.fn(() => {
            invocation += 1;
            return Promise.resolve({
                cursor: "0",
                events: [],
                externalRuns:
                    invocation === 1
                        ? [
                              {
                                  continuity: "complete" as const,
                                  hasUnprojectedActivity: false,
                                  projectionTruncated: false,
                                  providerRunId: "provider-run-1",
                                  sessionKey,
                                  source: "provider-runtime" as const,
                                  text: "External activity",
                                  updatedAtMs: 1_800_000_000_000,
                              },
                          ]
                        : [],
                externalRunsTruncated: false,
                hasMore: false,
                resetRequired: false,
                runs: [],
                sessionKey,
                transcriptGeneration: 1,
            });
        });
        const client = { query } as unknown as DashboardTrpcClient;
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const rendered = render(
            <QueryClientProvider client={queryClient}>
                <Harness client={client} sessionKey={sessionKey} store={store} />
            </QueryClientProvider>
        );
        try {
            await waitFor(() =>
                expect(chatRuntimeMessages(store.state, sessionKey)).toHaveLength(1)
            );
            await queryClient.invalidateQueries({
                exact: true,
                queryKey: chatRuntimeQueryKey(sessionKey),
            });
            await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
            expect(chatRuntimeMessages(store.state, sessionKey)).toHaveLength(1);
            expect(
                store.state.sessions[sessionKey]?.externalRuns["provider-run-1"]
                    ?.omissionCount
            ).toBe(1);

            await queryClient.invalidateQueries({
                exact: true,
                queryKey: chatRuntimeQueryKey(sessionKey),
            });
            await waitFor(() =>
                expect(chatRuntimeMessages(store.state, sessionKey)).toEqual([])
            );
            expect(query).toHaveBeenCalledTimes(3);
        } finally {
            rendered.unmount();
            queryClient.clear();
        }
    });
});
