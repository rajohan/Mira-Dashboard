import { describe, expect, jest, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";

import {
    chatHistoryRealtimeTopic,
    chatRealtimeTopic,
} from "../../contracts/chatRealtime.ts";
import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import { openClawTasksRealtimeTopic } from "../../contracts/openClawTasksRealtime.ts";
import { taskRealtimeTopic } from "../../contracts/taskRealtime.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import {
    chatHistoryQueryKey,
    chatRuntimeQueryKey,
    openClawTaskDetailQueryKey,
    openClawTaskListQueryKey,
} from "./chatQueries.ts";
import { createChatRuntimeStore, type ChatRuntimeStore } from "./chatRuntimeStore.ts";
import { useChatRealtimeInvalidation } from "./useChatRealtimeInvalidation.ts";

const { act, render } = await import("@testing-library/react");
const sessionKey = "agent:main:main";
const taskId = "task-1";

function Probe({ store }: Readonly<{ store: ChatRuntimeStore }>) {
    useChatRealtimeInvalidation(sessionKey, store);
    return null;
}

function change(topic: typeof chatHistoryRealtimeTopic): RealtimeStreamOutput;
function change(topic: typeof chatRealtimeTopic): RealtimeStreamOutput;
function change(topic: typeof openClawTasksRealtimeTopic): RealtimeStreamOutput;
function change(topic: typeof taskRealtimeTopic): RealtimeStreamOutput;
function change(
    topic:
        | typeof chatHistoryRealtimeTopic
        | typeof chatRealtimeTopic
        | typeof openClawTasksRealtimeTopic
        | typeof taskRealtimeTopic
): RealtimeStreamOutput {
    const identity = (() => {
        if (topic === chatRealtimeTopic) {
            return { entityType: "chat-runtime" as const };
        }
        if (topic === chatHistoryRealtimeTopic) {
            return { entityType: "chat-history" as const };
        }
        if (topic === openClawTasksRealtimeTopic) {
            return { entityType: "openclaw-task" as const };
        }
        return { entityType: "task" as const };
    })();
    return {
        data: {
            event: {
                entityId: topic === taskRealtimeTopic ? taskId : "current",
                ...identity,
                occurredAtMs: 1_800_000_000_000,
                operation: topic === taskRealtimeTopic ? "updated" : "snapshot-required",
                payload:
                    topic === taskRealtimeTopic
                        ? { id: taskId }
                        : { kind: "snapshot-required" },
                topic,
            } as RealtimeStreamOutput["data"] extends { event: infer TEvent }
                ? TEvent
                : never,
            kind: "change",
        },
        id: "1",
    };
}

describe("chat realtime invalidation", () => {
    test("routes runtime, history, and OpenClaw task topics without accepting Dashboard task changes", async () => {
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const store = createChatRuntimeStore();
        const runtimeKey = chatRuntimeQueryKey(sessionKey);
        const historyKey = chatHistoryQueryKey(sessionKey);
        const activeTaskListKey = openClawTaskListQueryKey(sessionKey, "active");
        const finishedTaskListKey = openClawTaskListQueryKey(sessionKey, "finished");
        const taskDetailKey = openClawTaskDetailQueryKey(taskId);
        for (const key of [
            runtimeKey,
            historyKey,
            activeTaskListKey,
            finishedTaskListKey,
            taskDetailKey,
        ]) {
            queryClient.setQueryData(key, { seeded: true });
        }
        const invalidate = jest.spyOn(queryClient, "invalidateQueries");
        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardRealtimeProvider client={realtimeClient}>
                    <Probe store={store} />
                </DashboardRealtimeProvider>
            </QueryClientProvider>
        );
        try {
            expect(realtimeClient.input).toEqual({
                lastEventId: "0",
                topics: [
                    chatHistoryRealtimeTopic,
                    chatRealtimeTopic,
                    openClawTasksRealtimeTopic,
                ].toSorted(),
            });

            await act(async () => {
                realtimeClient.emit(change(taskRealtimeTopic));
                await Promise.resolve();
            });
            expect(
                queryClient.getQueryState(activeTaskListKey)?.isInvalidated
            ).toBeFalse();
            expect(
                queryClient.getQueryState(finishedTaskListKey)?.isInvalidated
            ).toBeFalse();
            expect(queryClient.getQueryState(taskDetailKey)?.isInvalidated).toBeFalse();

            await act(async () => {
                realtimeClient.emit(change(chatRealtimeTopic));
                await Promise.resolve();
            });
            expect(queryClient.getQueryState(runtimeKey)?.isInvalidated).toBeTrue();
            expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBeFalse();

            queryClient.setQueryData(runtimeKey, { seeded: true });
            await act(async () => {
                realtimeClient.emit(change(chatHistoryRealtimeTopic));
                await Promise.resolve();
            });
            expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBeTrue();
            expect(queryClient.getQueryState(runtimeKey)?.isInvalidated).toBeFalse();
            expect(
                invalidate.mock.calls.filter(
                    ([filters]) =>
                        filters?.exact === true &&
                        JSON.stringify(filters.queryKey) === JSON.stringify(historyKey)
                )
            ).toHaveLength(1);

            await act(async () => {
                realtimeClient.emit(change(openClawTasksRealtimeTopic));
                await Promise.resolve();
            });
            expect(
                queryClient.getQueryState(activeTaskListKey)?.isInvalidated
            ).toBeTrue();
            expect(
                queryClient.getQueryState(finishedTaskListKey)?.isInvalidated
            ).toBeTrue();
            expect(queryClient.getQueryState(taskDetailKey)?.isInvalidated).toBeTrue();
            expect(store.state.connection).toBe("reconnecting");
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });
});
