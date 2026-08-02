import type {
    CanonicalChatEvent,
    CanonicalChatProviderMetadata,
} from "../../../../../../contracts/chat/canonical";
import { stableChatStringify } from "../chatMessageIdentity";
import {
    type ChatHistoryMessage,
    type ChatMessageProvenance,
    mergeChatMessageProvenance,
} from "../chatTypes";

export type ChatRunPhase = "active" | "completed" | "aborted" | "error";
export type ChatTextSource = "chat" | "runtime" | "session";
export type ChatOperationPhase = "active" | "complete" | "inactive" | "retrying";
export type ChatRunContentKind = "assistant" | "thinking" | "tool" | "user";

export const SESSION_ECHO_WINDOW_MILLISECONDS = 60_000;
export const MAX_CHAT_RUNTIME_DIAGNOSTICS_PER_RUN = 200;
export const MAX_CHAT_RUNTIME_COMMENTARY_PER_RUN = 100;
export const MAX_CHAT_RUNTIME_CONTROLS_PER_SESSION = 100;
export const MAX_CHAT_RUNTIME_ASSISTANT_SEGMENTS_PER_RUN = 100;

export interface ChatRuntimeMessageEntry {
    key: string;
    message: ChatHistoryMessage;
    sequence: number;
}

/** Canonical runtime state for one session-scoped run. */
export interface ChatRunState {
    aliases: string[];
    assistantBoundarySequence?: number;
    assistant?: ChatHistoryMessage;
    assistantSegments?: ChatRuntimeMessageEntry[];
    assistantSequence?: number;
    assistantSource?: ChatTextSource;
    commentary: ChatRuntimeMessageEntry[];
    diagnostics: ChatRuntimeMessageEntry[];
    error?: string;
    lastContentKind?: ChatRunContentKind;
    lastContentSequence?: number;
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
    userMessages: ChatRuntimeMessageEntry[];
}

export interface ChatSessionRuntimeState {
    controls: ChatRuntimeMessageEntry[];
    lastSequence: number;
    runs: Record<string, ChatRunState>;
    sessionKey: string;
}

export interface ChatRuntimeState {
    generation: number;
    sessions: Record<string, ChatSessionRuntimeState>;
}

export interface RuntimeEventBase {
    id?: string;
    origin?: CanonicalChatEvent["origin"];
    provider?: CanonicalChatProviderMetadata;
    runAliases?: string[];
    runId?: string;
    sequence: number;
    sessionKey: string;
    timestamp: string;
}

export function withRuntimeMessageProvenance(
    message: ChatHistoryMessage,
    event: RuntimeEventBase
): ChatHistoryMessage {
    if (!event.id) return message;
    const runtimeProvenance: ChatMessageProvenance = {
        id: event.id,
        origin: event.origin,
        provider: event.provider,
        sequence: event.sequence,
        source: "openclaw-runtime",
    };
    return {
        ...message,
        provenance: mergeChatMessageProvenance(runtimeProvenance, message.provenance),
    };
}

export type ChatRuntimeEvent =
    | (RuntimeEventBase & {
          kind: "identity";
      })
    | (RuntimeEventBase & {
          kind: "control";
          message: ChatHistoryMessage;
      })
    | (RuntimeEventBase & {
          kind: "commentary";
          message: ChatHistoryMessage;
          mode: "append" | "replace";
      })
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
          settlesCompactionRunId?: string;
          toolFailure?: boolean;
      });

export function runContentKind(event: ChatRuntimeEvent): ChatRunContentKind | undefined {
    switch (event.kind) {
        case "assistant":
        case "thinking":
        case "tool":
        case "user": {
            return event.kind;
        }
        case "finish": {
            return event.message ? "assistant" : undefined;
        }
        case "commentary":
        case "control":
        case "identity":
        case "status": {
            return undefined;
        }
    }
}
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

export function matchingSessionEntry(
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

export function preferredSessionKey(existingKey: string, incomingKey: string): string {
    return /^agent:[^:]+:.+$/iu.test(incomingKey.trim()) ? incomingKey : existingKey;
}

/**
 * Resolves an exact or unambiguous provider session alias for presentation.
 * @returns Resolved an exact or unambiguous provider session alias for presentation.
 */
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

export function emptyRun(
    sessionKey: string,
    runId: string,
    sequence: number,
    timestamp: string
): ChatRunState {
    return {
        aliases: [runId],
        assistantSegments: [],
        commentary: [],
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

export function matchingRunKey(
    session: ChatSessionRuntimeState,
    runId: string | undefined,
    target: "any" | "chat" | "compaction" = "any"
): string | undefined {
    if (runId) {
        return Object.entries(session.runs).find(
            ([key, run]) => key === runId || run.aliases.includes(runId)
        )?.[0];
    }

    const activeRuns = Object.entries(session.runs).filter(
        ([, run]) =>
            run.phase === "active" &&
            (target === "any" ||
                (target === "compaction"
                    ? run.operation === "compact"
                    : run.operation !== "compact"))
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
                run.commentary.length === 0 &&
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

function promotableRunlessUserEntry(
    session: ChatSessionRuntimeState,
    event: ChatRuntimeEvent
): [string, ChatRunState] | undefined {
    const activeCandidates = Object.entries(session.runs).filter(
        ([, run]) =>
            run.phase === "active" &&
            run.runId.startsWith("runtime-runless-") &&
            run.userMessages.length > 0 &&
            run.userMessages[0]?.message.timestamp === run.startedAt
    );
    if (activeCandidates.length === 1) {
        return activeCandidates[0];
    }
    if (activeCandidates.length > 0) {
        return undefined;
    }
    if (event.kind !== "assistant" || event.source !== "session" || !event.runId) {
        return undefined;
    }
    const completedCandidates = Object.entries(session.runs).filter(
        ([, run]) =>
            run.phase === "completed" &&
            run.lastSequence === session.lastSequence &&
            run.runId.startsWith("runtime-runless-") &&
            run.userMessages.length > 0 &&
            run.userMessages[0]?.message.timestamp === run.startedAt &&
            isCompatibleSessionEcho(run, event.message, event.timestamp)
    );
    return completedCandidates.length === 1 ? completedCandidates[0] : undefined;
}

function isDedicatedCompactionStatus(event: ChatRuntimeEvent): boolean {
    return event.kind === "status" && event.operation === "compact";
}

export function resolveRun(
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
        runKey = matchingRunKey(
            session,
            event.runId,
            isDedicatedCompactionStatus(event) ? "compaction" : "chat"
        );
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

    if (!run && event.runId && !isDedicatedCompactionStatus(event)) {
        const pendingUserEntry = promotableRunlessUserEntry(session, event);
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

export function hasNonTextDetails(message: ChatHistoryMessage): boolean {
    return Boolean(
        message.thinking?.length ||
        message.toolCalls?.length ||
        message.toolResult ||
        message.images?.length ||
        message.attachments?.length
    );
}

function nonTextDetailsSignature(message: ChatHistoryMessage): string {
    return stableChatStringify({
        attachments: message.attachments || [],
        images: message.images || [],
        thinking: message.thinking || [],
        toolCalls: message.toolCalls || [],
        toolResult: message.toolResult,
    });
}

export function isCompatibleSessionEcho(
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
    return nonTextDetailsSignature(previous) === nonTextDetailsSignature(incoming);
}
