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
const trailingRefreshBackoffMs = 1000;
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
        let active = false;
        let backoff: ReturnType<typeof setTimeout> | undefined;
        let disposed = false;
        let scheduled = false;
        let trailing = false;
        let runningTrailing = false;
        let pending = new Set<ChatRefreshTarget>();
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
                let historyRefresh: Promise<unknown> | undefined;
                if (targets.has("history")) {
                    historyRefresh = queryClient.invalidateQueries(
                        {
                            exact: true,
                            queryKey: chatHistoryQueryKey(selected),
                        },
                        { cancelRefetch: false }
                    );
                    invalidations.push(historyRefresh);
                }
                if (targets.has("runtime")) {
                    invalidations.push(
                        (async () => {
                            // `chat.history` performs the provider observation that
                            // can retire a missed live activity. Read runtime only
                            // after that reconciliation has had a chance to publish.
                            if (historyRefresh !== undefined) {
                                await Promise.allSettled([historyRefresh]);
                            }
                            return queryClient.invalidateQueries(
                                {
                                    exact: true,
                                    queryKey: chatRuntimeQueryKey(selected),
                                },
                                { cancelRefetch: false }
                            );
                        })()
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
        const drain = async () => {
            if (disposed || active) return;
            scheduled = false;
            active = true;
            const initial = pending;
            pending = new Set();
            try {
                await invalidate(initial);
                if (!disposed && trailing) {
                    trailing = false;
                    runningTrailing = true;
                    const next = pending;
                    pending = new Set();
                    await invalidate(next);
                }
            } finally {
                active = false;
                runningTrailing = false;
                if (!disposed && pending.size > 0 && backoff === undefined) {
                    backoff = setTimeout(() => {
                        backoff = undefined;
                        if (disposed || scheduled || active) return;
                        scheduled = true;
                        queueMicrotask(() => void drain());
                    }, trailingRefreshBackoffMs);
                }
            }
        };
        const refresh = (...targets: readonly ChatRefreshTarget[]) => {
            if (disposed) return;
            for (const target of targets) pending.add(target);
            if (active && runningTrailing) return;
            if (active) {
                trailing = true;
                return;
            }
            if (backoff !== undefined) return;
            if (scheduled) return;
            scheduled = true;
            queueMicrotask(() => void drain());
        };
        const refreshAll = () =>
            refresh("sessions", "runtime", "history", "tasks", "task-details");
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
            if (backoff !== undefined) clearTimeout(backoff);
            globalThis.removeEventListener?.("offline", offline);
            globalThis.removeEventListener?.("online", online);
        };
    }, [hub, queryClient, runtimeStore]);
}
