import { useEffect, useRef, useState } from "react";

import {
    acknowledgeChatRun,
    addOptimisticChatRun,
    type ChatRuntimeEvent,
    type ChatRuntimeState,
    clearChatRun,
    clearChatSessionRuntime,
    createChatRuntimeState,
    isProvisionalChatRunId,
    reduceChatRuntime,
} from "./domain/chatState";
import type { ChatTransport } from "./transport/chatTransport";

const COMPLETED_RUN_RETENTION_MS = 15 * 60_000;
const MAX_COMPLETION_TIMERS = 500;

function completedRunRetentionDelay(timestamp: string): number {
    const completedAt = Date.parse(timestamp);
    if (Number.isNaN(completedAt)) {
        return COMPLETED_RUN_RETENTION_MS;
    }
    return Math.min(
        COMPLETED_RUN_RETENTION_MS,
        Math.max(0, COMPLETED_RUN_RETENTION_MS - (Date.now() - completedAt))
    );
}

interface SnapshotGate {
    events: ChatRuntimeEvent[];
    optimisticRuns: Map<string, { operation?: "compact"; providerRunId?: string }>;
    sessionKey: string;
    token: number;
}

type FinishEvent = Extract<ChatRuntimeEvent, { kind: "finish" }>;

interface RuntimeReduction {
    finishes: Array<{ event: FinishEvent; state: ChatRuntimeState }>;
    state: ChatRuntimeState;
}

function reduceRuntimeEvents(
    previous: ChatRuntimeState,
    events: ChatRuntimeEvent[]
): RuntimeReduction {
    let state = previous;
    const finishes: RuntimeReduction["finishes"] = [];
    const orderedEvents = events.toSorted(
        (left, right) => left.sequence - right.sequence
    );
    for (const event of orderedEvents) {
        const next = reduceChatRuntime(state, [event]);
        if (next === state) {
            continue;
        }
        state = next;
        if (event.kind === "finish") {
            finishes.push({ event, state });
        }
    }
    return { finishes, state };
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
    // Gateway adapters may emit several events before React renders. This mirror
    // keeps every reduction based on the latest committed runtime value.
    const stateReference = useRef(state);
    const gateReference = useRef<SnapshotGate | undefined>(undefined);
    const gateTokenReference = useRef(0);
    const selectedSessionReference = useRef(selectedSessionKey);
    const callbacksReference = useRef({ onError, onSettled });
    const transportReference = useRef(transport);
    const completionTimersReference = useRef(
        new Map<string, { sequence: number; timer: ReturnType<typeof setTimeout> }>()
    );
    const handledFinishSequencesReference = useRef(new Set<number>());

    selectedSessionReference.current = selectedSessionKey;
    callbacksReference.current = { onError, onSettled };
    transportReference.current = transport;

    const updateState = (
        update: (current: ChatRuntimeState) => ChatRuntimeState
    ): ChatRuntimeState => {
        const next = update(stateReference.current);
        stateReference.current = next;
        setState(next);
        return next;
    };

    useEffect(() => {
        gateReference.current = undefined;
        handledFinishSequencesReference.current.clear();
        for (const entry of completionTimersReference.current.values()) {
            clearTimeout(entry.timer);
        }
        completionTimersReference.current.clear();
        updateState(() => createChatRuntimeState(transport.connectionGeneration));
    }, [transport.connectionGeneration]);

    const clearCompletionTimers = (shouldClear: (key: string) => boolean) => {
        for (const [key, entry] of completionTimersReference.current) {
            if (!shouldClear(key)) {
                continue;
            }
            clearTimeout(entry.timer);
            completionTimersReference.current.delete(key);
            handledFinishSequencesReference.current.delete(entry.sequence);
        }
    };

    const handleFinishSideEffects = (
        event: FinishEvent,
        stateAfterEvent: ChatRuntimeState
    ) => {
        if (handledFinishSequencesReference.current.has(event.sequence)) {
            return;
        }
        handledFinishSequencesReference.current.add(event.sequence);

        const completedRunId = event.runId;
        const key = `${event.sessionKey}\u{0}${completedRunId || `sequence:${event.sequence}`}`;
        const previous = completionTimersReference.current.get(key);
        if (previous !== undefined) {
            clearTimeout(previous.timer);
            handledFinishSequencesReference.current.delete(previous.sequence);
            completionTimersReference.current.delete(key);
        }
        const timer = setTimeout(() => {
            completionTimersReference.current.delete(key);
            handledFinishSequencesReference.current.delete(event.sequence);
            updateState((current) => {
                if (completedRunId) {
                    return clearChatRun(current, event.sessionKey, completedRunId);
                }
                const run = Object.values(
                    current.sessions[event.sessionKey]?.runs || {}
                ).find(
                    (candidate) =>
                        candidate.lastSequence === event.sequence &&
                        candidate.phase !== "active"
                );
                return run ? clearChatRun(current, event.sessionKey, run.runId) : current;
            });
        }, completedRunRetentionDelay(event.timestamp));
        completionTimersReference.current.set(key, { sequence: event.sequence, timer });
        while (completionTimersReference.current.size > MAX_COMPLETION_TIMERS) {
            const oldestKey = completionTimersReference.current.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            clearCompletionTimers((candidate) => candidate === oldestKey);
        }
        if (event.sessionKey === selectedSessionReference.current) {
            const completedRun = Object.values(
                stateAfterEvent.sessions[event.sessionKey]?.runs || {}
            ).find((run) => run.lastSequence === event.sequence);
            const { error: visibleError } = completedRun || event;
            if (visibleError) {
                callbacksReference.current.onError?.(visibleError);
            }
            callbacksReference.current.onSettled?.(event.sessionKey);
        }
    };

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

            const reduction = reduceRuntimeEvents(stateReference.current, [event]);
            updateState(() => reduction.state);
            for (const finish of reduction.finishes) {
                handleFinishSideEffects(finish.event, finish.state);
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
            optimisticRuns: new Map(),
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
                const sessionPrefix = `${selectedSessionKey}\u{0}`;
                clearCompletionTimers((key) => key.startsWith(sessionPrefix));
                const replayedSequences = new Set(
                    snapshot.events.map((event) => event.sequence)
                );
                const queuedAfterSnapshot = gate.events.filter(
                    (event) =>
                        event.sequence > snapshot.throughSequence ||
                        !replayedSequences.has(event.sequence)
                );
                const replayReduction = reduceRuntimeEvents(
                    clearChatSessionRuntime(stateReference.current, selectedSessionKey),
                    [...snapshot.events, ...queuedAfterSnapshot]
                );
                let next = replayReduction.state;
                const provisionalRuns =
                    gate.optimisticRuns.size === 1
                        ? Object.entries(
                              next.sessions[selectedSessionKey]?.runs || {}
                          ).filter(
                              ([, run]) =>
                                  run.phase === "active" &&
                                  isProvisionalChatRunId(selectedSessionKey, run.runId)
                          )
                        : [];
                const recoveredProvisionalRunKey =
                    provisionalRuns.length === 1 ? provisionalRuns[0]?.[0] : undefined;
                for (const [optimisticRunId, pendingRun] of gate.optimisticRuns) {
                    const runIds = new Set(
                        [optimisticRunId, pendingRun.providerRunId].filter(
                            (runId): runId is string => Boolean(runId)
                        )
                    );
                    const isRecovered = Object.entries(
                        next.sessions[selectedSessionKey]?.runs || {}
                    ).some(
                        ([runKey, run]) =>
                            runIds.has(runKey) ||
                            run.aliases.some((alias) => runIds.has(alias))
                    );
                    if (isRecovered) {
                        continue;
                    }
                    if (recoveredProvisionalRunKey) {
                        next = addOptimisticChatRun(
                            next,
                            selectedSessionKey,
                            optimisticRunId,
                            pendingRun.operation
                        );
                        next = acknowledgeChatRun(
                            next,
                            selectedSessionKey,
                            optimisticRunId,
                            recoveredProvisionalRunKey
                        );
                        next = acknowledgeChatRun(
                            next,
                            selectedSessionKey,
                            optimisticRunId,
                            pendingRun.providerRunId
                        );
                        continue;
                    }
                    next = addOptimisticChatRun(
                        next,
                        selectedSessionKey,
                        optimisticRunId,
                        pendingRun.operation
                    );
                    next = acknowledgeChatRun(
                        next,
                        selectedSessionKey,
                        optimisticRunId,
                        pendingRun.providerRunId
                    );
                }
                updateState(() => next);
                for (const finish of replayReduction.finishes) {
                    handleFinishSideEffects(finish.event, finish.state);
                }
            })
            .catch(() => {
                if (isCancelled || gateReference.current?.token !== token) {
                    return;
                }
                gateReference.current = undefined;
                if (gate.events.length > 0) {
                    const reduction = reduceRuntimeEvents(
                        stateReference.current,
                        gate.events
                    );
                    updateState(() => reduction.state);
                    for (const finish of reduction.finishes) {
                        handleFinishSideEffects(finish.event, finish.state);
                    }
                }
            });

        return () => {
            isCancelled = true;
            if (gateReference.current?.token === token) {
                const queued = gateReference.current.events;
                gateReference.current = undefined;
                if (queued.length > 0) {
                    const reduction = reduceRuntimeEvents(stateReference.current, queued);
                    updateState(() => reduction.state);
                    for (const finish of reduction.finishes) {
                        handleFinishSideEffects(finish.event, finish.state);
                    }
                }
            }
        };
    }, [selectedSessionKey, transport.connectionGeneration, transport.isConnected]);

    useEffect(
        () => () => {
            for (const entry of completionTimersReference.current.values()) {
                clearTimeout(entry.timer);
            }
            completionTimersReference.current.clear();
            handledFinishSequencesReference.current.clear();
        },
        []
    );

    const beginRun = (sessionKey: string, runId: string, operation?: "compact") => {
        if (gateReference.current?.sessionKey === sessionKey) {
            gateReference.current.optimisticRuns.set(runId, { operation });
        }
        updateState((current) =>
            addOptimisticChatRun(current, sessionKey, runId, operation)
        );
    };
    const acknowledgeRun = (
        sessionKey: string,
        optimisticRunId: string,
        providerRunId?: string
    ) => {
        const pendingRun =
            gateReference.current?.sessionKey === sessionKey
                ? gateReference.current.optimisticRuns.get(optimisticRunId)
                : undefined;
        if (pendingRun) {
            pendingRun.providerRunId = providerRunId;
        }
        updateState((current) =>
            acknowledgeChatRun(current, sessionKey, optimisticRunId, providerRunId)
        );
    };
    const clearRun = (sessionKey: string, runId: string) => {
        if (gateReference.current?.sessionKey === sessionKey) {
            for (const [optimisticRunId, pendingRun] of gateReference.current
                .optimisticRuns) {
                if (optimisticRunId === runId || pendingRun.providerRunId === runId) {
                    gateReference.current.optimisticRuns.delete(optimisticRunId);
                }
            }
        }
        const completionKey = `${sessionKey}\u{0}${runId}`;
        clearCompletionTimers((key) => key === completionKey);
        updateState((current) => clearChatRun(current, sessionKey, runId));
    };
    const clearSession = (sessionKey: string) => {
        if (gateReference.current?.sessionKey === sessionKey) {
            // A snapshot response captured before an abort/reset must not restore
            // the runtime state that this explicit clear just removed.
            gateReference.current = undefined;
        }
        const sessionPrefix = `${sessionKey}\u{0}`;
        clearCompletionTimers((key) => key.startsWith(sessionPrefix));
        updateState((current) => clearChatSessionRuntime(current, sessionKey));
    };

    return { acknowledgeRun, beginRun, clearRun, clearSession, state };
}
