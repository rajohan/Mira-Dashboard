import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
    acknowledgeChatRun,
    addOptimisticChatRun,
    type ChatRuntimeEvent,
    type ChatRuntimeState,
    clearChatRun,
    clearChatSessionRuntime,
    clearCompletedChatRuns,
    clearStatusOnlyChatRuns,
    completedChatRuns,
    createChatRuntimeState,
    findChatSessionRuntimeState,
    isProvisionalChatRunId,
    isSameChatSession,
    reduceChatRuntime,
    restoreChatRuns,
} from "./domain/chatState";
import type { ChatRuntimeSnapshot, ChatTransport } from "./transport/chatTransport";

const MAX_HANDLED_FINISH_SEQUENCES = 500;

function isLocallyOptimisticRunId(runId: string): boolean {
    return runId.startsWith("dashboard-chat-") || runId.startsWith("dashboard-compact-");
}

interface SnapshotGate {
    events: ChatRuntimeEvent[];
    optimisticRuns: Map<
        string,
        {
            observedAfterSnapshotRequest: boolean;
            operation?: "compact";
            providerRunId?: string;
        }
    >;
    reconnecting: boolean;
    sessionKey: string;
    token: number;
}

interface RuntimeIdentity {
    generation?: string;
    replayScope?: string;
}

function replayIdentityTransition(
    previous: RuntimeIdentity,
    snapshot: Pick<ChatRuntimeSnapshot, "replayScope" | "runtimeGeneration">,
    isReconnecting: boolean
): { didLoseContinuity: boolean; isSameScopeRestart: boolean } {
    const didGenerationChange = Boolean(
        snapshot.runtimeGeneration &&
        previous.generation &&
        snapshot.runtimeGeneration !== previous.generation
    );
    const isKnownSameScope = Boolean(
        snapshot.replayScope &&
        previous.replayScope &&
        snapshot.replayScope === previous.replayScope
    );
    const didKnownScopeChange = Boolean(
        snapshot.replayScope &&
        previous.replayScope &&
        snapshot.replayScope !== previous.replayScope
    );
    return {
        didLoseContinuity:
            isReconnecting &&
            (didKnownScopeChange || (didGenerationChange && !isKnownSameScope)),
        isSameScopeRestart: isReconnecting && didGenerationChange && isKnownSameScope,
    };
}

interface DisplacedReplayGroup {
    pendingRunIds: Set<string>;
    runs: ReturnType<typeof completedChatRuns>;
    sessionKey: string;
}

function displacedReplayGroupForSession(
    groups: Map<string, DisplacedReplayGroup>,
    sessionKey: string
): [string, DisplacedReplayGroup] | undefined {
    for (const entry of groups) {
        if (isSameChatSession(entry[1].sessionKey, sessionKey)) {
            return entry;
        }
    }
    return undefined;
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
                    const retained = {
                        ...run,
                        diagnostics: [...run.diagnostics],
                        lastSequence: -1,
                        userMessages: [...run.userMessages],
                    };
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
    acknowledgeRun: (
        sessionKey: string,
        optimisticRunId: string,
        providerRunId?: string
    ) => void;
    beginRun: (
        sessionKey: string,
        runId: string,
        options?: {
            operation?: "compact";
            replaceStatusOnlyRuns?: boolean;
        }
    ) => void;
    clearRun: (sessionKey: string, runId: string) => void;
    clearSession: (sessionKey: string) => void;
    failRun: (sessionKey: string, runId: string) => void;
    state: ChatRuntimeState;
}

/**
 * Owns replay/live ordering and canonical runtime state for every chat session.
 * @returns Chat runtime state and actions.
 */
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
    const stateRef = useRef(state);
    const gateRef = useRef<SnapshotGate | undefined>(undefined);
    const gateTokenRef = useRef(0);
    const reconnectGenerationRef = useRef<number | undefined>(undefined);
    const runtimeIdentityRef = useRef<RuntimeIdentity>({});
    const selectedSessionRef = useRef(selectedSessionKey);
    const callbacksRef = useRef({ onError, onSettled });
    const transportRef = useRef(transport);
    const handledFinishSequencesRef = useRef(new Set<string>());
    const displacedCompletedRunsRef = useRef(new Map<string, DisplacedReplayGroup>());

    useLayoutEffect(() => {
        selectedSessionRef.current = selectedSessionKey;
        callbacksRef.current = { onError, onSettled };
        transportRef.current = transport;
    }, [onError, onSettled, selectedSessionKey, transport]);

    const updateState = (
        update: (current: ChatRuntimeState) => ChatRuntimeState
    ): ChatRuntimeState => {
        const next = update(stateRef.current);
        stateRef.current = next;
        setState(next);
        return next;
    };

    useEffect(() => {
        gateRef.current = undefined;
        if (stateRef.current.generation === transport.connectionGeneration) {
            return;
        }
        reconnectGenerationRef.current = transport.connectionGeneration;
        handledFinishSequencesRef.current.clear();
        updateState((current) =>
            carryActiveRunsToGeneration(current, transport.connectionGeneration)
        );
    }, [transport.connectionGeneration]);

    const handleFinishSideEffects = (
        event: FinishEvent,
        stateAfterEvent: ChatRuntimeState
    ) => {
        if (!isSameChatSession(event.sessionKey, selectedSessionRef.current)) {
            return;
        }
        const finishKey = `${selectedSessionRef.current.trim().toLowerCase()}:${event.sequence}`;
        if (handledFinishSequencesRef.current.has(finishKey)) {
            return;
        }
        handledFinishSequencesRef.current.add(finishKey);
        while (handledFinishSequencesRef.current.size > MAX_HANDLED_FINISH_SEQUENCES) {
            const oldestFinishKey = handledFinishSequencesRef.current
                .values()
                .next().value;
            if (oldestFinishKey === undefined) {
                break;
            }
            handledFinishSequencesRef.current.delete(oldestFinishKey);
        }

        const runtimeSession = findChatSessionRuntimeState(
            stateAfterEvent,
            event.sessionKey
        );
        const completedRun = Object.values(runtimeSession?.runs || {}).find(
            (run) =>
                run.phase !== "active" &&
                (run.terminalSequence === event.sequence ||
                    run.lastSequence === event.sequence)
        );
        let visibleError = event.error;
        if (visibleError && completedRun) {
            visibleError = completedRun.error;
        }
        if (visibleError) {
            callbacksRef.current.onError?.(visibleError);
        }
        callbacksRef.current.onSettled?.(selectedSessionRef.current);
    };

    useEffect(() => {
        if (!transport.isConnected) {
            gateRef.current = undefined;
            return;
        }

        return transportRef.current.subscribe((event) => {
            const gate = gateRef.current;
            if (gate && isSameChatSession(event.sessionKey, gate.sessionKey)) {
                gate.events.push(event);
                return;
            }

            const reduction = reduceRuntimeEvents(stateRef.current, [event]);
            updateState(() => reduction.state);
            for (const finish of reduction.finishes) {
                handleFinishSideEffects(finish.event, finish.state);
            }
        });
    }, [transport.connectionGeneration, transport.isConnected]);

    useEffect(() => {
        if (!selectedSessionKey || !transport.isConnected) {
            gateRef.current = undefined;
            return;
        }

        const token = ++gateTokenRef.current;
        const optimisticRuns: SnapshotGate["optimisticRuns"] = new Map();
        const existingSession = findChatSessionRuntimeState(
            stateRef.current,
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
                    observedAfterSnapshotRequest: false,
                    operation: run.operation,
                    providerRunId,
                });
            }
        }
        const gate: SnapshotGate = {
            events: [],
            optimisticRuns,
            reconnecting:
                reconnectGenerationRef.current === transport.connectionGeneration,
            sessionKey: selectedSessionKey,
            token,
        };
        gateRef.current = gate;
        let isCancelled = false;

        void (async () => {
            try {
                const snapshot = await transportRef.current.snapshot(selectedSessionKey);
                if (
                    isCancelled ||
                    gateRef.current?.token !== token ||
                    gateRef.current.sessionKey !== selectedSessionKey
                ) {
                    return;
                }
                gateRef.current = undefined;
                if (reconnectGenerationRef.current === transport.connectionGeneration) {
                    reconnectGenerationRef.current = undefined;
                }
                const replayTransition = replayIdentityTransition(
                    runtimeIdentityRef.current,
                    snapshot,
                    gate.reconnecting
                );
                const shouldPreserveActiveRuns =
                    !snapshot.completed &&
                    gate.reconnecting &&
                    snapshot.events.length === 0 &&
                    !replayTransition.didLoseContinuity &&
                    (replayTransition.isSameScopeRestart || !snapshot.runtimeGeneration);
                if (snapshot.runtimeGeneration || snapshot.replayScope) {
                    runtimeIdentityRef.current = {
                        generation: snapshot.runtimeGeneration,
                        replayScope: snapshot.replayScope,
                    };
                }
                if (replayTransition.didLoseContinuity) {
                    const displacedGroup = displacedReplayGroupForSession(
                        displacedCompletedRunsRef.current,
                        selectedSessionKey
                    );
                    if (displacedGroup) {
                        displacedCompletedRunsRef.current.delete(displacedGroup[0]);
                    }
                }
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
                        ? stateRef.current
                        : clearChatSessionRuntime(stateRef.current, selectedSessionKey),
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
                    if (
                        replayTransition.didLoseContinuity &&
                        !pendingRun.observedAfterSnapshotRequest
                    ) {
                        continue;
                    }
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
                    if (snapshot.completed) {
                        if (
                            !pendingRun.observedAfterSnapshotRequest &&
                            pendingRun.providerRunId
                        ) {
                            continue;
                        }
                        next = clearCompletedChatRuns(next, selectedSessionKey);
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
            } catch {
                if (isCancelled || gateRef.current?.token !== token) {
                    return;
                }
                gateRef.current = undefined;
                if (reconnectGenerationRef.current === transport.connectionGeneration) {
                    reconnectGenerationRef.current = undefined;
                }
                if (gate.events.length > 0) {
                    const reduction = reduceRuntimeEvents(stateRef.current, gate.events);
                    updateState(() => reduction.state);
                    for (const finish of reduction.finishes) {
                        handleFinishSideEffects(finish.event, finish.state);
                    }
                }
            }
        })();

        return () => {
            isCancelled = true;
            if (gateRef.current?.token === token) {
                const queued = gateRef.current.events;
                gateRef.current = undefined;
                if (queued.length > 0) {
                    const reduction = reduceRuntimeEvents(stateRef.current, queued);
                    updateState(() => reduction.state);
                    for (const finish of reduction.finishes) {
                        handleFinishSideEffects(finish.event, finish.state);
                    }
                }
            }
        };
    }, [selectedSessionKey, transport.connectionGeneration, transport.isConnected]);

    useEffect(() => () => handledFinishSequencesRef.current.clear(), []);

    const beginRun: ChatRuntimeController["beginRun"] = (
        sessionKey,
        runId,
        options = {}
    ) => {
        const gate = gateRef.current;
        if (gate && isSameChatSession(gate.sessionKey, sessionKey)) {
            const pendingRun = gate.optimisticRuns.get(runId);
            gate.optimisticRuns.set(runId, {
                ...pendingRun,
                observedAfterSnapshotRequest: true,
                operation: options.operation ?? pendingRun?.operation,
            });
        }
        updateState((current) => {
            const existingGroup = displacedReplayGroupForSession(
                displacedCompletedRunsRef.current,
                sessionKey
            )?.[1];
            const displacedRuns = completedChatRuns(current, sessionKey);
            const group =
                existingGroup ||
                (Object.keys(displacedRuns).length > 0
                    ? {
                          pendingRunIds: new Set<string>(),
                          runs: displacedRuns,
                          sessionKey,
                      }
                    : undefined);
            if (group && !existingGroup) {
                displacedCompletedRunsRef.current.set(sessionKey, group);
            }
            group?.pendingRunIds.add(runId);
            const withoutStaleStatus = options.replaceStatusOnlyRuns
                ? clearStatusOnlyChatRuns(current, sessionKey)
                : current;
            return addOptimisticChatRun(
                clearCompletedChatRuns(withoutStaleStatus, sessionKey),
                sessionKey,
                runId,
                options.operation
            );
        });
    };
    const acknowledgeRun = (
        sessionKey: string,
        optimisticRunId: string,
        providerRunId?: string
    ) => {
        const displacedGroup = displacedReplayGroupForSession(
            displacedCompletedRunsRef.current,
            sessionKey
        );
        if (displacedGroup?.[1].pendingRunIds.has(optimisticRunId)) {
            displacedCompletedRunsRef.current.delete(displacedGroup[0]);
        }
        const gate = gateRef.current;
        const pendingRun =
            gate && isSameChatSession(gate.sessionKey, sessionKey)
                ? gate.optimisticRuns.get(optimisticRunId)
                : undefined;
        if (pendingRun) {
            pendingRun.observedAfterSnapshotRequest = true;
            pendingRun.providerRunId = providerRunId;
        }
        updateState((current) =>
            acknowledgeChatRun(current, sessionKey, optimisticRunId, providerRunId)
        );
    };
    const removeRunFromSnapshotGate = (sessionKey: string, runId: string) => {
        const gate = gateRef.current;
        if (gate && isSameChatSession(gate.sessionKey, sessionKey)) {
            for (const [optimisticRunId, pendingRun] of gate.optimisticRuns) {
                if (optimisticRunId === runId || pendingRun.providerRunId === runId) {
                    gate.optimisticRuns.delete(optimisticRunId);
                }
            }
        }
    };
    const clearRun = (sessionKey: string, runId: string) => {
        const displacedGroup = displacedReplayGroupForSession(
            displacedCompletedRunsRef.current,
            sessionKey
        );
        if (displacedGroup?.[1].pendingRunIds.has(runId)) {
            displacedCompletedRunsRef.current.delete(displacedGroup[0]);
        }
        removeRunFromSnapshotGate(sessionKey, runId);
        updateState((current) => clearChatRun(current, sessionKey, runId));
    };
    const failRun = (sessionKey: string, runId: string) => {
        removeRunFromSnapshotGate(sessionKey, runId);
        const displacedGroup = displacedReplayGroupForSession(
            displacedCompletedRunsRef.current,
            sessionKey
        );
        const displaced = displacedGroup?.[1];
        const didRemovePendingRun = displaced?.pendingRunIds.delete(runId) === true;
        const shouldRestore = didRemovePendingRun && displaced?.pendingRunIds.size === 0;
        if (displacedGroup && shouldRestore) {
            displacedCompletedRunsRef.current.delete(displacedGroup[0]);
        }
        updateState((current) => {
            const withoutFailedRun = clearChatRun(current, sessionKey, runId);
            return shouldRestore && displaced
                ? restoreChatRuns(withoutFailedRun, sessionKey, displaced.runs)
                : withoutFailedRun;
        });
    };
    const clearSession = (sessionKey: string) => {
        if (isSameChatSession(gateRef.current?.sessionKey, sessionKey)) {
            // A snapshot response captured before an abort/reset must not restore
            // the runtime state that this explicit clear just removed.
            gateRef.current = undefined;
        }
        for (const [groupKey, displaced] of displacedCompletedRunsRef.current) {
            if (isSameChatSession(displaced.sessionKey, sessionKey)) {
                displacedCompletedRunsRef.current.delete(groupKey);
            }
        }
        updateState((current) => clearChatSessionRuntime(current, sessionKey));
    };

    return {
        acknowledgeRun,
        beginRun,
        clearRun,
        clearSession,
        failRun,
        state,
    };
}
