import { useEffect, useRef, useState } from "react";

import {
    acknowledgeChatRun,
    addOptimisticChatRun,
    type ChatRunState,
    type ChatRuntimeEvent,
    type ChatRuntimeState,
    clearChatRun,
    clearChatSessionRuntime,
    createChatRuntimeState,
    findChatSessionRuntimeState,
    isProvisionalChatRunId,
    isSameChatSession,
    reduceChatRuntime,
} from "./domain/chatState";
import type { ChatTransport } from "./transport/chatTransport";

const COMPLETED_RUN_RETENTION_MS = 15 * 60_000;
const MAX_COMPLETION_TIMERS = 500;

function isLocallyOptimisticRunId(runId: string): boolean {
    return runId.startsWith("dashboard-chat-") || runId.startsWith("dashboard-compact-");
}

function isRunFinishedAtSequence(run: ChatRunState, sequence: number): boolean {
    return (
        run.phase !== "active" &&
        (run.terminalSequence === sequence || run.lastSequence === sequence)
    );
}

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
    reconnecting: boolean;
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

function carryActiveRunsToGeneration(
    state: ChatRuntimeState,
    generation: number
): ChatRuntimeState {
    const sessions = Object.fromEntries(
        Object.entries(state.sessions).flatMap(([sessionKey, session]) => {
            const runs = Object.fromEntries(
                Object.entries(session.runs).flatMap(([runKey, run]) => {
                    if (run.phase !== "active") {
                        return [];
                    }
                    const retained = { ...run, lastSequence: -1 };
                    delete retained.terminalSequence;
                    return [[runKey, retained]];
                })
            );
            return Object.keys(runs).length > 0
                ? [[sessionKey, { ...session, lastSequence: -1, runs }]]
                : [];
        })
    );
    return { generation, sessions };
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
    const reconnectGenerationReference = useRef<number | undefined>(undefined);
    const runtimeGenerationReference = useRef<string | undefined>(undefined);
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
        if (stateReference.current.generation === transport.connectionGeneration) {
            return;
        }
        reconnectGenerationReference.current = transport.connectionGeneration;
        handledFinishSequencesReference.current.clear();
        for (const entry of completionTimersReference.current.values()) {
            clearTimeout(entry.timer);
        }
        completionTimersReference.current.clear();
        updateState((current) =>
            carryActiveRunsToGeneration(current, transport.connectionGeneration)
        );
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

        const runtimeSession = findChatSessionRuntimeState(
            stateAfterEvent,
            event.sessionKey
        );
        const completedSessionKey = runtimeSession?.sessionKey || event.sessionKey;
        const completedRunId = event.runId;
        const key = `${completedSessionKey}\u{0}${completedRunId || `sequence:${event.sequence}`}`;
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
                    return clearChatRun(current, completedSessionKey, completedRunId);
                }
                const run = Object.values(
                    findChatSessionRuntimeState(current, completedSessionKey)?.runs || {}
                ).find((candidate) => isRunFinishedAtSequence(candidate, event.sequence));
                return run
                    ? clearChatRun(current, completedSessionKey, run.runId)
                    : current;
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
        if (isSameChatSession(event.sessionKey, selectedSessionReference.current)) {
            const completedRun = Object.values(runtimeSession?.runs || {}).find((run) =>
                isRunFinishedAtSequence(run, event.sequence)
            );
            const { error: visibleError } = completedRun || event;
            if (visibleError) {
                callbacksReference.current.onError?.(visibleError);
            }
            callbacksReference.current.onSettled?.(selectedSessionReference.current);
        }
    };

    useEffect(() => {
        if (!transport.isConnected) {
            gateReference.current = undefined;
            return;
        }

        return transportReference.current.subscribe((event) => {
            const gate = gateReference.current;
            if (gate && isSameChatSession(event.sessionKey, gate.sessionKey)) {
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
        const optimisticRuns: SnapshotGate["optimisticRuns"] = new Map();
        const existingSession = findChatSessionRuntimeState(
            stateReference.current,
            selectedSessionKey
        );
        const existingRuns = Object.entries(existingSession?.runs || {});
        for (const [runKey, run] of existingRuns) {
            if (run.phase !== "active") {
                continue;
            }
            const providerRunId = isLocallyOptimisticRunId(runKey) ? undefined : runKey;
            const optimisticAliases = new Set(
                [runKey, ...run.aliases].filter((runId) =>
                    isLocallyOptimisticRunId(runId)
                )
            );
            for (const optimisticRunId of optimisticAliases) {
                optimisticRuns.set(optimisticRunId, {
                    operation: run.operation,
                    providerRunId,
                });
            }
        }
        const gate: SnapshotGate = {
            events: [],
            optimisticRuns,
            reconnecting:
                reconnectGenerationReference.current === transport.connectionGeneration,
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
                if (
                    reconnectGenerationReference.current ===
                    transport.connectionGeneration
                ) {
                    reconnectGenerationReference.current = undefined;
                }
                const previousRuntimeGeneration = runtimeGenerationReference.current;
                const isBackendRestart = Boolean(
                    gate.reconnecting &&
                    snapshot.runtimeGeneration &&
                    previousRuntimeGeneration &&
                    snapshot.runtimeGeneration !== previousRuntimeGeneration
                );
                const shouldPreserveActiveRuns =
                    isBackendRestart ||
                    (gate.reconnecting &&
                        !snapshot.runtimeGeneration &&
                        snapshot.events.length === 0);
                if (snapshot.runtimeGeneration) {
                    runtimeGenerationReference.current = snapshot.runtimeGeneration;
                }
                const retainedSessionKey =
                    findChatSessionRuntimeState(
                        stateReference.current,
                        selectedSessionKey
                    )?.sessionKey || selectedSessionKey;
                const sessionPrefix = `${retainedSessionKey}\u{0}`;
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
                    shouldPreserveActiveRuns
                        ? stateReference.current
                        : clearChatSessionRuntime(
                              stateReference.current,
                              selectedSessionKey
                          ),
                    [...snapshot.events, ...queuedAfterSnapshot]
                );
                let next = replayReduction.state;
                const recoveredSession = findChatSessionRuntimeState(
                    next,
                    selectedSessionKey
                );
                const provisionalRuns =
                    gate.optimisticRuns.size === 1
                        ? Object.entries(recoveredSession?.runs || {}).filter(
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
                    const recoveredEntry = Object.entries(
                        findChatSessionRuntimeState(next, selectedSessionKey)?.runs || {}
                    ).find(
                        ([runKey, run]) =>
                            runIds.has(runKey) ||
                            run.aliases.some((alias) => runIds.has(alias))
                    );
                    if (recoveredEntry) {
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
                            recoveredEntry[0]
                        );
                        next = acknowledgeChatRun(
                            next,
                            selectedSessionKey,
                            optimisticRunId,
                            pendingRun.providerRunId
                        );
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
                if (
                    reconnectGenerationReference.current ===
                    transport.connectionGeneration
                ) {
                    reconnectGenerationReference.current = undefined;
                }
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
        const gate = gateReference.current;
        if (gate && isSameChatSession(gate.sessionKey, sessionKey)) {
            gate.optimisticRuns.set(runId, { operation });
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
        const gate = gateReference.current;
        const pendingRun =
            gate && isSameChatSession(gate.sessionKey, sessionKey)
                ? gate.optimisticRuns.get(optimisticRunId)
                : undefined;
        if (pendingRun) {
            pendingRun.providerRunId = providerRunId;
        }
        updateState((current) =>
            acknowledgeChatRun(current, sessionKey, optimisticRunId, providerRunId)
        );
    };
    const clearRun = (sessionKey: string, runId: string) => {
        const gate = gateReference.current;
        if (gate && isSameChatSession(gate.sessionKey, sessionKey)) {
            for (const [optimisticRunId, pendingRun] of gate.optimisticRuns) {
                if (optimisticRunId === runId || pendingRun.providerRunId === runId) {
                    gate.optimisticRuns.delete(optimisticRunId);
                }
            }
        }
        const canonicalSessionKey =
            findChatSessionRuntimeState(stateReference.current, sessionKey)?.sessionKey ||
            sessionKey;
        const completionKey = `${canonicalSessionKey}\u{0}${runId}`;
        clearCompletionTimers((key) => key === completionKey);
        updateState((current) => clearChatRun(current, sessionKey, runId));
    };
    const clearSession = (sessionKey: string) => {
        if (isSameChatSession(gateReference.current?.sessionKey, sessionKey)) {
            // A snapshot response captured before an abort/reset must not restore
            // the runtime state that this explicit clear just removed.
            gateReference.current = undefined;
        }
        const canonicalSessionKey =
            findChatSessionRuntimeState(stateReference.current, sessionKey)?.sessionKey ||
            sessionKey;
        const sessionPrefix = `${canonicalSessionKey}\u{0}`;
        clearCompletionTimers((key) => key.startsWith(sessionPrefix));
        updateState((current) => clearChatSessionRuntime(current, sessionKey));
    };

    return { acknowledgeRun, beginRun, clearRun, clearSession, state };
}
