import { currentIsoString } from "../../../../utils/date";
import {
    type ChatHistoryMessage,
    type ChatThinkingDisplay,
    type ChatToolCallDisplay,
    type ChatToolResultDisplay,
    mergeChatAttachments,
    mergeChatImages,
} from "../chatTypes";

export type ChatRunPhase = "active" | "completed" | "aborted" | "error";
export type ChatTextSource = "chat" | "runtime" | "session";

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
    phase: ChatRunPhase;
    runId: string;
    sessionKey: string;
    startedAt: string;
    statusText?: string;
    updatedAt: string;
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
          text?: string;
      })
    | (RuntimeEventBase & {
          authoritative?: boolean;
          kind: "finish";
          error?: string;
          message?: ChatHistoryMessage;
          outcome: Exclude<ChatRunPhase, "active">;
          suppressIfToolFailure?: boolean;
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
    const runlessRuns = activeRuns.filter(([, run]) =>
        run.runId.startsWith("runtime-runless-")
    );
    return runlessRuns.length === 1 ? runlessRuns[0]?.[0] : undefined;
}

function resolveRun(
    session: ChatSessionRuntimeState,
    event: ChatRuntimeEvent
): { run: ChatRunState; runKey: string } | undefined {
    let runKey = matchingRunKey(session, event.runId);
    let run = runKey ? session.runs[runKey] : undefined;

    if (!run && !event.runId && event.kind === "finish") {
        const completedEntry = Object.entries(session.runs)
            .filter(([, candidate]) => candidate.phase !== "active")
            .toSorted(([, left], [, right]) => right.lastSequence - left.lastSequence)[0];
        if (completedEntry) {
            [runKey, run] = completedEntry;
        }
    }

    if (
        !run &&
        !event.runId &&
        event.kind === "assistant" &&
        event.source === "session"
    ) {
        const completedEntry = Object.entries(session.runs)
            .filter(([, candidate]) => candidate.phase !== "active")
            .toSorted(([, left], [, right]) => right.lastSequence - left.lastSequence)[0];
        if (
            completedEntry &&
            isCompatibleSessionEcho(completedEntry[1], event.message, event.timestamp)
        ) {
            [runKey, run] = completedEntry;
        }
    }

    if (!run && event.runId) {
        const provisionalRuns = Object.entries(session.runs).filter(
            ([, candidate]) =>
                candidate.phase === "active" &&
                isProvisionalChatRunId(session.sessionKey, candidate.runId)
        );
        if (provisionalRuns.length === 1) {
            const [provisionalKey, provisionalRun] = provisionalRuns[0]!;
            delete session.runs[provisionalKey];
            runKey = event.runId;
            run = {
                ...provisionalRun,
                aliases: uniqueChatRunIds([
                    ...provisionalRun.aliases,
                    provisionalRun.runId,
                    event.runId,
                ]),
                runId: event.runId,
            };
            session.runs[runKey] = run;
        }
    }

    if (!run && event.runId) {
        const hasActiveRun = Object.values(session.runs).some(
            (candidate) => candidate.phase === "active"
        );
        if (!hasActiveRun) {
            session.runs = Object.fromEntries(
                Object.entries(session.runs).filter(
                    ([, candidate]) => candidate.phase === "active"
                )
            );
        }
        runKey = event.runId;
        run = emptyRun(event.sessionKey, event.runId, event.sequence, event.timestamp);
        session.runs[runKey] = run;
    }

    if (!run && !event.runId) {
        session.runs = Object.fromEntries(
            Object.entries(session.runs).filter(
                ([, candidate]) => candidate.phase === "active"
            )
        );
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
        JSON.stringify({
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
    const canUseText =
        !event.message.text ||
        !run.assistantSource ||
        run.assistantSource === event.source ||
        run.phase !== "active";
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
        assistantSource:
            incoming.text && !run.assistantSource ? event.source : run.assistantSource,
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
        JSON.stringify(left.arguments ?? undefined) ===
            JSON.stringify(right.arguments ?? undefined)
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
                JSON.stringify(incomingCall.arguments ?? undefined) ===
                    JSON.stringify(candidate.arguments ?? undefined)
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
    const key =
        event.kind === "tool"
            ? event.toolKey
            : `thinking:${event.message.thinking?.[0]?.id || "primary"}`;
    return {
        ...run,
        diagnostics: mergeDiagnosticEntry(
            run.diagnostics,
            key,
            event.kind,
            event.message,
            event.sequence
        ),
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
                entry.key,
                kind,
                entry.message,
                `merge-${runIndex}-${entryIndex}-${run.lastSequence}`
            );
        }
    }
    return diagnostics;
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
        lastSequence: Math.max(existing.lastSequence, optimistic.lastSequence),
        operation: newer.operation ?? older.operation,
        runId: providerRunId,
        startedAt,
        statusText:
            newer.phase === "active" ? newer.statusText || older.statusText : undefined,
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
    const error = event.suppressIfToolFailure && hasFailedTool ? undefined : event.error;

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
    return {
        ...withMessage,
        error,
        phase: event.outcome,
        statusText: undefined,
    };
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
        const previousSession = nextState.sessions[event.sessionKey];
        if (previousSession && event.sequence <= previousSession.lastSequence) {
            continue;
        }

        const session: ChatSessionRuntimeState = previousSession
            ? {
                  ...previousSession,
                  runs: Object.fromEntries(
                      Object.entries(previousSession.runs).map(([key, run]) => [
                          key,
                          { ...run, diagnostics: [...run.diagnostics] },
                      ])
                  ),
              }
            : { lastSequence: -1, runs: {}, sessionKey: event.sessionKey };
        const resolved = resolveRun(session, event);
        session.lastSequence = event.sequence;
        if (!resolved) {
            nextState = {
                ...nextState,
                sessions: { ...nextState.sessions, [event.sessionKey]: session },
            };
            continue;
        }

        const run = applyRunEvent(resolved.run, event);

        session.runs[resolved.runKey] = {
            ...run,
            aliases: uniqueChatRunIds([...run.aliases, event.runId]),
            lastSequence: event.sequence,
            updatedAt: event.timestamp,
        };
        nextState = {
            ...nextState,
            sessions: { ...nextState.sessions, [event.sessionKey]: session },
        };
    }
    return nextState;
}

function applyRunEvent(run: ChatRunState, event: ChatRuntimeEvent): ChatRunState {
    switch (event.kind) {
        case "assistant": {
            return applyAssistantEvent(run, event);
        }
        case "thinking":
        case "tool": {
            return applyDiagnosticEvent(run, event);
        }
        case "status": {
            return {
                ...run,
                operation: event.operation ?? run.operation,
                statusText: event.text,
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
    const previousSession = state.sessions[sessionKey];
    const session: ChatSessionRuntimeState = previousSession
        ? {
              ...previousSession,
              runs: Object.fromEntries(
                  Object.entries(previousSession.runs).filter(
                      ([, run]) => run.phase === "active"
                  )
              ),
          }
        : { lastSequence: -1, runs: {}, sessionKey };
    session.runs[runId] = {
        ...emptyRun(sessionKey, runId, session.lastSequence, timestamp),
        operation,
        statusText: operation === "compact" ? "Compacting context" : "Thinking",
    };
    return { ...state, sessions: { ...state.sessions, [sessionKey]: session } };
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
    const previousSession = state.sessions[sessionKey];
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
    return {
        ...state,
        sessions: {
            ...state.sessions,
            [sessionKey]: { ...previousSession, runs },
        },
    };
}

export function clearChatRun(
    state: ChatRuntimeState,
    sessionKey: string,
    runId: string
): ChatRuntimeState {
    const previousSession = state.sessions[sessionKey];
    if (!previousSession) {
        return state;
    }
    const runs = Object.fromEntries(
        Object.entries(previousSession.runs).filter(
            ([key, run]) => key !== runId && !run.aliases.includes(runId)
        )
    );
    return {
        ...state,
        sessions: {
            ...state.sessions,
            [sessionKey]: { ...previousSession, runs },
        },
    };
}

export function clearChatSessionRuntime(
    state: ChatRuntimeState,
    sessionKey: string
): ChatRuntimeState {
    if (state.sessions[sessionKey] === undefined) {
        return state;
    }
    const sessions = { ...state.sessions };
    delete sessions[sessionKey];
    return { ...state, sessions };
}
