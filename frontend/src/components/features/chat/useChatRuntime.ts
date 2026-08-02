import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { type ChatRuntimeActions, useChatRuntimeActions } from "./chatRuntimeActions";
import {
    carryActiveRunsToGeneration,
    type ControlEvent,
    type DisplacedReplayGroup,
    displacedReplayGroupForSession,
    type FinishEvent,
    isLocallyOptimisticRunId,
    reduceRuntimeEvents,
    type RuntimeIdentity,
    replayIdentityTransition,
    type SnapshotGate,
} from "./chatRuntimeReplay";
import {
    acknowledgeChatRun,
    addOptimisticChatRun,
    type ChatRuntimeState,
    clearChatSessionRuntime,
    clearCompletedChatRuns,
    createChatRuntimeState,
    findChatSessionRuntimeState,
    isProvisionalChatRunId,
    isSameChatSession,
} from "./domain/chatState";
import type { ChatTransport } from "./transport/chatTransport";

const MAX_HANDLED_FINISH_SEQUENCES = 500;

interface UseChatRuntimeOptions {
    onError?: (message: string) => void;
    onSettled?: (sessionKey: string) => void;
    selectedSessionKey: string;
    transport: ChatTransport;
}

export interface ChatRuntimeController extends ChatRuntimeActions {
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

    const handleControlSideEffect = (event: ControlEvent) => {
        if (isSameChatSession(event.sessionKey, selectedSessionRef.current)) {
            callbacksRef.current.onSettled?.(selectedSessionRef.current);
        }
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

            const previousState = stateRef.current;
            const reduction = reduceRuntimeEvents(previousState, [event]);
            updateState(() => reduction.state);
            if (event.kind === "control" && reduction.state !== previousState) {
                handleControlSideEffect(event);
            }
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
                for (const event of queuedAfterSnapshot) {
                    if (event.kind === "control") {
                        handleControlSideEffect(event);
                    }
                }
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
                    for (const event of gate.events) {
                        if (event.kind === "control") {
                            handleControlSideEffect(event);
                        }
                    }
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
                    for (const event of queued) {
                        if (event.kind === "control") {
                            handleControlSideEffect(event);
                        }
                    }
                    for (const finish of reduction.finishes) {
                        handleFinishSideEffects(finish.event, finish.state);
                    }
                }
            }
        };
    }, [selectedSessionKey, transport.connectionGeneration, transport.isConnected]);

    useEffect(() => () => handledFinishSequencesRef.current.clear(), []);

    const actions = useChatRuntimeActions({
        displacedCompletedRunsRef,
        gateRef,
        updateState,
    });

    return {
        ...actions,
        state,
    };
}
