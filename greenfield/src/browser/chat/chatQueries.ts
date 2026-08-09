import {
    infiniteQueryOptions,
    queryOptions,
    type InfiniteData,
    type QueryClient,
} from "@tanstack/react-query";

import type {
    ChatHistoryOutput,
    ChatMessageGetOutput,
    ChatRuntimeOutput,
} from "../../contracts/chat.ts";
import {
    chatHistoryPageMaximum,
    chatRuntimePageMaximum,
} from "../../contracts/chatModel.ts";
import type {
    OpenClawTaskDetail,
    OpenClawTaskListOutput,
    OpenClawTaskSummary,
} from "../../contracts/openClawTasks.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import type { ChatBackgroundTaskView, ChatCompanionView } from "./chatTypes.ts";

export const chatQueryRoot = ["chat"] as const;
export const chatHistoryQueryRoot = [...chatQueryRoot, "history"] as const;
export const chatRuntimeQueryRoot = [...chatQueryRoot, "runtime"] as const;
export const chatModelsQueryKey = [...chatQueryRoot, "models"] as const;
export const chatCompanionQueryRoot = [...chatQueryRoot, "companion"] as const;
export const openClawTaskQueryRoot = ["openclaw-tasks"] as const;
export const openClawTaskListQueryRoot = [...openClawTaskQueryRoot, "list"] as const;
export const openClawTaskDetailQueryRoot = [...openClawTaskQueryRoot, "detail"] as const;
export const chatHistoryBrowserPageMaximum = 5;
export const openClawTasksBrowserPageMaximum = 5;
export type OpenClawTaskListProjection = "active" | "finished";

const openClawTaskListProjectionPolicy = {
    active: {
        limit: 200,
        statuses: ["queued", "running"],
    },
    finished: {
        limit: 100,
        statuses: ["completed", "failed", "cancelled", "timed_out"],
    },
} as const;

/**
 * Retains a fixed newest-page window so infinite-query refresh cost stays bounded.
 * @param data Current newest-to-oldest infinite data.
 * @param maximumPages Explicit positive browser page ceiling.
 * @returns The same data when already bounded, otherwise its newest-page window.
 */
export function retainLatestPageWindow<TPage>(
    data: InfiniteData<TPage> | undefined,
    maximumPages: number
): InfiniteData<TPage> | undefined {
    if (data === undefined || data.pages.length <= maximumPages) return data;
    return {
        pageParams: data.pageParams.slice(0, maximumPages),
        pages: data.pages.slice(0, maximumPages),
    };
}

/**
 * Drops older pages from a superseded provider transcript and enforces the tab cap.
 * @param data Current newest-to-oldest history pages.
 * @returns A single-provider bounded history cache.
 */
export function retainAuthoritativeHistoryWindow(
    data: InfiniteData<ChatHistoryOutput> | undefined
): InfiniteData<ChatHistoryOutput> | undefined {
    if (data === undefined) return undefined;
    const authority = data.pages[0]?.sessionId;
    const retainedIndexes = data.pages.flatMap((page, index) =>
        page.sessionId === authority ? [index] : []
    );
    const boundedIndexes = retainedIndexes.slice(0, chatHistoryBrowserPageMaximum);
    if (
        boundedIndexes.length === data.pages.length &&
        boundedIndexes.every((index, position) => index === position)
    ) {
        return data;
    }
    return {
        pageParams: boundedIndexes.map((index) => data.pageParams[index]),
        pages: boundedIndexes.flatMap((index) => {
            const page = data.pages[index];
            return page === undefined ? [] : [page];
        }),
    };
}

export function chatHistoryQueryKey(sessionKey: string) {
    return [...chatHistoryQueryRoot, sessionKey] as const;
}

export function chatMessageQueryKey(sessionKey: string, messageId: string) {
    return [...chatHistoryQueryRoot, sessionKey, "message", messageId] as const;
}

export function chatRuntimeQueryKey(sessionKey: string) {
    return [...chatRuntimeQueryRoot, sessionKey] as const;
}

export function chatCompanionQueryKey(sessionKey: string) {
    return [...chatCompanionQueryRoot, sessionKey] as const;
}

export function openClawTaskListSessionQueryKey(sessionKey: string) {
    return [...openClawTaskListQueryRoot, sessionKey] as const;
}

export function openClawTaskListQueryKey(
    sessionKey: string,
    projection: OpenClawTaskListProjection
) {
    return [...openClawTaskListSessionQueryKey(sessionKey), projection] as const;
}

export function openClawTaskDetailQueryKey(taskId: string) {
    return [...openClawTaskDetailQueryRoot, taskId] as const;
}

/**
 * Merges offset-paginated task pages while letting the newest page own overlaps.
 * @param data Retained newest-to-oldest task pages.
 * @returns Unique provider rows in their first-page activity order.
 */
export function mergeOpenClawTaskPages(
    data: InfiniteData<OpenClawTaskListOutput> | undefined
): readonly OpenClawTaskSummary[] {
    if (data === undefined) return [];
    const seen = new Set<string>();
    return data.pages.flatMap((page) =>
        page.tasks.filter((task) => {
            if (seen.has(task.id)) return false;
            seen.add(task.id);
            return true;
        })
    );
}

function taskIsActive(task: OpenClawTaskSummary): boolean {
    return task.status === "queued" || task.status === "running";
}

/**
 * Reconciles separately bounded active and finished snapshots without allowing
 * stale active overlap to roll a terminal task backward.
 * @param activeData Active-only newest-to-oldest provider pages.
 * @param finishedData Finished-only newest-to-oldest provider pages.
 * @returns Unique active-first rows in deterministic activity order.
 */
export function mergeOpenClawTaskProjectionPages(
    activeData: InfiniteData<OpenClawTaskListOutput> | undefined,
    finishedData: InfiniteData<OpenClawTaskListOutput> | undefined
): readonly OpenClawTaskSummary[] {
    const positions = new Map<string, number>();
    const tasks = new Map<string, OpenClawTaskSummary>();
    const rows = [
        ...mergeOpenClawTaskPages(activeData),
        ...mergeOpenClawTaskPages(finishedData),
    ];
    for (const [position, task] of rows.entries()) {
        positions.set(task.id, positions.get(task.id) ?? position);
        const current = tasks.get(task.id);
        const currentObservedAtMs = current?.updatedAtMs ?? 0;
        const nextObservedAtMs = task.updatedAtMs ?? 0;
        if (
            current === undefined ||
            nextObservedAtMs > currentObservedAtMs ||
            (nextObservedAtMs === currentObservedAtMs &&
                taskIsActive(current) &&
                !taskIsActive(task))
        ) {
            tasks.set(task.id, task);
        }
    }
    return [...tasks.values()].toSorted((left, right) => {
        const activeDifference = Number(taskIsActive(right)) - Number(taskIsActive(left));
        if (activeDifference !== 0) return activeDifference;
        const activityDifference = (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0);
        if (activityDifference !== 0) return activityDifference;
        return (positions.get(left.id) ?? 0) - (positions.get(right.id) ?? 0);
    });
}

/**
 * Defines bounded older-history pages while retaining budget-safe preview rows.
 * @param client Validating browser tRPC client.
 * @param sessionKey Exact selected provider session.
 * @returns Infinite-query options for chronological history.
 */
export function chatHistoryQueryOptions(client: DashboardTrpcClient, sessionKey: string) {
    return infiniteQueryOptions({
        enabled: sessionKey !== "",
        initialPageParam: "0",
        queryFn: ({ pageParam, signal }): Promise<ChatHistoryOutput> => {
            if (sessionKey === "") throw new TypeError("Chat history needs a session");
            return client.query(
                "chat.history",
                { cursor: pageParam, limit: chatHistoryPageMaximum, sessionKey },
                { signal }
            );
        },
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        queryKey: chatHistoryQueryKey(sessionKey),
        retry: false,
        staleTime: 0,
    });
}

/**
 * Hydrates one explicitly opened history row into its independently cached detail.
 * @param client Validating browser tRPC client.
 * @param sessionKey Exact selected provider session.
 * @param messageId Explicitly opened history row.
 * @returns Query options for one bounded message detail.
 */
export function chatMessageQueryOptions(
    client: DashboardTrpcClient,
    sessionKey: string,
    messageId: string | undefined
) {
    return queryOptions({
        enabled: sessionKey !== "" && messageId !== undefined,
        queryFn: ({ signal }): Promise<ChatMessageGetOutput> => {
            if (sessionKey === "" || messageId === undefined) {
                throw new TypeError("Chat message detail needs a session and message id");
            }
            return client.query("chat.getMessage", { messageId, sessionKey }, { signal });
        },
        queryKey: chatMessageQueryKey(sessionKey, messageId ?? ""),
        retry: false,
        staleTime: 5 * 60_000,
    });
}

export interface ChatRuntimeBatch {
    readonly cursor: string;
    readonly events: ChatRuntimeOutput["events"];
    readonly externalRuns: ChatRuntimeOutput["externalRuns"];
    readonly externalRunsTruncated: ChatRuntimeOutput["externalRunsTruncated"];
    readonly hasMore: boolean;
    readonly resetRequired: boolean;
    readonly runs: ChatRuntimeOutput["runs"];
    readonly sessionKey: string;
    readonly transcriptGeneration: number;
}

export async function readChatRuntimeBatch(
    client: DashboardTrpcClient,
    sessionKey: string,
    afterCursor: string,
    signal: AbortSignal,
    afterTranscriptGeneration = 0
): Promise<ChatRuntimeBatch> {
    const page = await client.query(
        "chat.runtime",
        {
            afterCursor,
            afterTranscriptGeneration,
            limit: chatRuntimePageMaximum,
            sessionKey,
        },
        { signal }
    );
    return {
        cursor: page.cursor,
        events: page.events,
        externalRuns: page.externalRuns ?? [],
        externalRunsTruncated: page.externalRunsTruncated ?? false,
        hasMore: page.hasMore,
        resetRequired: page.resetRequired,
        runs: page.runs,
        sessionKey,
        transcriptGeneration: page.transcriptGeneration,
    };
}

/**
 * Reads one clear bounded delta window or an authoritative reset snapshot.
 * @param client Validating browser tRPC client.
 * @param sessionKey Exact selected provider session.
 * @param getAfterCursor Current reducer cursor reader.
 * @returns Query options for one runtime window.
 */
export function chatRuntimeQueryOptions(
    client: DashboardTrpcClient,
    sessionKey: string,
    getAfterCursor: () => string,
    getAfterTranscriptGeneration: () => number = () => 0
) {
    return queryOptions({
        enabled: sessionKey !== "",
        queryFn: ({ signal }) => {
            if (sessionKey === "") throw new TypeError("Chat runtime needs a session");
            return readChatRuntimeBatch(
                client,
                sessionKey,
                getAfterCursor(),
                signal,
                getAfterTranscriptGeneration()
            );
        },
        queryKey: chatRuntimeQueryKey(sessionKey),
        retry: false,
        staleTime: 0,
    });
}

/**
 * @param client Validating browser tRPC client.
 * @returns Bounded configured provider model inventory.
 */
export function chatModelsQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("chat.listModels", {}, { signal }),
        queryKey: chatModelsQueryKey,
        staleTime: 60_000,
    });
}

/**
 * @param client Validating browser tRPC client.
 * @param sessionKey Exact selected provider session.
 * @returns Ephemeral read-only companion thread for one exact session.
 */
export function chatCompanionQueryOptions(
    client: DashboardTrpcClient,
    sessionKey: string
) {
    return queryOptions({
        enabled: sessionKey !== "",
        queryFn: ({ signal }) => {
            if (sessionKey === "") throw new TypeError("Chat companion needs a session");
            return client.query("chat.companionState", { sessionKey }, { signal });
        },
        queryKey: chatCompanionQueryKey(sessionKey),
        retry: false,
        staleTime: 0,
    });
}

/**
 * @param client Validating browser tRPC client.
 * @param sessionKey Exact selected provider session.
 * @returns Cursor-paginated prompt-free background tasks for one session.
 */
export function openClawTaskListQueryOptions(
    client: DashboardTrpcClient,
    sessionKey: string,
    projection: OpenClawTaskListProjection
) {
    const policy = openClawTaskListProjectionPolicy[projection];
    return infiniteQueryOptions({
        enabled: sessionKey !== "",
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam, signal }): Promise<OpenClawTaskListOutput> => {
            if (sessionKey === "") throw new TypeError("Task list needs a session");
            return client.query(
                "openClawTasks.list",
                {
                    ...(pageParam === undefined ? {} : { cursor: pageParam }),
                    limit: policy.limit,
                    sessionKey,
                    statuses: [...policy.statuses],
                },
                { signal }
            );
        },
        getNextPageParam: (page) => page.nextCursor,
        queryKey: openClawTaskListQueryKey(sessionKey, projection),
        retry: false,
        staleTime: 5000,
    });
}

/**
 * @param client Validating browser tRPC client.
 * @param taskId Explicitly selected background-task id.
 * @returns Exact background-task detail when one row is selected.
 */
export function openClawTaskDetailQueryOptions(
    client: DashboardTrpcClient,
    taskId: string | undefined
) {
    return queryOptions({
        enabled: taskId !== undefined,
        queryFn: async ({ signal }) => {
            if (taskId === undefined) throw new TypeError("Task detail needs an id");
            return client.query("openClawTasks.get", { taskId }, { signal });
        },
        queryKey: openClawTaskDetailQueryKey(taskId ?? ""),
        retry: false,
        staleTime: 5000,
    });
}

/**
 * Invalidates the one selected runtime cursor query after an SSE marker.
 * @param queryClient Browser query cache.
 * @param sessionKey Optional exact session scope.
 * @returns When invalidation scheduling completes.
 */
export async function refreshChatRuntimeQuery(
    queryClient: QueryClient,
    sessionKey?: string
): Promise<void> {
    await queryClient.invalidateQueries({
        queryKey:
            sessionKey === undefined
                ? chatRuntimeQueryRoot
                : chatRuntimeQueryKey(sessionKey),
    });
}

/**
 * Projects the newest companion exchange without treating it as transcript history.
 * @param exchanges Bounded provider companion exchanges.
 * @returns Current companion side-panel state.
 */
export function projectChatCompanion(
    exchanges: readonly Readonly<{ answer: string; question: string }>[] | undefined
): ChatCompanionView {
    const latest = exchanges?.at(-1);
    return latest === undefined
        ? { status: "idle" }
        : {
              answer: latest.answer,
              question: latest.question,
              status: "ready",
          };
}

/**
 * Projects a prompt-free task row and optional selected detail.
 * @param task Prompt-free list summary.
 * @param detail Explicitly selected bounded task detail.
 * @returns Side-panel task row.
 */
export function projectOpenClawTask(
    task: OpenClawTaskSummary,
    detail?: OpenClawTaskDetail
): ChatBackgroundTaskView {
    const summary =
        task.terminalSummary ?? task.error ?? task.progressSummary ?? task.lastToolName;
    const detailText =
        detail === undefined
            ? undefined
            : [
                  detail.prompt,
                  detail.progressSummary,
                  detail.terminalSummary,
                  detail.error,
              ]
                  .filter((value): value is string => value !== undefined)
                  .join("\n\n");
    return {
        ...(detailText === undefined || detailText === "" ? {} : { detail: detailText }),
        id: task.id,
        label: task.title ?? task.kind ?? task.id,
        status: task.status,
        ...(summary === undefined ? {} : { summary }),
        ...(task.updatedAtMs === undefined ? {} : { updatedAtMs: task.updatedAtMs }),
    };
}
