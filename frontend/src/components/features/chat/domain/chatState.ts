import { applyAssistantEvent } from "./chatStateAssistant";
import {
    applyCommentaryEvent,
    applyControlEvent,
    applyDiagnosticEvent,
    applyUserEvent,
} from "./chatStateDiagnostics";
import { acknowledgeChatRun } from "./chatStateLifecycle";
import {
    type ChatOperationPhase,
    type ChatRunPhase,
    type ChatRunState,
    type ChatRuntimeEvent,
    type ChatRuntimeState,
    type ChatSessionRuntimeState,
    matchingRunKey,
    matchingSessionEntry,
    preferredSessionKey,
    resolveRun,
    runContentKind,
    uniqueChatRunIds,
} from "./chatStateModel";

export {
    MAX_CHAT_RUNTIME_COMMENTARY_PER_RUN,
    MAX_CHAT_RUNTIME_CONTROLS_PER_SESSION,
    MAX_CHAT_RUNTIME_DIAGNOSTICS_PER_RUN,
    createChatRuntimeState,
    findChatSessionRuntimeState,
    isProvisionalChatRunId,
    isSameChatSession,
    mergeChatStreamText,
    uniqueChatRunIds,
} from "./chatStateModel";
export type {
    ChatOperationPhase,
    ChatRunPhase,
    ChatRunState,
    ChatRuntimeEvent,
    ChatRuntimeMessageEntry,
    ChatRuntimeState,
    ChatSessionRuntimeState,
    ChatTextSource,
} from "./chatStateModel";
export {
    acknowledgeChatRun,
    addOptimisticChatRun,
    clearChatRun,
    clearChatSessionRuntime,
    clearCompletedChatRuns,
    clearStatusOnlyChatRuns,
    completedChatRuns,
    restoreChatRuns,
} from "./chatStateLifecycle";

/**
 * Resolves the run outcome represented by a status event.
 *
 * @param currentPhase - Existing run phase.
 * @param hasOperation - Whether the event describes an active operation.
 * @param operationPhase - Canonical operation phase after applying the event.
 * @returns Run phase to store.
 */
function statusOperationOutcome(
    currentPhase: ChatRunPhase,
    hasOperation: boolean,
    operationPhase: ChatOperationPhase | undefined
): ChatRunPhase {
    if (!hasOperation) {
        return currentPhase;
    }
    if (operationPhase === "active" || operationPhase === "retrying") {
        return "active";
    }
    return operationPhase === "complete" ? "completed" : "aborted";
}
function applyFinishEvent(
    run: ChatRunState,
    event: Extract<ChatRuntimeEvent, { kind: "finish" }>
): ChatRunState {
    const isLateToolFailureAfterCompletedFinal = Boolean(
        run.phase === "completed" &&
        event.outcome === "error" &&
        event.toolFailure &&
        !event.message
    );
    if (isLateToolFailureAfterCompletedFinal) {
        return {
            ...run,
            error: undefined,
            statusText: undefined,
            toolFailure: true,
        };
    }
    const isMetadataCompletion =
        run.phase !== "active" &&
        event.outcome === "completed" &&
        !event.authoritative &&
        !event.error &&
        !event.message;
    if (isMetadataCompletion) {
        return { ...run, statusText: undefined };
    }

    const isToolFailure = Boolean(run.toolFailure || event.toolFailure);
    const error = isToolFailure ? undefined : event.error;

    const withMessage = event.message
        ? applyAssistantEvent(
              { ...run, phase: event.outcome },
              {
                  ...event,
                  kind: "assistant",
                  message: event.message,
                  mode: "replace",
                  source: "chat",
              }
          )
        : run;
    const isPendingCompaction =
        run.operation === "compact" &&
        (run.operationPhase === "active" || run.operationPhase === "retrying");
    let operationPhase = run.operationPhase;
    if (isPendingCompaction) {
        operationPhase = event.outcome === "completed" ? "complete" : "inactive";
    }
    const shouldFinalizeAssistantSegment =
        !event.message || withMessage.assistantSegments !== run.assistantSegments;
    return {
        ...withMessage,
        assistant: withMessage.assistant
            ? {
                  ...withMessage.assistant,
                  isFinal: event.outcome === "completed",
              }
            : undefined,
        assistantSegments: shouldFinalizeAssistantSegment
            ? withMessage.assistantSegments?.map((entry, index, entries) =>
                  index === entries.length - 1
                      ? {
                            ...entry,
                            message: {
                                ...entry.message,
                                isFinal: event.outcome === "completed" || undefined,
                            },
                        }
                      : entry
              )
            : withMessage.assistantSegments,
        error,
        operationPhase,
        operationUpdatedAt: isPendingCompaction
            ? event.timestamp
            : run.operationUpdatedAt,
        phase: event.outcome,
        statusText: undefined,
        terminalAt: event.timestamp,
        terminalSequence: event.sequence,
        toolFailure: isToolFailure || undefined,
    };
}

function adjacentCompactionRunEntry(
    session: ChatSessionRuntimeState,
    event: ChatRuntimeEvent
): [string, ChatRunState] | undefined {
    if (event.kind !== "finish" || event.message || !event.settlesCompactionRunId) {
        return undefined;
    }
    const exactRunKey = matchingRunKey(session, event.settlesCompactionRunId);
    const exactRun = exactRunKey ? session.runs[exactRunKey] : undefined;
    if (
        exactRunKey &&
        exactRun?.operation === "compact" &&
        exactRun.lastSequence === session.lastSequence
    ) {
        return [exactRunKey, exactRun];
    }
    const parentRunKey = event.runId ? matchingRunKey(session, event.runId) : undefined;
    const parentRun = parentRunKey ? session.runs[parentRunKey] : undefined;
    let activeParentRuns: ChatRunState[];
    if (event.runId) {
        activeParentRuns =
            parentRun && parentRun.operation !== "compact" && parentRun.phase === "active"
                ? [parentRun]
                : [];
    } else {
        activeParentRuns = Object.values(session.runs).filter(
            (run) => run.operation !== "compact" && run.phase === "active"
        );
    }
    if (activeParentRuns.length !== 1) {
        return undefined;
    }
    const adjacentCompactionRuns = Object.entries(session.runs).filter(
        ([, run]) =>
            run.operation === "compact" && run.lastSequence === session.lastSequence
    );
    return adjacentCompactionRuns.length === 1 ? adjacentCompactionRuns[0] : undefined;
}

/**
 * Consumes a successful nested lifecycle so it cannot terminalize the parent run.
 * Failed lifecycles update the compaction row but continue into the parent reducer.
 * @returns Whether the nested lifecycle event was consumed.
 */
function consumeAdjacentCompactionLifecycle(
    session: ChatSessionRuntimeState,
    event: ChatRuntimeEvent
): boolean {
    const compactionEntry = adjacentCompactionRunEntry(session, event);
    if (!compactionEntry || event.kind !== "finish") {
        return false;
    }
    const [runKey, run] = compactionEntry;
    if (run.operationPhase === "active" || run.operationPhase === "retrying") {
        session.runs[runKey] = {
            ...run,
            error: event.error,
            lastSequence: event.sequence,
            operationPhase: event.outcome === "completed" ? "complete" : "inactive",
            operationUpdatedAt: event.timestamp,
            phase: event.outcome,
            statusText: undefined,
            terminalAt: event.timestamp,
            terminalSequence: event.sequence,
            updatedAt: event.timestamp,
        };
    }
    return event.outcome === "completed";
}

function commitChatSession(
    state: ChatRuntimeState,
    previousSessionKey: string | undefined,
    session: ChatSessionRuntimeState
): ChatRuntimeState {
    const sessions = { ...state.sessions };
    if (previousSessionKey && previousSessionKey !== session.sessionKey) {
        delete sessions[previousSessionKey];
    }
    sessions[session.sessionKey] = session;
    return { ...state, sessions };
}

/**
 * Applies normalized runtime events deterministically and idempotently.
 * @returns Reduce chat runtime result.
 */
export function reduceChatRuntime(
    state: ChatRuntimeState,
    events: ChatRuntimeEvent[]
): ChatRuntimeState {
    let nextState = state;
    const orderedEvents = [...events].toSorted(
        (left, right) => left.sequence - right.sequence
    );
    for (const event of orderedEvents) {
        const currentSession = matchingSessionEntry(nextState, event.sessionKey)?.[1];
        if (currentSession && event.sequence <= currentSession.lastSequence) {
            continue;
        }
        if (event.runId) {
            const runAliases = uniqueChatRunIds(event.runAliases || []);
            for (const alias of runAliases) {
                if (alias !== event.runId) {
                    nextState = acknowledgeChatRun(
                        nextState,
                        event.sessionKey,
                        alias,
                        event.runId
                    );
                }
            }
        }
        const previousEntry = matchingSessionEntry(nextState, event.sessionKey);
        const previousSessionKey = previousEntry?.[0];
        const previousSession = previousEntry?.[1];
        const sessionKey = previousSessionKey
            ? preferredSessionKey(previousSessionKey, event.sessionKey)
            : event.sessionKey;
        const normalizedEvent =
            event.sessionKey === sessionKey ? event : { ...event, sessionKey };

        const session: ChatSessionRuntimeState = previousSession
            ? {
                  ...previousSession,
                  controls: [...previousSession.controls],
                  sessionKey,
                  runs: Object.fromEntries(
                      Object.entries(previousSession.runs).map(([key, run]) => [
                          key,
                          {
                              ...run,
                              assistantSegments: [...(run.assistantSegments || [])],
                              commentary: [...run.commentary],
                              diagnostics: [...run.diagnostics],
                              sessionKey,
                              userMessages: [...run.userMessages],
                          },
                      ])
                  ),
              }
            : { controls: [], lastSequence: -1, runs: {}, sessionKey };
        const consumedAdjacentCompaction = consumeAdjacentCompactionLifecycle(
            session,
            normalizedEvent
        );
        if (consumedAdjacentCompaction) {
            session.lastSequence = normalizedEvent.sequence;
            nextState = commitChatSession(nextState, previousSessionKey, session);
            continue;
        }
        if (normalizedEvent.kind === "control") {
            session.controls = applyControlEvent(session.controls, normalizedEvent);
            session.lastSequence = normalizedEvent.sequence;
            nextState = commitChatSession(nextState, previousSessionKey, session);
            continue;
        }
        const resolved = resolveRun(session, normalizedEvent);
        session.lastSequence = normalizedEvent.sequence;
        if (!resolved) {
            nextState = commitChatSession(nextState, previousSessionKey, session);
            continue;
        }

        const run = applyRunEvent(resolved.run, normalizedEvent);
        const contentKind = runContentKind(normalizedEvent);

        session.runs[resolved.runKey] = {
            ...run,
            aliases: uniqueChatRunIds([...run.aliases, normalizedEvent.runId]),
            lastContentKind: contentKind ?? run.lastContentKind,
            lastContentSequence: contentKind
                ? normalizedEvent.sequence
                : run.lastContentSequence,
            lastSequence: normalizedEvent.sequence,
            updatedAt: normalizedEvent.timestamp,
        };
        nextState = commitChatSession(nextState, previousSessionKey, session);
    }
    return nextState;
}

function applyRunEvent(run: ChatRunState, event: ChatRuntimeEvent): ChatRunState {
    switch (event.kind) {
        case "identity": {
            return run;
        }
        case "user": {
            return applyUserEvent(run, event);
        }
        case "assistant": {
            return applyAssistantEvent(run, event);
        }
        case "commentary": {
            return applyCommentaryEvent(run, event);
        }
        case "thinking":
        case "tool": {
            return applyDiagnosticEvent(run, event);
        }
        case "status": {
            const operationPhase = event.operation
                ? (event.operationPhase ?? "active")
                : run.operationPhase;
            const isPendingOperation =
                operationPhase === "active" || operationPhase === "retrying";
            const operationOutcome = statusOperationOutcome(
                run.phase,
                Boolean(event.operation),
                operationPhase
            );
            let terminalAt = run.terminalAt;
            let terminalSequence = run.terminalSequence;
            if (event.operation) {
                terminalAt = isPendingOperation ? undefined : event.timestamp;
                terminalSequence = isPendingOperation ? undefined : event.sequence;
            }
            return {
                ...run,
                operation: event.operation ?? run.operation,
                error: isPendingOperation && event.operation ? undefined : run.error,
                operationPhase,
                operationUpdatedAt: event.operation
                    ? event.timestamp
                    : run.operationUpdatedAt,
                phase: operationOutcome,
                statusText: event.text,
                terminalAt,
                terminalSequence,
            };
        }
        case "control": {
            return run;
        }
        default: {
            return applyFinishEvent(run, event);
        }
    }
}
