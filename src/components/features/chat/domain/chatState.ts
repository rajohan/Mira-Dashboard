import { currentIsoString } from "../../../../utils/date";
import {
    type ChatHistoryMessage,
    type ChatThinkingDisplay,
    type ChatToolCallDisplay,
    type ChatToolResultDisplay,
    mergeChatAttachments,
    mergeChatImages,
} from "../chatTypes";
import { messageDeleteKey, stableChatStringify } from "../chatUtilities";

export type ChatRunPhase = "active" | "completed" | "aborted" | "error";
export type ChatTextSource = "chat" | "runtime" | "session";
export type ChatOperationPhase = "active" | "complete" | "inactive" | "retrying";

const SESSION_ECHO_WINDOW_MILLISECONDS = 60_000;

export interface ChatDiagnosticEntry {
    key: string;
    message: ChatHistoryMessage;
}

/** Canonical runtime state for one session-scoped run. */
export interface ChatRunState {
    aliases: string[];
    assistant?: ChatHistoryMessage;
    assistantSource?: ChatTextSource;
    diagnostics: ChatDiagnosticEntry[];
    error?: string;
    lastSequence: number;
    operation?: "compact";
    operationPhase?: ChatOperationPhase;
    operationUpdatedAt?: string;
    phase: ChatRunPhase;
    runId: string;
    sessionKey: string;
    startedAt: string;
    statusText?: string;
    terminalAt?: string;
    terminalSequence?: number;
    toolFailure?: boolean;
    updatedAt: string;
    userMessages: ChatDiagnosticEntry[];
}

export interface ChatSessionRuntimeState {
    lastSequence: number;
    runs: Record<string, ChatRunState>;
    sessionKey: string;
}

export interface ChatRuntimeState {
    generation: number;
    sessions: Record<string, ChatSessionRuntimeState>;
}

interface RuntimeEventBase {
    runId?: string;
    sequence: number;
    sessionKey: string;
    timestamp: string;
}

export type ChatRuntimeEvent =
    | (RuntimeEventBase & {
          kind: "user";
          message: ChatHistoryMessage;
      })
    | (RuntimeEventBase & {
          kind: "assistant";
          message: ChatHistoryMessage;
          mode: "append" | "merge" | "replace";
          source: ChatTextSource;
      })
    | (RuntimeEventBase & {
          kind: "thinking";
          message: ChatHistoryMessage;
      })
    | (RuntimeEventBase & {
          kind: "tool";
          message: ChatHistoryMessage;
          toolKey: string;
      })
    | (RuntimeEventBase & {
          kind: "status";
          operation?: "compact";
          operationPhase?: ChatOperationPhase;
          text?: string;
      })
    | (RuntimeEventBase & {
          authoritative?: boolean;
          kind: "finish";
          error?: string;
          message?: ChatHistoryMessage;
          outcome: Exclude<ChatRunPhase, "active">;
          settlesCompaction?: boolean;
          toolFailure?: boolean;
      });

export function createChatRuntimeState(generation = 0): ChatRuntimeState {
    return { generation, sessions: {} };
}

export function isSameChatSession(left?: string, right?: string): boolean {
    const normalizedLeft = left?.trim().toLowerCase();
    const normalizedRight = right?.trim().toLowerCase();
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }
    if (normalizedLeft === normalizedRight) {
        return true;
    }

    const leftMatch = normalizedLeft.match(/^agent:([^:]+):(.+)$/u);
    const rightMatch = normalizedRight.match(/^agent:([^:]+):(.+)$/u);
    if (leftMatch && rightMatch) {
        return leftMatch[1] === rightMatch[1] && leftMatch[2] === rightMatch[2];
    }
    return leftMatch
        ? leftMatch[2] === normalizedRight
        : rightMatch?.[2] === normalizedLeft;
}

function matchingSessionEntry(
    state: ChatRuntimeState,
    sessionKey: string
): [string, ChatSessionRuntimeState] | undefined {
    const exact = state.sessions[sessionKey];
    if (exact) {
        return [sessionKey, exact];
    }
    const matches = Object.entries(state.sessions).filter(([candidate]) =>
        isSameChatSession(candidate, sessionKey)
    );
    return matches.length === 1 ? matches[0] : undefined;
}

function preferredSessionKey(existingKey: string, incomingKey: string): string {
    return /^agent:[^:]+:.+$/iu.test(incomingKey.trim()) ? incomingKey : existingKey;
}

/** Resolves an exact or unambiguous provider session alias for presentation. */
export function findChatSessionRuntimeState(
    state: ChatRuntimeState,
    sessionKey: string
): ChatSessionRuntimeState | undefined {
    return matchingSessionEntry(state, sessionKey)?.[1];
}

export function uniqueChatRunIds(values: Array<string | undefined>): string[] {
    return [...new Set(values.filter(Boolean))] as string[];
}

export function mergeChatStreamText(previous: string, next: string): string {
    if (!next) {
        return previous;
    }
    if (!previous || next.startsWith(previous)) {
        return next;
    }
    if (previous.endsWith(next)) {
        return previous;
    }
    return `${previous}${next}`;
}

export function isProvisionalChatRunId(sessionKey: string, runId: string): boolean {
    return (
        isSameChatSession(sessionKey, runId) ||
        runId.startsWith("dashboard-chat-") ||
        runId.startsWith("dashboard-compact-") ||
        runId.startsWith("runtime-runless-")
    );
}

function emptyRun(
    sessionKey: string,
    runId: string,
    sequence: number,
    timestamp: string
): ChatRunState {
    return {
        aliases: [runId],
        diagnostics: [],
        lastSequence: sequence,
        phase: "active",
        runId,
        sessionKey,
        startedAt: timestamp,
        updatedAt: timestamp,
        userMessages: [],
    };
}

function matchingRunKey(
    session: ChatSessionRuntimeState,
    runId: string | undefined
): string | undefined {
    if (runId) {
        return Object.entries(session.runs).find(
            ([key, run]) => key === runId || run.aliases.includes(runId)
        )?.[0];
    }

    const activeRuns = Object.entries(session.runs).filter(
        ([, run]) => run.phase === "active"
    );
    if (activeRuns.length === 1) {
        return activeRuns[0]?.[0];
    }
    const establishedRuns = activeRuns.filter(
        ([, run]) =>
            !(
                (run.runId.startsWith("dashboard-chat-") ||
                    run.runId.startsWith("dashboard-compact-")) &&
                !run.assistant &&
                run.diagnostics.length === 0 &&
                run.userMessages.length === 0
            )
    );
    if (establishedRuns.length === 1) {
        return establishedRuns[0]?.[0];
    }
    const runlessRuns = activeRuns.filter(([, run]) =>
        run.runId.startsWith("runtime-runless-")
    );
    return runlessRuns.length === 1 ? runlessRuns[0]?.[0] : undefined;
}

function latestCompletedRunEntry(
    session: ChatSessionRuntimeState
): [string, ChatRunState] | undefined {
    return Object.entries(session.runs)
        .filter(([, candidate]) => candidate.phase !== "active")
        .toSorted(
            ([, left], [, right]) =>
                (right.terminalSequence ?? right.lastSequence) -
                (left.terminalSequence ?? left.lastSequence)
        )[0];
}

function pendingRunlessUserEntry(
    session: ChatSessionRuntimeState
): [string, ChatRunState] | undefined {
    const candidates = Object.entries(session.runs).filter(
        ([, run]) =>
            run.phase === "active" &&
            run.runId.startsWith("runtime-runless-") &&
            run.userMessages.length > 0 &&
            run.userMessages[0]?.message.timestamp === run.startedAt
    );
    return candidates.length === 1 ? candidates[0] : undefined;
}

function resolveRun(
    session: ChatSessionRuntimeState,
    event: ChatRuntimeEvent
): { run: ChatRunState; runKey: string } | undefined {
    let runKey: string | undefined;
    let run: ChatRunState | undefined;
    if (!event.runId && event.kind === "assistant" && event.source === "session") {
        const completedEntry = latestCompletedRunEntry(session);
        if (
            completedEntry &&
            isCompatibleSessionEcho(completedEntry[1], event.message, event.timestamp)
        ) {
            [runKey, run] = completedEntry;
        }
    }

    if (!run) {
        runKey = matchingRunKey(session, event.runId);
        run = runKey ? session.runs[runKey] : undefined;
    }

    if (
        !run &&
        !event.runId &&
        event.kind === "finish" &&
        event.outcome === "completed" &&
        !event.authoritative &&
        !event.error &&
        !event.message
    ) {
        const completedEntry = latestCompletedRunEntry(session);
        if (completedEntry) {
            [runKey, run] = completedEntry;
        }
    }

    if (!run && event.runId) {
        const pendingUserEntry = pendingRunlessUserEntry(session);
        if (pendingUserEntry) {
            [runKey, run] = pendingUserEntry;
        }
    }

    if (!run && event.runId) {
        runKey = event.runId;
        run = emptyRun(event.sessionKey, event.runId, event.sequence, event.timestamp);
        session.runs[runKey] = run;
    }

    if (!run && !event.runId) {
        runKey = `runtime-runless-${event.sequence}`;
        run = emptyRun(event.sessionKey, runKey, event.sequence, event.timestamp);
        session.runs[runKey] = run;
    }

    return run && runKey ? { run, runKey } : undefined;
}

function mergeThinking(
    previous: ChatThinkingDisplay[] = [],
    incoming: ChatThinkingDisplay[] = []
): ChatThinkingDisplay[] {
    const next = [...previous];
    for (const [incomingIndex, block] of incoming.entries()) {
        const matchingIndex = block.id
            ? next.findIndex((candidate) => candidate.id === block.id)
            : incomingIndex < next.length && !next[incomingIndex]?.id
              ? incomingIndex
              : -1;
        if (matchingIndex === -1) {
            next.push(block);
            continue;
        }

        const existing = next[matchingIndex]!;
        next[matchingIndex] = {
            ...existing,
            ...block,
            text: block.snapshot
                ? block.text
                : mergeChatStreamText(existing.text, block.text),
        };
    }
    return next;
}

function mergeMessageDetails(
    previous: ChatHistoryMessage | undefined,
    incoming: ChatHistoryMessage,
    text: string
): ChatHistoryMessage {
    return {
        ...previous,
        ...incoming,
        attachments: mergeChatAttachments(previous?.attachments, incoming.attachments),
        images: mergeChatImages(previous?.images, incoming.images),
        text,
        thinking: mergeThinking(previous?.thinking, incoming.thinking),
        toolCalls: incoming.toolCalls?.length ? incoming.toolCalls : previous?.toolCalls,
        toolResult: incoming.toolResult || previous?.toolResult,
    };
}

function hasNonTextDetails(message: ChatHistoryMessage): boolean {
    return Boolean(
        message.thinking?.length ||
        message.toolCalls?.length ||
        message.toolResult ||
        message.images?.length ||
        message.attachments?.length
    );
}

function isCompatibleSessionEcho(
    run: ChatRunState,
    incoming: ChatHistoryMessage,
    incomingTimestamp: string
): boolean {
    const previous = run.assistant;
    if (!previous) {
        return false;
    }
    const elapsedMilliseconds = Date.parse(incomingTimestamp) - Date.parse(run.updatedAt);
    if (
        !Number.isFinite(elapsedMilliseconds) ||
        elapsedMilliseconds < -5000 ||
        elapsedMilliseconds > SESSION_ECHO_WINDOW_MILLISECONDS
    ) {
        return false;
    }
    const previousText = previous.text.trim();
    const incomingText = incoming.text.trim();
    if (previousText || incomingText) {
        return Boolean(previousText && incomingText && previousText === incomingText);
    }
    if (!hasNonTextDetails(previous) || !hasNonTextDetails(incoming)) {
        return false;
    }
    const details = (message: ChatHistoryMessage) =>
        stableChatStringify({
            attachments: message.attachments || [],
            images: message.images || [],
            thinking: message.thinking || [],
            toolCalls: message.toolCalls || [],
            toolResult: message.toolResult,
        });
    return details(previous) === details(incoming);
}

function applyAssistantEvent(
    run: ChatRunState,
    event: Extract<ChatRuntimeEvent, { kind: "assistant" }>
): ChatRunState {
    const isSessionUpdateAfterCanonicalFinal =
        run.phase !== "active" &&
        event.source === "session" &&
        run.assistantSource === "chat";
    const canUseText =
        !isSessionUpdateAfterCanonicalFinal &&
        (!event.message.text ||
            !run.assistantSource ||
            run.assistantSource === event.source ||
            run.phase !== "active");
    const incoming = canUseText
        ? event.message
        : { ...event.message, content: [], text: "" };
    if (!incoming.text && !hasNonTextDetails(incoming)) {
        return run;
    }

    const previousText = run.assistant?.text || "";
    const isCompletedSessionEcho = Boolean(
        run.phase !== "active" &&
        event.source === "session" &&
        previousText.trim() &&
        previousText.trim() === incoming.text.trim()
    );
    const text = canUseText
        ? isCompletedSessionEcho
            ? previousText
            : event.mode === "replace"
              ? incoming.text
              : event.mode === "append"
                ? `${previousText}${incoming.text}`
                : mergeChatStreamText(previousText, incoming.text)
        : previousText;
    return {
        ...run,
        assistant: mergeMessageDetails(run.assistant, incoming, text),
        assistantSource: incoming.text
            ? event.mode === "replace"
                ? event.source
                : (run.assistantSource ?? event.source)
            : run.assistantSource,
    };
}

function isToolCallMatching(
    toolCall: ChatToolCallDisplay,
    result: ChatToolResultDisplay
): boolean {
    if (toolCall.id || result.id) {
        return Boolean(toolCall.id && result.id && toolCall.id === result.id);
    }
    return Boolean(result.name && toolCall.name === result.name);
}

function isSameToolCall(left: ChatToolCallDisplay, right: ChatToolCallDisplay): boolean {
    if (left.id || right.id) {
        return Boolean(left.id && right.id && left.id === right.id);
    }
    return (
        left.name === right.name &&
        stableChatStringify(left.arguments ?? undefined) ===
            stableChatStringify(right.arguments ?? undefined)
    );
}

function mergeToolDiagnostic(
    previous: ChatHistoryMessage | undefined,
    incoming: ChatHistoryMessage
): ChatHistoryMessage {
    if (!previous) {
        return incoming;
    }

    const incomingCall = incoming.toolCalls?.[0];
    const incomingResult = incoming.toolResult || incomingCall?.toolResult;
    const calls = [...(previous.toolCalls || [])];
    let callIndex = -1;
    if (incomingCall) {
        callIndex = calls.findIndex((candidate) => {
            if (incomingCall.id || candidate.id) {
                return Boolean(
                    incomingCall.id && candidate.id && incomingCall.id === candidate.id
                );
            }
            return (
                incomingCall.name === candidate.name &&
                stableChatStringify(incomingCall.arguments ?? undefined) ===
                    stableChatStringify(candidate.arguments ?? undefined)
            );
        });
        if (callIndex === -1) {
            calls.push(incomingCall);
            callIndex = calls.length - 1;
        } else {
            calls[callIndex] = {
                ...calls[callIndex]!,
                ...incomingCall,
                toolResult: incomingCall.toolResult || calls[callIndex]?.toolResult,
            };
        }
    }

    if (incomingResult) {
        if (callIndex === -1) {
            callIndex = calls.findLastIndex((candidate) =>
                isToolCallMatching(candidate, incomingResult)
            );
        }
        if (callIndex !== -1) {
            calls[callIndex] = {
                ...calls[callIndex]!,
                toolResult: incomingResult,
            };
        }
    }

    const toolResult = incomingResult || previous.toolResult;
    return {
        ...previous,
        ...incoming,
        attachments: mergeChatAttachments(previous.attachments, incoming.attachments),
        images: mergeChatImages(previous.images, incoming.images),
        toolCalls: calls.length > 0 ? calls : incoming.toolCalls,
        toolResult,
    };
}

function matchingDiagnosticIndex(
    diagnostics: ChatDiagnosticEntry[],
    key: string,
    kind: "thinking" | "tool",
    message: ChatHistoryMessage
): number {
    let index = diagnostics.findLastIndex((entry) => entry.key === key);
    if (kind === "tool") {
        const incomingCall = message.toolCalls?.[0];
        const result =
            message.toolResult ||
            message.toolCalls?.find((call) => call.toolResult)?.toolResult;
        const hasStableId = Boolean(incomingCall?.id || result?.id);
        if (result && !hasStableId) {
            index = diagnostics.findLastIndex((entry) =>
                entry.message.toolCalls?.some(
                    (call) => !call.toolResult && isToolCallMatching(call, result)
                )
            );
        } else if (incomingCall && !hasStableId) {
            index = diagnostics.findLastIndex((entry) =>
                entry.message.toolCalls?.some(
                    (call) => !call.toolResult && isSameToolCall(call, incomingCall)
                )
            );
        }
    }
    return index;
}

function mergeDiagnosticEntry(
    diagnostics: ChatDiagnosticEntry[],
    key: string,
    kind: "thinking" | "tool",
    incoming: ChatHistoryMessage,
    uniqueSuffix: number | string
): ChatDiagnosticEntry[] {
    const next = [...diagnostics];
    const index = matchingDiagnosticIndex(next, key, kind, incoming);
    const previous = index === -1 ? undefined : next[index]?.message;
    const message =
        kind === "tool"
            ? mergeToolDiagnostic(previous, incoming)
            : mergeMessageDetails(previous, incoming, incoming.text);
    const uniqueKey =
        index === -1 && next.some((entry) => entry.key === key)
            ? `${key}:${uniqueSuffix}`
            : key;
    const entry = { key: next[index]?.key || uniqueKey, message };
    if (index === -1) {
        next.push(entry);
    } else {
        next[index] = entry;
    }
    return next;
}

function applyDiagnosticEvent(
    run: ChatRunState,
    event: Extract<ChatRuntimeEvent, { kind: "thinking" | "tool" }>
): ChatRunState {
    const key = event.kind === "tool" ? event.toolKey : "thinking:primary";
    return {
        ...run,
        diagnostics: mergeDiagnosticEntry(
            run.diagnostics,
            key,
            event.kind,
            {
                ...event.message,
                timestamp: event.message.timestamp || event.timestamp,
            },
            event.sequence
        ),
    };
}

function applyUserEvent(
    run: ChatRunState,
    event: Extract<ChatRuntimeEvent, { kind: "user" }>
): ChatRunState {
    const message = {
        ...event.message,
        timestamp: event.message.timestamp || event.timestamp,
    };
    const key = `user:${messageDeleteKey(message)}`;
    if (run.userMessages.some((entry) => entry.key === key)) {
        return run;
    }
    return {
        ...run,
        userMessages: [
            ...run.userMessages,
            {
                key,
                message,
            },
        ],
    };
}

function mergeRunDiagnostics(
    older: ChatRunState,
    newer: ChatRunState
): ChatDiagnosticEntry[] {
    let diagnostics: ChatDiagnosticEntry[] = [];
    for (const [runIndex, run] of [older, newer].entries()) {
        for (const [entryIndex, entry] of run.diagnostics.entries()) {
            const kind =
                entry.message.toolCalls?.length || entry.message.toolResult
                    ? "tool"
                    : "thinking";
            diagnostics = mergeDiagnosticEntry(
                diagnostics,
                kind === "thinking" ? "thinking:primary" : entry.key,
                kind,
                entry.message,
                `merge-${runIndex}-${entryIndex}-${run.lastSequence}`
            );
        }
    }
    return diagnostics;
}

function mergeRunUserMessages(
    older: ChatRunState,
    newer: ChatRunState
): ChatDiagnosticEntry[] {
    const entries = new Map<string, ChatDiagnosticEntry>();
    for (const entry of [...older.userMessages, ...newer.userMessages]) {
        entries.set(entry.key, entry);
    }
    return entries
        .values()
        .toArray()
        .toSorted((left, right) => {
            const leftTimestamp = Date.parse(left.message.timestamp || "");
            const rightTimestamp = Date.parse(right.message.timestamp || "");
            if (Number.isNaN(leftTimestamp) || Number.isNaN(rightTimestamp)) {
                return left.key.localeCompare(right.key);
            }
            return leftTimestamp - rightTimestamp;
        });
}

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
    const startedAt = (
        Date.parse(existing.startedAt) <= Date.parse(optimistic.startedAt)
            ? existing
            : optimistic
    ).startedAt;
    const terminalSequence =
        existing.terminalSequence === undefined
            ? optimistic.terminalSequence
            : optimistic.terminalSequence === undefined
              ? existing.terminalSequence
              : Math.max(existing.terminalSequence, optimistic.terminalSequence);
    const terminalRun = [existing, optimistic]
        .filter((run) => run.phase !== "active")
        .toSorted(
            (left, right) =>
                (right.terminalSequence ?? right.lastSequence) -
                (left.terminalSequence ?? left.lastSequence)
        )[0];
    const phase = terminalRun?.phase ?? newer.phase;

    return {
        ...newer,
        aliases: uniqueChatRunIds([
            ...existing.aliases,
            ...optimistic.aliases,
            optimistic.runId,
            providerRunId,
        ]),
        assistant,
        assistantSource: newer.assistantSource || older.assistantSource,
        diagnostics: mergeRunDiagnostics(older, newer),
        error: (terminalRun ?? newer).error,
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

function applyFinishEvent(
    run: ChatRunState,
    event: Extract<ChatRuntimeEvent, { kind: "finish" }>
): ChatRunState {
    const isMetadataCompletion =
        run.phase !== "active" &&
        event.outcome === "completed" &&
        !event.authoritative &&
        !event.error &&
        !event.message;
    if (isMetadataCompletion) {
        return { ...run, statusText: undefined };
    }

    const hasFailedTool = run.diagnostics.some((entry) =>
        [
            entry.message.toolResult,
            ...(entry.message.toolCalls || []).map((call) => call.toolResult),
        ].some((result) => result?.isError === true)
    );
    const isToolFailure = Boolean(run.toolFailure || event.toolFailure);
    const error = isToolFailure && hasFailedTool ? undefined : event.error;

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
    return {
        ...withMessage,
        error,
        operationPhase: isPendingCompaction
            ? event.outcome === "completed"
                ? "complete"
                : "inactive"
            : run.operationPhase,
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

function settleRetryingCompactionRuns(
    session: ChatSessionRuntimeState,
    event: ChatRuntimeEvent
): void {
    if (event.kind !== "finish" || !event.settlesCompaction) {
        return;
    }
    for (const [runKey, run] of Object.entries(session.runs)) {
        if (run.operation !== "compact" || run.operationPhase !== "retrying") {
            continue;
        }
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
}

/** Applies normalized runtime events deterministically and idempotently. */
export function reduceChatRuntime(
    state: ChatRuntimeState,
    events: ChatRuntimeEvent[]
): ChatRuntimeState {
    let nextState = state;
    const orderedEvents = [...events].toSorted(
        (left, right) => left.sequence - right.sequence
    );
    for (const event of orderedEvents) {
        const previousEntry = matchingSessionEntry(nextState, event.sessionKey);
        const previousSessionKey = previousEntry?.[0];
        const previousSession = previousEntry?.[1];
        const sessionKey = previousSessionKey
            ? preferredSessionKey(previousSessionKey, event.sessionKey)
            : event.sessionKey;
        const normalizedEvent =
            event.sessionKey === sessionKey ? event : { ...event, sessionKey };
        if (previousSession && normalizedEvent.sequence <= previousSession.lastSequence) {
            continue;
        }

        const session: ChatSessionRuntimeState = previousSession
            ? {
                  ...previousSession,
                  sessionKey,
                  runs: Object.fromEntries(
                      Object.entries(previousSession.runs).map(([key, run]) => [
                          key,
                          {
                              ...run,
                              diagnostics: [...run.diagnostics],
                              sessionKey,
                              userMessages: [...run.userMessages],
                          },
                      ])
                  ),
              }
            : { lastSequence: -1, runs: {}, sessionKey };
        settleRetryingCompactionRuns(session, normalizedEvent);
        const resolved = resolveRun(session, normalizedEvent);
        session.lastSequence = normalizedEvent.sequence;
        const sessions = { ...nextState.sessions };
        if (previousSessionKey && previousSessionKey !== sessionKey) {
            delete sessions[previousSessionKey];
        }
        if (!resolved) {
            nextState = {
                ...nextState,
                sessions: { ...sessions, [sessionKey]: session },
            };
            continue;
        }

        const run = applyRunEvent(resolved.run, normalizedEvent);

        session.runs[resolved.runKey] = {
            ...run,
            aliases: uniqueChatRunIds([...run.aliases, normalizedEvent.runId]),
            lastSequence: normalizedEvent.sequence,
            updatedAt: normalizedEvent.timestamp,
        };
        nextState = {
            ...nextState,
            sessions: { ...sessions, [sessionKey]: session },
        };
    }
    return nextState;
}

function applyRunEvent(run: ChatRunState, event: ChatRuntimeEvent): ChatRunState {
    switch (event.kind) {
        case "user": {
            return applyUserEvent(run, event);
        }
        case "assistant": {
            return applyAssistantEvent(run, event);
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
            const operationOutcome = event.operation
                ? isPendingOperation
                    ? "active"
                    : operationPhase === "complete"
                      ? "completed"
                      : "aborted"
                : run.phase;
            return {
                ...run,
                operation: event.operation ?? run.operation,
                error: event.operation && isPendingOperation ? undefined : run.error,
                operationPhase,
                operationUpdatedAt: event.operation
                    ? event.timestamp
                    : run.operationUpdatedAt,
                phase: operationOutcome,
                statusText: event.text,
                terminalAt:
                    event.operation && !isPendingOperation
                        ? event.timestamp
                        : event.operation
                          ? undefined
                          : run.terminalAt,
                terminalSequence:
                    event.operation && !isPendingOperation
                        ? event.sequence
                        : event.operation
                          ? undefined
                          : run.terminalSequence,
            };
        }
        default: {
            return applyFinishEvent(run, event);
        }
    }
}

/** Adds an optimistic run before the provider acknowledges its canonical id. */
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
              sessionKey: canonicalSessionKey,
              runs: Object.fromEntries(
                  Object.entries(previousSession.runs).map(([key, run]) => [
                      key,
                      { ...run, sessionKey: canonicalSessionKey },
                  ])
              ),
          }
        : { lastSequence: -1, runs: {}, sessionKey: canonicalSessionKey };
    const existingEntry = Object.entries(session.runs).find(
        ([key, run]) => key === runId || run.aliases.includes(runId)
    );
    if (existingEntry) {
        const [existingKey, existingRun] = existingEntry;
        session.runs[existingKey] = {
            ...existingRun,
            operation: operation ?? existingRun.operation,
            operationPhase:
                operation === "compact" ? "active" : existingRun.operationPhase,
            operationUpdatedAt:
                operation === "compact" ? timestamp : existingRun.operationUpdatedAt,
            statusText:
                existingRun.phase === "active"
                    ? operation === "compact"
                        ? "Compacting context"
                        : (existingRun.statusText ?? "Thinking")
                    : existingRun.statusText,
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

/** Promotes one optimistic run to the provider run id without changing row order. */
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

/** Removes the previous completed replay when a new local run starts. */
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

/** Returns the immutable completed replay displaced by a new optimistic send. */
export function completedChatRuns(
    state: ChatRuntimeState,
    sessionKey: string
): Record<string, ChatRunState> {
    const session = matchingSessionEntry(state, sessionKey)?.[1];
    return Object.fromEntries(
        Object.entries(session?.runs || {}).filter(([, run]) => run.phase !== "active")
    );
}

/** Restores a displaced replay without replacing newer live runtime state. */
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

/** Removes status-only runs that projection has already classified as stale. */
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
