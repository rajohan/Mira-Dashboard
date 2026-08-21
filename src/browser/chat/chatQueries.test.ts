import { describe, expect, jest, test } from "bun:test";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import {
    chatHistoryQueryOptions,
    chatMessageQueryOptions,
    chatRuntimeQueryOptions,
    mergeOpenClawTaskPages,
    mergeOpenClawTaskProjectionPages,
    openClawTaskListQueryOptions,
    projectChatCompanion,
    projectOpenClawTask,
    retainAuthoritativeHistoryWindow,
    retainLatestPageWindow,
} from "./chatQueries.ts";

const sessionKey = "agent:main:main";

function taskSummary(id: string, title: string) {
    return { id, status: "running" as const, title };
}

describe("chat queries", () => {
    test("keeps one hundred truncated previews within one history request", async () => {
        const query = jest.fn((name: string, input: unknown) => {
            expect(name).toBe("chat.history");
            expect(input).toEqual({ cursor: "0", limit: 100, sessionKey });
            return Promise.resolve({
                messages: Array.from({ length: 100 }, (_, index) => ({
                    content: {
                        kind: "hydration-required",
                        preview: `Preview ${index}`,
                        reason: "response-budget",
                    },
                    id: `message-${index}`,
                    role: "assistant",
                    source: "gateway-history",
                })),
                providerPagesRead: 1,
                sessionKey,
                truncated: true,
            });
        });
        const options = chatHistoryQueryOptions(
            { query } as unknown as DashboardTrpcClient,
            sessionKey
        );
        const page = await options.queryFn?.({
            client: undefined as never,
            direction: "forward",
            meta: undefined,
            pageParam: "0",
            queryKey: options.queryKey,
            signal: new AbortController().signal,
        });
        expect(page?.messages).toHaveLength(100);
        expect(page?.messages[99]?.content.kind).toBe("hydration-required");
        expect(query).toHaveBeenCalledTimes(1);
    });

    test("hydrates only the one explicitly opened message", async () => {
        const query = jest.fn().mockResolvedValue({ status: "unavailable" });
        const options = chatMessageQueryOptions(
            { query } as unknown as DashboardTrpcClient,
            sessionKey,
            "message-42"
        );
        await options.queryFn?.({
            client: undefined as never,
            meta: undefined,
            queryKey: options.queryKey,
            signal: new AbortController().signal,
        });
        expect(query).toHaveBeenCalledWith(
            "chat.getMessage",
            { messageId: "message-42", sessionKey },
            expect.anything()
        );
    });

    test("reads one bounded runtime delta window from the latest cursor", async () => {
        const query = jest.fn().mockResolvedValue({
            cursor: "4",
            events: [],
            hasMore: false,
            resetRequired: false,
            runs: [],
            sessionKey,
        });
        const options = chatRuntimeQueryOptions(
            { query } as unknown as DashboardTrpcClient,
            sessionKey,
            () => "3"
        );
        const batch = await options.queryFn?.({
            client: undefined as never,
            meta: undefined,
            queryKey: options.queryKey,
            signal: new AbortController().signal,
        });
        expect(batch?.cursor).toBe("4");
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0]?.[1]).toEqual({
            afterCursor: "3",
            afterTranscriptGeneration: 0,
            limit: 256,
            sessionKey,
        });
    });

    test("deduplicates overlapping task pages with the newest occurrence winning", () => {
        const tasks = mergeOpenClawTaskPages({
            pageParams: [undefined, "2"],
            pages: [
                {
                    tasks: [
                        taskSummary("task-3", "Newest"),
                        taskSummary("task-2", "Fresh copy"),
                    ],
                },
                {
                    tasks: [
                        taskSummary("task-2", "Stale copy"),
                        taskSummary("task-1", "Oldest"),
                    ],
                },
            ],
        });
        expect(tasks.map(({ id }) => id)).toEqual(["task-3", "task-2", "task-1"]);
        expect(tasks[1]?.title).toBe("Fresh copy");
    });

    test("reads separate parity-bounded active and finished task snapshots", async () => {
        const query = jest.fn().mockResolvedValue({ tasks: [] });
        const client = { query } as unknown as DashboardTrpcClient;
        const active = openClawTaskListQueryOptions(client, sessionKey, "active");
        const finished = openClawTaskListQueryOptions(client, sessionKey, "finished");
        for (const options of [active, finished]) {
            await options.queryFn?.({
                client: undefined as never,
                direction: "forward",
                meta: undefined,
                pageParam: undefined,
                queryKey: options.queryKey,
                signal: new AbortController().signal,
            });
        }
        expect(active.queryKey).not.toEqual(finished.queryKey);
        expect(query).toHaveBeenNthCalledWith(
            1,
            "openClawTasks.list",
            {
                limit: 200,
                sessionKey,
                statuses: ["queued", "running"],
            },
            expect.anything()
        );
        expect(query).toHaveBeenNthCalledWith(
            2,
            "openClawTasks.list",
            {
                limit: 100,
                sessionKey,
                statuses: ["completed", "failed", "cancelled", "timed_out"],
            },
            expect.anything()
        );
    });

    test("stops task pagination when an empty page repeats its cursor", () => {
        const options = openClawTaskListQueryOptions(
            { query: jest.fn() } as unknown as DashboardTrpcClient,
            sessionKey,
            "finished"
        );
        const firstPage = {
            nextCursor: "1",
            tasks: [taskSummary("task-1", "First")],
        };
        const emptyPage = { nextCursor: "1", tasks: [] };

        expect(
            options.getNextPageParam?.(firstPage, [firstPage], undefined, [undefined])
        ).toBe("1");
        expect(
            options.getNextPageParam?.(emptyPage, [firstPage, emptyPage], "1", [
                undefined,
                "1",
            ])
        ).toBeUndefined();
    });

    test("merges active and finished ledgers without rolling terminal overlap backward", () => {
        const tasks = mergeOpenClawTaskProjectionPages(
            {
                pageParams: [undefined],
                pages: [
                    {
                        tasks: [
                            {
                                ...taskSummary("task-overlap", "Stale running"),
                                updatedAtMs: 10,
                            },
                            {
                                ...taskSummary("task-active", "Active"),
                                updatedAtMs: 30,
                            },
                        ],
                    },
                ],
            },
            {
                pageParams: [undefined],
                pages: [
                    {
                        tasks: [
                            {
                                id: "task-overlap",
                                status: "completed",
                                title: "Terminal",
                                updatedAtMs: 20,
                            },
                            {
                                id: "task-finished",
                                status: "failed",
                                title: "Finished",
                                updatedAtMs: 40,
                            },
                        ],
                    },
                ],
            }
        );
        expect(tasks.map(({ id }) => id)).toEqual([
            "task-active",
            "task-finished",
            "task-overlap",
        ]);
        expect(tasks.at(-1)?.status).toBe("completed");
    });

    test("bounds retained ledgers and drops superseded provider history pages", () => {
        const pages = Array.from({ length: 12 }, (_, index) => ({ index }));
        expect(
            retainLatestPageWindow(
                { pageParams: pages.map(({ index }) => index), pages },
                5
            )?.pages.map(({ index }) => index)
        ).toEqual([0, 1, 2, 3, 4]);

        const history = retainAuthoritativeHistoryWindow({
            pageParams: ["0", "1", "2", "3", "4", "5", "6"],
            pages: Array.from({ length: 7 }, (_, index) => ({
                messages: [],
                providerPagesRead: 1,
                sessionId: index === 2 ? "superseded" : "current",
                sessionKey,
                truncated: index < 6,
            })),
        });
        expect(history?.pages).toHaveLength(6);
        expect(history?.pages.every(({ sessionId }) => sessionId === "current")).toBe(
            true
        );
        expect(history?.pageParams).toEqual(["0", "1", "3", "4", "5", "6"]);
    });

    test("preserves authoritative snapshots without chasing deltas on reset", async () => {
        const snapshot = { run: { id: "run-1" } };
        const query = jest.fn().mockResolvedValue({
            cursor: "90",
            events: [],
            hasMore: false,
            resetRequired: true,
            runs: [snapshot],
            sessionKey,
        });
        const options = chatRuntimeQueryOptions(
            { query } as unknown as DashboardTrpcClient,
            sessionKey,
            () => "2"
        );
        const batch = await options.queryFn?.({
            client: undefined as never,
            meta: undefined,
            queryKey: options.queryKey,
            signal: new AbortController().signal,
        });
        expect(batch).toMatchObject({
            cursor: "90",
            events: [],
            resetRequired: true,
            runs: [snapshot],
        });
        expect(query).toHaveBeenCalledTimes(1);
    });

    test("projects companion and task detail independently from the transcript", () => {
        expect(
            projectChatCompanion([{ answer: "Latest", question: "What changed?" }])
        ).toEqual({
            answer: "Latest",
            question: "What changed?",
            status: "ready",
        });
        expect(
            projectOpenClawTask(
                {
                    id: "task-1",
                    progressSummary: "Checking",
                    status: "running",
                    title: "Review logs",
                },
                {
                    id: "task-1",
                    prompt: "Inspect the bounded task details.",
                    progressSummary: "Checking",
                    status: "running",
                    title: "Review logs",
                }
            )
        ).toMatchObject({
            detail: "Inspect the bounded task details.\n\nChecking",
            id: "task-1",
            label: "Review logs",
            status: "running",
            summary: "Checking",
        });
    });
});
