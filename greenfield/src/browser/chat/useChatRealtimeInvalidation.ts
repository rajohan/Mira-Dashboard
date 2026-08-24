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

const fallbackRefreshIntervalMs = 30_000;

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
        let fallback: ReturnType<typeof setInterval> | undefined;
        const refresh = () => {
            const selected = selectedSession.current;
            void queryClient.invalidateQueries({ queryKey: gatewaySessionQueryKey });
            if (selected !== "") {
                void queryClient.invalidateQueries({
                    exact: true,
                    queryKey: chatRuntimeQueryKey(selected),
                });
                void queryClient.invalidateQueries({
                    exact: true,
                    queryKey: chatHistoryQueryKey(selected),
                });
                void queryClient.invalidateQueries({
                    queryKey: openClawTaskListSessionQueryKey(selected),
                });
            }
            void queryClient.invalidateQueries({ queryKey: openClawTaskDetailQueryRoot });
        };
        const startFallback = () => {
            runtimeStore.setConnection("disconnected");
            refresh();
            fallback ??= setInterval(refresh, fallbackRefreshIntervalMs);
        };
        const subscription = hub.subscribe(
            [chatHistoryRealtimeTopic, chatRealtimeTopic, openClawTasksRealtimeTopic],
            {
                onData(output) {
                    if (output.data.kind === "resync-required") {
                        runtimeStore.setConnection("reconnecting");
                        refresh();
                        return;
                    }
                    const selected = selectedSession.current;
                    if (
                        output.data.event.topic === chatRealtimeTopic &&
                        selected !== ""
                    ) {
                        void queryClient.invalidateQueries({
                            exact: true,
                            queryKey: chatRuntimeQueryKey(selected),
                        });
                    }
                    if (
                        output.data.event.topic === chatHistoryRealtimeTopic &&
                        selected !== ""
                    ) {
                        void queryClient.invalidateQueries({
                            exact: true,
                            queryKey: chatHistoryQueryKey(selected),
                        });
                    }
                    if (output.data.event.topic === openClawTasksRealtimeTopic) {
                        if (selected !== "") {
                            void queryClient.invalidateQueries({
                                queryKey: openClawTaskListSessionQueryKey(selected),
                            });
                        }
                        void queryClient.invalidateQueries({
                            queryKey: openClawTaskDetailQueryRoot,
                        });
                    }
                },
                onError: startFallback,
            }
        );
        const offline = () => runtimeStore.setConnection("disconnected");
        const online = () => {
            runtimeStore.setConnection("reconnecting");
            refresh();
        };
        globalThis.addEventListener?.("offline", offline);
        globalThis.addEventListener?.("online", online);
        return () => {
            subscription.unsubscribe();
            if (fallback !== undefined) clearInterval(fallback);
            globalThis.removeEventListener?.("offline", offline);
            globalThis.removeEventListener?.("online", online);
        };
    }, [hub, queryClient, runtimeStore]);
}
