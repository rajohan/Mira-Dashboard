import { currentIsoString } from "../../../../utils/date";
import {
    latestAssistantBoundarySequence,
    mergeMessageDetails,
} from "./chatStateAssistant";
import {
    mergeRunAssistantSegments,
    mergeRunCommentary,
    mergeRunDiagnostics,
    mergeRunUserMessages,
} from "./chatStateDiagnostics";
import {
    type ChatRunState,
    type ChatRuntimeState,
    type ChatSessionRuntimeState,
    emptyRun,
    matchingSessionEntry,
    mergeChatStreamText,
    preferredSessionKey,
    uniqueChatRunIds,
} from "./chatStateModel";

function mergeAcknowledgedRuns(
    existing: ChatRunState,
    optimistic: ChatRunState,
    providerRunId: string
): ChatRunState {
    const isOptimisticNewer = optimistic.lastSequence > existing.lastSequence;
    const older = isOptimisticNewer ? existing : optimistic;
    const newer = isOptimisticNewer ? optimistic : existing;
    const assistant =
        older.assistant && newer.assistant
            ? mergeMessageDetails(
                  older.assistant,
                  newer.assistant,
                  mergeChatStreamText(older.assistant.text, newer.assistant.text)
              )
            : newer.assistant || older.assistant;
    const assistantSequence = Math.max(
        existing.assistantSequence ?? -1,
        optimistic.assistantSequence ?? -1
    );
    const assistantBoundarySequence = Math.max(
        latestAssistantBoundarySequence(existing),
        latestAssistantBoundarySequence(optimistic)
    );
    const startedAt = (
        Date.parse(existing.startedAt) <= Date.parse(optimistic.startedAt)
            ? existing
            : optimistic
    ).startedAt;
    let terminalSequence = existing.terminalSequence ?? optimistic.terminalSequence;
    if (
        existing.terminalSequence !== undefined &&
        optimistic.terminalSequence !== undefined
    ) {
        terminalSequence = Math.max(
            existing.terminalSequence,
            optimistic.terminalSequence
        );
    }
    const terminalRun = [existing, optimistic]
        .filter((run) => run.phase !== "active")
        .toSorted(
            (left, right) =>
                (right.terminalSequence ?? right.lastSequence) -
                (left.terminalSequence ?? left.lastSequence)
        )[0];
    const phase = terminalRun?.phase ?? newer.phase;
    const latestContentRun = [existing, optimistic]
        .filter((run) => run.lastContentSequence !== undefined)
        .toSorted(
            (left, right) =>
                (right.lastContentSequence ?? -1) - (left.lastContentSequence ?? -1)
        )[0];

    return {
        ...newer,
        aliases: uniqueChatRunIds([
            ...existing.aliases,
            ...optimistic.aliases,
            optimistic.runId,
            providerRunId,
        ]),
        assistant,
        assistantBoundarySequence:
            assistantBoundarySequence === -1 ? undefined : assistantBoundarySequence,
        assistantSegments: mergeRunAssistantSegments(older, newer),
        assistantSequence: assistantSequence === -1 ? undefined : assistantSequence,
        assistantSource: newer.assistantSource || older.assistantSource,
        commentary: mergeRunCommentary(older, newer),
        diagnostics: mergeRunDiagnostics(older, newer),
        error: (terminalRun ?? newer).error,
        lastContentKind: latestContentRun?.lastContentKind,
        lastContentSequence: latestContentRun?.lastContentSequence,
        lastSequence: Math.max(existing.lastSequence, optimistic.lastSequence),
        operation: newer.operation ?? older.operation,
        operationPhase: newer.operationPhase ?? older.operationPhase,
        operationUpdatedAt: newer.operationUpdatedAt ?? older.operationUpdatedAt,
        phase,
        runId: providerRunId,
        startedAt,
        statusText: phase === "active" ? newer.statusText || older.statusText : undefined,
        terminalAt: terminalRun?.terminalAt ?? newer.terminalAt ?? older.terminalAt,
        terminalSequence,
        toolFailure: newer.toolFailure || older.toolFailure || undefined,
        userMessages: mergeRunUserMessages(older, newer),
    };
}
/**
 * Adds an optimistic run before the provider acknowledges its canonical id.
 * @returns Add optimistic chat run result.
 */
export function addOptimisticChatRun(
    state: ChatRuntimeState,
    sessionKey: string,
    runId: string,
    operation?: "compact"
): ChatRuntimeState {
    const timestamp = currentIsoString();
    const previousEntry = matchingSessionEntry(state, sessionKey);
    const previousSessionKey = previousEntry?.[0];
    const previousSession = previousEntry?.[1];
    const canonicalSessionKey = previousSessionKey
        ? preferredSessionKey(previousSessionKey, sessionKey)
        : sessionKey;
    const session: ChatSessionRuntimeState = previousSession
        ? {
              ...previousSession,
              controls: [...previousSession.controls],
              sessionKey: canonicalSessionKey,
              runs: Object.fromEntries(
                  Object.entries(previousSession.runs).map(([key, run]) => [
                      key,
                      {
                          ...run,
                          assistantSegments: [...(run.assistantSegments || [])],
                          commentary: [...run.commentary],
                          diagnostics: [...run.diagnostics],
                          sessionKey: canonicalSessionKey,
                          userMessages: [...run.userMessages],
                      },
                  ])
              ),
          }
        : {
              controls: [],
              lastSequence: -1,
              runs: {},
              sessionKey: canonicalSessionKey,
          };
    const existingEntry = Object.entries(session.runs).find(
        ([key, run]) => key === runId || run.aliases.includes(runId)
    );
    if (existingEntry) {
        const [existingKey, existingRun] = existingEntry;
        let statusText = existingRun.statusText;
        if (existingRun.phase === "active") {
            statusText =
                operation === "compact"
                    ? "Compacting context"
                    : (existingRun.statusText ?? "Thinking");
        }
        session.runs[existingKey] = {
            ...existingRun,
            operation: operation ?? existingRun.operation,
            operationPhase:
                operation === "compact" ? "active" : existingRun.operationPhase,
            operationUpdatedAt:
                operation === "compact" ? timestamp : existingRun.operationUpdatedAt,
            statusText,
        };
    } else {
        session.runs[runId] = {
            ...emptyRun(canonicalSessionKey, runId, session.lastSequence, timestamp),
            operation,
            operationPhase: operation === "compact" ? "active" : undefined,
            operationUpdatedAt: operation === "compact" ? timestamp : undefined,
            statusText: operation === "compact" ? "Compacting context" : "Thinking",
        };
    }
    const sessions = { ...state.sessions };
    if (previousSessionKey && previousSessionKey !== canonicalSessionKey) {
        delete sessions[previousSessionKey];
    }
    sessions[canonicalSessionKey] = session;
    return { ...state, sessions };
}

/**
 * Promotes one optimistic run to the provider run id without changing row order.
 * @returns Acknowledge chat run result.
 */
export function acknowledgeChatRun(
    state: ChatRuntimeState,
    sessionKey: string,
    optimisticRunId: string,
    providerRunId?: string
): ChatRuntimeState {
    if (!providerRunId) {
        return state;
    }
    const previousEntry = matchingSessionEntry(state, sessionKey);
    const previousSessionKey = previousEntry?.[0];
    const previousSession = previousEntry?.[1];
    const optimisticEntry = Object.entries(previousSession?.runs || {}).find(
        ([key, run]) => key === optimisticRunId || run.aliases.includes(optimisticRunId)
    );
    if (!previousSession || !optimisticEntry) {
        return state;
    }
    const [optimisticKey, optimistic] = optimisticEntry;
    const runs = { ...previousSession.runs };
    delete runs[optimisticKey];
    const existing = runs[providerRunId];
    runs[providerRunId] = existing
        ? mergeAcknowledgedRuns(existing, optimistic, providerRunId)
        : {
              ...optimistic,
              aliases: uniqueChatRunIds([
                  ...optimistic.aliases,
                  optimisticRunId,
                  providerRunId,
              ]),
              runId: providerRunId,
          };
    const canonicalSessionKey = previousSessionKey
        ? preferredSessionKey(previousSessionKey, sessionKey)
        : sessionKey;
    const sessions = { ...state.sessions };
    if (previousSessionKey && previousSessionKey !== canonicalSessionKey) {
        delete sessions[previousSessionKey];
    }
    sessions[canonicalSessionKey] = {
        ...previousSession,
        runs: Object.fromEntries(
            Object.entries(runs).map(([key, run]) => [
                key,
                { ...run, sessionKey: canonicalSessionKey },
            ])
        ),
        sessionKey: canonicalSessionKey,
    };
    return { ...state, sessions };
}

export function clearChatRun(
    state: ChatRuntimeState,
    sessionKey: string,
    runId: string
): ChatRuntimeState {
    const previousEntry = matchingSessionEntry(state, sessionKey);
    if (!previousEntry) {
        return state;
    }
    const [previousSessionKey, previousSession] = previousEntry;
    const runs = Object.fromEntries(
        Object.entries(previousSession.runs).filter(
            ([key, run]) => key !== runId && !run.aliases.includes(runId)
        )
    );
    return {
        ...state,
        sessions: {
            ...state.sessions,
            [previousSessionKey]: { ...previousSession, runs },
        },
    };
}

/**
 * Removes the previous completed replay when a new local run starts.
 * @returns Clear completed chat runs result.
 */
export function clearCompletedChatRuns(
    state: ChatRuntimeState,
    sessionKey: string
): ChatRuntimeState {
    const previousEntry = matchingSessionEntry(state, sessionKey);
    if (!previousEntry) {
        return state;
    }
    const [previousSessionKey, previousSession] = previousEntry;
    const runs = Object.fromEntries(
        Object.entries(previousSession.runs).filter(([, run]) => run.phase === "active")
    );
    if (Object.keys(runs).length === Object.keys(previousSession.runs).length) {
        return state;
    }
    return {
        ...state,
        sessions: {
            ...state.sessions,
            [previousSessionKey]: { ...previousSession, runs },
        },
    };
}

/**
 * Returns the immutable completed replay displaced by a new optimistic send.
 * @returns the immutable completed replay displaced by a new optimistic send.
 */
export function completedChatRuns(
    state: ChatRuntimeState,
    sessionKey: string
): Record<string, ChatRunState> {
    const session = matchingSessionEntry(state, sessionKey)?.[1];
    return Object.fromEntries(
        Object.entries(session?.runs || {}).filter(([, run]) => run.phase !== "active")
    );
}

/**
 * Restores a displaced replay without replacing newer live runtime state.
 * @returns Restore chat runs result.
 */
export function restoreChatRuns(
    state: ChatRuntimeState,
    sessionKey: string,
    restoredRuns: Readonly<Record<string, ChatRunState>>
): ChatRuntimeState {
    if (Object.keys(restoredRuns).length === 0) {
        return state;
    }
    const previousEntry = matchingSessionEntry(state, sessionKey);
    const previousSessionKey = previousEntry?.[0] ?? sessionKey;
    const previousSession = previousEntry?.[1] ?? {
        controls: [],
        lastSequence: -1,
        runs: {},
        sessionKey,
    };
    const runs = { ...restoredRuns, ...previousSession.runs };
    return {
        ...state,
        sessions: {
            ...state.sessions,
            [previousSessionKey]: { ...previousSession, runs },
        },
    };
}

/**
 * Removes status-only runs that projection has already classified as stale.
 * @returns Clear status only chat runs result.
 */
export function clearStatusOnlyChatRuns(
    state: ChatRuntimeState,
    sessionKey: string
): ChatRuntimeState {
    const previousEntry = matchingSessionEntry(state, sessionKey);
    if (!previousEntry) {
        return state;
    }
    const [previousSessionKey, previousSession] = previousEntry;
    const runs = Object.fromEntries(
        Object.entries(previousSession.runs).filter(
            ([, run]) =>
                run.phase !== "active" ||
                Boolean(run.assistant) ||
                run.diagnostics.length > 0 ||
                run.userMessages.length > 0
        )
    );
    if (Object.keys(runs).length === Object.keys(previousSession.runs).length) {
        return state;
    }
    return {
        ...state,
        sessions: {
            ...state.sessions,
            [previousSessionKey]: { ...previousSession, runs },
        },
    };
}

export function clearChatSessionRuntime(
    state: ChatRuntimeState,
    sessionKey: string
): ChatRuntimeState {
    const previousEntry = matchingSessionEntry(state, sessionKey);
    if (!previousEntry) {
        return state;
    }
    const sessions = { ...state.sessions };
    delete sessions[previousEntry[0]];
    return { ...state, sessions };
}
