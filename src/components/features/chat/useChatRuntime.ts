import { useEffect, useRef, useState } from "react";

import {
    acknowledgeChatRun,
    addOptimisticChatRun,
    type ChatRuntimeEvent,
    type ChatRuntimeState,
    clearChatRun,
    clearChatSessionRuntime,
    createChatRuntimeState,
    reduceChatRuntime,
} from "./domain/chatState";
import type { ChatTransport } from "./transport/chatTransport";

const COMPLETED_RUN_RETENTION_MS = 15 * 60_000;

interface SnapshotGate {
    events: ChatRuntimeEvent[];
    sessionKey: string;
    token: number;
}

interface UseChatRuntimeOptions {
    onError?: (message: string) => void;
    onSettled?: (sessionKey: string) => void;
    selectedSessionKey: string;
    transport: ChatTransport;
}

export interface ChatRuntimeController {
    acknowledgeRun(
        sessionKey: string,
        optimisticRunId: string,
        providerRunId?: string
    ): void;
    beginRun(sessionKey: string, runId: string, operation?: "compact"): void;
    clearRun(sessionKey: string, runId: string): void;
    clearSession(sessionKey: string): void;
    state: ChatRuntimeState;
}

/** Owns replay/live ordering and canonical runtime state for every chat session. */
export function useChatRuntime({
    onError,
    onSettled,
    selectedSessionKey,
    transport,
}: UseChatRuntimeOptions): ChatRuntimeController {
    const [state, setState] = useState(() =>
        createChatRuntimeState(transport.connectionGeneration)
    );
    const gateReference = useRef<SnapshotGate | undefined>(undefined);
    const gateTokenReference = useRef(0);
    const selectedSessionReference = useRef(selectedSessionKey);
    const callbacksReference = useRef({ onError, onSettled });
    const transportReference = useRef(transport);
    const completionTimersReference = useRef(
        new Map<string, ReturnType<typeof setTimeout>>()
    );

    selectedSessionReference.current = selectedSessionKey;
    callbacksReference.current = { onError, onSettled };
    transportReference.current = transport;

    useEffect(() => {
        gateReference.current = undefined;
        setState(createChatRuntimeState(transport.connectionGeneration));
    }, [transport.connectionGeneration]);

    useEffect(() => {
        if (!transport.isConnected) {
            gateReference.current = undefined;
            return;
        }

        return transportReference.current.subscribe((event) => {
            const gate = gateReference.current;
            if (gate && event.sessionKey === gate.sessionKey) {
                gate.events.push(event);
                return;
            }

            setState((previous) => reduceChatRuntime(previous, [event]));
            if (event.kind !== "finish") {
                return;
            }
            const completedRunId = event.runId;
            if (completedRunId) {
                const key = `${event.sessionKey}\u{0}${completedRunId}`;
                const previous = completionTimersReference.current.get(key);
                if (previous !== undefined) {
                    clearTimeout(previous);
                }
                completionTimersReference.current.set(
                    key,
                    setTimeout(() => {
                        completionTimersReference.current.delete(key);
                        setState((current) =>
                            clearChatRun(current, event.sessionKey, completedRunId)
                        );
                    }, COMPLETED_RUN_RETENTION_MS)
                );
            }
            if (event.sessionKey === selectedSessionReference.current) {
                if (event.error) {
                    callbacksReference.current.onError?.(event.error);
                }
                callbacksReference.current.onSettled?.(event.sessionKey);
            }
        });
    }, [transport.connectionGeneration, transport.isConnected]);

    useEffect(() => {
        if (!transport.isConnected || !selectedSessionKey) {
            gateReference.current = undefined;
            return;
        }

        const token = ++gateTokenReference.current;
        const gate: SnapshotGate = {
            events: [],
            sessionKey: selectedSessionKey,
            token,
        };
        gateReference.current = gate;
        let isCancelled = false;

        void transportReference.current
            .snapshot(selectedSessionKey)
            .then((snapshot) => {
                if (
                    isCancelled ||
                    gateReference.current?.token !== token ||
                    gateReference.current.sessionKey !== selectedSessionKey
                ) {
                    return;
                }
                gateReference.current = undefined;
                const queuedAfterSnapshot = gate.events.filter(
                    (event) => event.sequence > snapshot.throughSequence
                );
                const events = [...snapshot.events, ...queuedAfterSnapshot];
                if (events.length > 0) {
                    setState((previous) => reduceChatRuntime(previous, events));
                }
            })
            .catch(() => {
                if (isCancelled || gateReference.current?.token !== token) {
                    return;
                }
                gateReference.current = undefined;
                if (gate.events.length > 0) {
                    setState((previous) => reduceChatRuntime(previous, gate.events));
                }
            });

        return () => {
            isCancelled = true;
            if (gateReference.current?.token === token) {
                const queued = gateReference.current.events;
                gateReference.current = undefined;
                if (queued.length > 0) {
                    setState((previous) => reduceChatRuntime(previous, queued));
                }
            }
        };
    }, [selectedSessionKey, transport.connectionGeneration, transport.isConnected]);

    useEffect(
        () => () => {
            for (const timer of completionTimersReference.current.values()) {
                clearTimeout(timer);
            }
            completionTimersReference.current.clear();
        },
        []
    );

    const beginRun = (sessionKey: string, runId: string, operation?: "compact") => {
        setState((current) =>
            addOptimisticChatRun(current, sessionKey, runId, operation)
        );
    };
    const acknowledgeRun = (
        sessionKey: string,
        optimisticRunId: string,
        providerRunId?: string
    ) => {
        setState((current) =>
            acknowledgeChatRun(current, sessionKey, optimisticRunId, providerRunId)
        );
    };
    const clearRun = (sessionKey: string, runId: string) => {
        setState((current) => clearChatRun(current, sessionKey, runId));
    };
    const clearSession = (sessionKey: string) => {
        setState((current) => clearChatSessionRuntime(current, sessionKey));
    };

    return { acknowledgeRun, beginRun, clearRun, clearSession, state };
}
