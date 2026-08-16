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
import { gatewaySessionQueryKey } from "../sessions/gatewaySessionQueries.ts";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { projectChatExternalRun } from "./chatContractAdapter.ts";
import {
    chatHistoryQueryKey,
    chatRuntimeQueryKey,
    openClawTaskDetailQueryKey,
    openClawTaskDetailQueryRoot,
    openClawTaskListQueryKey,
    openClawTaskListSessionQueryKey,
} from "./chatQueries.ts";
import {
    chatRuntimeMessages,
    createChatRuntimeStore,
    type ChatRuntimeStore,
} from "./chatRuntimeStore.ts";
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
    test("keeps a single safety refresh active when realtime stays silently connected", async () => {
        jest.useFakeTimers();
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const store = createChatRuntimeStore();
        store.setConnection("connected");
        const invalidate = jest
            .spyOn(queryClient, "invalidateQueries")
            .mockResolvedValue();
        const interval = jest.spyOn(globalThis, "setInterval");
        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardRealtimeProvider client={realtimeClient}>
                    <Probe store={store} />
                </DashboardRealtimeProvider>
            </QueryClientProvider>
        );
        try {
            expect(interval).toHaveBeenCalledTimes(1);
            expect(store.state.connection).toBe("connected");

            await act(async () => {
                jest.advanceTimersByTime(29_999);
                await Promise.resolve();
            });
            expect(invalidate).not.toHaveBeenCalled();

            await act(async () => {
                jest.advanceTimersByTime(1);
                await Promise.resolve();
                await Promise.resolve();
            });
            const safetyKeys = invalidate.mock.calls.map(
                ([filters]) => filters?.queryKey
            );
            expect(safetyKeys).toContainEqual(chatHistoryQueryKey(sessionKey));
            expect(safetyKeys).toContainEqual(chatRuntimeQueryKey(sessionKey));
            expect(safetyKeys).toContainEqual(gatewaySessionQueryKey);
            expect(safetyKeys).toContainEqual(
                openClawTaskListSessionQueryKey(sessionKey)
            );
            expect(safetyKeys).toContainEqual(openClawTaskDetailQueryRoot);
            expect(store.state.connection).toBe("connected");

            await act(async () => {
                realtimeClient.fail();
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(interval).toHaveBeenCalledTimes(1);
            expect(store.state.connection).toBe("disconnected");

            await act(async () => {
                realtimeClient.emit(change(chatRealtimeTopic));
                await Promise.resolve();
            });
            expect(store.state.connection).toBe("connected");
        } finally {
            view.unmount();
            interval.mockRestore();
            queryClient.clear();
            jest.useRealTimers();
        }
    });

    test("keeps runtime refresh independent while a safety history read is slow", async () => {
        jest.useFakeTimers();
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const store = createChatRuntimeStore();
        store.installExternalRuns(sessionKey, [
            projectChatExternalRun({
                continuity: "complete",
                lifecycle: "active" as const,
                hasUnprojectedActivity: false,
                observationEpoch: 1,
                observedAtMs: 1000,
                parts: [
                    {
                        id: "compaction:silent-restart",
                        kind: "item",
                        occurredAtMs: 1000,
                        sequence: 1,
                        text: "Compacting context",
                        type: "compaction",
                    },
                ],
                projectionTruncated: false,
                providerRunId: "silent-restart",
                sessionKey,
                source: "provider-runtime",
                text: "",
                updatedAtMs: 1000,
            }),
        ]);
        const historyGate = Promise.withResolvers<void>();
        let runtimeRead = false;
        const invalidate = jest
            .spyOn(queryClient, "invalidateQueries")
            .mockImplementation((filters) => {
                const key = JSON.stringify(filters?.queryKey);
                if (key === JSON.stringify(chatHistoryQueryKey(sessionKey))) {
                    return (async () => {
                        await historyGate.promise;
                    })();
                }
                if (key === JSON.stringify(chatRuntimeQueryKey(sessionKey))) {
                    runtimeRead = true;
                    store.installExternalRuns(sessionKey, []);
                }
                return Promise.resolve();
            });
        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardRealtimeProvider client={realtimeClient}>
                    <Probe store={store} />
                </DashboardRealtimeProvider>
            </QueryClientProvider>
        );
        try {
            await act(async () => {
                jest.advanceTimersByTime(30_000);
                await Promise.resolve();
            });
            expect(runtimeRead).toBeTrue();
            expect(chatRuntimeMessages(store.state, sessionKey)).toEqual([]);

            await act(async () => {
                historyGate.resolve();
                await historyGate.promise;
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(store.state.connection).toBe("reconnecting");
            expect(
                invalidate.mock.calls.some(
                    ([filters]) =>
                        JSON.stringify(filters?.queryKey) ===
                        JSON.stringify(chatRuntimeQueryKey(sessionKey))
                )
            ).toBeTrue();
        } finally {
            historyGate.resolve();
            view.unmount();
            queryClient.clear();
            jest.useRealTimers();
        }
    });

    test("coalesces a marker burst independently for each refresh target", async () => {
        jest.useFakeTimers();
        const queryClient = createDashboardQueryClient();
        const realtimeClient = new ControlledDashboardRealtimeClient();
        const store = createChatRuntimeStore();
        const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        let invocation = 0;
        const invalidate = jest
            .spyOn(queryClient, "invalidateQueries")
            .mockImplementation((filters) => {
                if (
                    JSON.stringify(filters?.queryKey) !==
                    JSON.stringify(chatHistoryQueryKey(sessionKey))
                ) {
                    return Promise.resolve();
                }
                const gate = gates[invocation];
                invocation += 1;
                return gate?.promise ?? Promise.resolve();
            });
        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardRealtimeProvider client={realtimeClient}>
                    <Probe store={store} />
                </DashboardRealtimeProvider>
            </QueryClientProvider>
        );
        try {
            await act(async () => {
                realtimeClient.emit(change(chatHistoryRealtimeTopic));
                await Promise.resolve();
            });
            expect(invalidate).toHaveBeenCalledTimes(1);

            await act(async () => {
                for (let index = 0; index < 100; index += 1) {
                    realtimeClient.emit(change(chatHistoryRealtimeTopic));
                }
                gates[0]!.resolve();
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(invalidate).toHaveBeenCalledTimes(2);

            await act(async () => {
                for (let index = 0; index < 100; index += 1) {
                    realtimeClient.emit(change(chatHistoryRealtimeTopic));
                }
                gates[1]!.resolve();
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(invalidate).toHaveBeenCalledTimes(3);
            expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
                chatHistoryQueryKey(sessionKey),
                chatHistoryQueryKey(sessionKey),
                chatHistoryQueryKey(sessionKey),
            ]);
            expect(
                invalidate.mock.calls.every(
                    ([, options]) => options?.cancelRefetch === false
                )
            ).toBeTrue();
        } finally {
            for (const gate of gates) gate.resolve();
            view.unmount();
            queryClient.clear();
            jest.useRealTimers();
        }
    });

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
            expect(store.state.connection).toBe("connected");
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });
});
