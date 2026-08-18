import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
    chatHistoryRealtimeTopic,
    chatRealtimeTopic,
} from "../../contracts/chatRealtime.ts";
import { openClawTasksRealtimeTopic } from "../../contracts/openClawTasksRealtime.ts";
import { useDashboardRealtimeHub } from "../api/realtimeContextValue.ts";
import { gatewaySessionQueryKey } from "../sessions/gatewaySessionQueries.ts";
import {
    chatHistoryQueryKey,
    chatRuntimeQueryKey,
    openClawTaskDetailQueryRoot,
    openClawTaskListSessionQueryKey,
} from "./chatQueries.ts";
import type { ChatRuntimeStore } from "./chatRuntimeStore.ts";

const safetyRefreshIntervalMs = 30_000;
type ChatRefreshTarget = "history" | "runtime" | "sessions" | "task-details" | "tasks";

/**
 * Connects `/chat` to the tab-shared SSE hub without owning a second stream.
 * @param sessionKey Exact selected provider session.
 * @param runtimeStore Tab-local ordered runtime store.
 */
export function useChatRealtimeInvalidation(
    sessionKey: string,
    runtimeStore: ChatRuntimeStore
): void {
    const hub = useDashboardRealtimeHub();
    const queryClient = useQueryClient();
    const selectedSession = useRef(sessionKey);

    useEffect(() => {
        selectedSession.current = sessionKey;
    }, [sessionKey]);

    useEffect(() => {
        let disposed = false;
        const active = new Set<ChatRefreshTarget>();
        const pending = new Set<ChatRefreshTarget>();
        const drains = new Map<ChatRefreshTarget, Promise<void>>();
        const invalidate = async (targets: ReadonlySet<ChatRefreshTarget>) => {
            const selected = selectedSession.current;
            const invalidations: Promise<unknown>[] = [];
            if (targets.has("sessions")) {
                invalidations.push(
                    queryClient.invalidateQueries(
                        { queryKey: gatewaySessionQueryKey },
                        { cancelRefetch: false }
                    )
                );
            }
            if (selected !== "") {
                if (targets.has("history")) {
                    invalidations.push(
                        queryClient.invalidateQueries(
                            {
                                exact: true,
                                queryKey: chatHistoryQueryKey(selected),
                            },
                            { cancelRefetch: false }
                        )
                    );
                }
                if (targets.has("runtime")) {
                    invalidations.push(
                        queryClient.invalidateQueries(
                            {
                                exact: true,
                                queryKey: chatRuntimeQueryKey(selected),
                            },
                            { cancelRefetch: false }
                        )
                    );
                }
                if (targets.has("tasks")) {
                    invalidations.push(
                        queryClient.invalidateQueries(
                            {
                                queryKey: openClawTaskListSessionQueryKey(selected),
                            },
                            { cancelRefetch: false }
                        )
                    );
                }
            }
            if (targets.has("task-details")) {
                invalidations.push(
                    queryClient.invalidateQueries(
                        { queryKey: openClawTaskDetailQueryRoot },
                        { cancelRefetch: false }
                    )
                );
            }
            await Promise.allSettled(invalidations);
        };
        const drain = (target: ChatRefreshTarget): Promise<void> => {
            const existing = drains.get(target);
            if (existing !== undefined) return existing;
            if (disposed || !pending.delete(target)) return Promise.resolve();
            const operation = (async () => {
                active.add(target);
                try {
                    do {
                        await invalidate(new Set([target]));
                    } while (!disposed && pending.delete(target));
                } finally {
                    active.delete(target);
                }
            })();
            drains.set(target, operation);
            void operation.finally(() => {
                drains.delete(target);
                if (!disposed && pending.has(target)) {
                    queueMicrotask(() => void drain(target));
                }
            });
            return operation;
        };
        const refresh = (...targets: readonly ChatRefreshTarget[]) => {
            if (disposed) return;
            for (const target of targets) {
                pending.add(target);
                if (!active.has(target)) queueMicrotask(() => void drain(target));
            }
        };
        const refreshAll = () => {
            refresh("sessions", "history", "tasks", "task-details");
            queueMicrotask(() => {
                void drain("history").then(() => refresh("runtime"));
            });
        };
        const handleRealtimeFailure = () => {
            runtimeStore.setConnection("disconnected");
            refreshAll();
        };
        // SSE remains the primary low-latency signal, but a connection can stay
        // apparently healthy across a backend watch restart while the in-memory
        // provider subscription has disappeared. Touch both provider-backed chat
        // reads on a bounded cadence so that history can reconcile the run and the
        // following runtime read can publish its terminal projection.
        const safetyRefresh = setInterval(refreshAll, safetyRefreshIntervalMs);
        const subscription = hub.subscribe(
            [chatHistoryRealtimeTopic, chatRealtimeTopic, openClawTasksRealtimeTopic],
            {
                onData(output) {
                    if (output.data.kind === "resync-required") {
                        runtimeStore.setConnection("reconnecting");
                        refreshAll();
                        return;
                    }
                    runtimeStore.setConnection("connected");
                    const selected = selectedSession.current;
                    if (
                        output.data.event.topic === chatRealtimeTopic &&
                        selected !== ""
                    ) {
                        refresh("runtime");
                    }
                    if (
                        output.data.event.topic === chatHistoryRealtimeTopic &&
                        selected !== ""
                    ) {
                        refresh("history");
                    }
                    if (output.data.event.topic === openClawTasksRealtimeTopic) {
                        if (selected !== "") {
                            refresh("tasks");
                        }
                        refresh("task-details");
                    }
                },
                onError: handleRealtimeFailure,
            }
        );
        const offline = () => runtimeStore.setConnection("disconnected");
        const online = () => {
            runtimeStore.setConnection("reconnecting");
            refreshAll();
        };
        globalThis.addEventListener?.("offline", offline);
        globalThis.addEventListener?.("online", online);
        return () => {
            disposed = true;
            subscription.unsubscribe();
            clearInterval(safetyRefresh);
            globalThis.removeEventListener?.("offline", offline);
            globalThis.removeEventListener?.("online", online);
        };
    }, [hub, queryClient, runtimeStore]);
}
