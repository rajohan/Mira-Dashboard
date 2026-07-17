import type { ChatHistoryMessage, ChatRow, ChatVisibilitySettings } from "../chatTypes";
import {
    dedupeMessages,
    isRecoveredAssistantText,
    mergeChatMessageDetails,
    messageDeleteKey,
    messageIdentity,
} from "../chatUtilities";
import { presentChatMessages } from "./chatPresentation";
import type {
    ChatRunState,
    ChatRuntimeState,
    ChatSessionRuntimeState,
} from "./chatState";
import { findChatSessionRuntimeState } from "./chatState";

const RUN_START_USER_SKEW_MS = 1000;

export interface ChatProjection {
    activityFingerprint: string;
    activeRuns: ChatRunState[];
    isCompacting: boolean;
    rows: ChatRow[];
}

function orderedRuns(session?: ChatSessionRuntimeState): ChatRunState[] {
    return Object.values(session?.runs || {}).toSorted((left, right) => {
        const leftSequence =
            left.phase === "active"
                ? left.lastSequence
                : (left.terminalSequence ?? left.lastSequence);
        const rightSequence =
            right.phase === "active"
                ? right.lastSequence
                : (right.terminalSequence ?? right.lastSequence);
        const sequenceDifference = leftSequence - rightSequence;
        return sequenceDifference || left.runId.localeCompare(right.runId);
    });
}

function currentResponseStart(messages: ChatHistoryMessage[]): number {
    return messages.findLastIndex((message) => message.role.toLowerCase() === "user") + 1;
}

interface ResponseSegment {
    end: number;
    start: number;
}

function isUserMessage(message: ChatHistoryMessage): boolean {
    return message.role.toLowerCase() === "user";
}

function messageTimestamp(message: ChatHistoryMessage): number | undefined {
    const timestamp = Date.parse(message.timestamp || "");
    return Number.isNaN(timestamp) ? undefined : timestamp;
}

function isRunMatchingMessage(run: ChatRunState, message: ChatHistoryMessage): boolean {
    return Boolean(
        message.runId &&
        (message.runId === run.runId || run.aliases.includes(message.runId))
    );
}

function responseSegment(
    messages: ChatHistoryMessage[],
    run: ChatRunState
): ResponseSegment {
    let userIndex = messages.findLastIndex(
        (message) => isUserMessage(message) && isRunMatchingMessage(run, message)
    );
    const matchingIndex = messages.findIndex((message) =>
        isRunMatchingMessage(run, message)
    );
    if (userIndex === -1 && matchingIndex !== -1) {
        userIndex = messages.findLastIndex(
            (message, index) => index < matchingIndex && isUserMessage(message)
        );
    }

    const startedAt = Date.parse(run.startedAt);
    const anchorAt = Date.parse(
        run.phase === "active" ? run.updatedAt : (run.terminalAt ?? run.updatedAt)
    );
    if (!Number.isNaN(anchorAt)) {
        const chronologicalUserIndex = messages.findLastIndex((message) => {
            const timestamp = messageTimestamp(message);
            return (
                isUserMessage(message) && timestamp !== undefined && timestamp <= anchorAt
            );
        });
        userIndex = Math.max(userIndex, chronologicalUserIndex);

        const initiatingUserIndex = messages.findIndex((message) => {
            const timestamp = messageTimestamp(message);
            return (
                isUserMessage(message) &&
                timestamp !== undefined &&
                !Number.isNaN(startedAt) &&
                timestamp >= startedAt &&
                timestamp - startedAt <= RUN_START_USER_SKEW_MS
            );
        });
        if (initiatingUserIndex > userIndex) {
            userIndex = initiatingUserIndex;
        }
    }
    const start = userIndex === -1 ? currentResponseStart(messages) : userIndex + 1;
    const nextUserOffset = messages
        .slice(start)
        .findIndex((message) => isUserMessage(message));
    return {
        end: nextUserOffset === -1 ? messages.length : start + nextUserOffset,
        start,
    };
}

function canonicalFinalIndex(
    messages: ChatHistoryMessage[],
    run: ChatRunState,
    segment: ResponseSegment
): number {
    const assistantText = run.assistant?.text || "";
    for (let index = segment.end - 1; index >= segment.start; index -= 1) {
        const message = messages[index]!;
        const role = message.role.toLowerCase();
        if (role !== "assistant" && role !== "system") {
            continue;
        }
        if (isRunMatchingMessage(run, message)) {
            return index;
        }
        if (message.runId) {
            continue;
        }
        if (!assistantText && message.text.trim()) {
            if (run.phase !== "active") {
                return index;
            }
            const finalTimestamp = messageTimestamp(message);
            const startedAt = Date.parse(run.startedAt);
            const latestEvidenceTimestamp = Math.max(
                Number.isNaN(startedAt) ? -Infinity : startedAt,
                ...run.diagnostics.map(
                    (entry) => messageTimestamp(entry.message) ?? -Infinity
                )
            );
            if (
                finalTimestamp !== undefined &&
                Number.isFinite(latestEvidenceTimestamp) &&
                finalTimestamp >= latestEvidenceTimestamp
            ) {
                return index;
            }
        }
        if (assistantText && isRecoveredAssistantText(message.text, assistantText)) {
            return index;
        }
    }
    return -1;
}

function toolSignatures(message: ChatHistoryMessage): string[] {
    const calls = (message.toolCalls || []).map((call) =>
        JSON.stringify({
            arguments: call.arguments ?? undefined,
            id: call.id || "",
            name: call.name,
            result: call.toolResult
                ? {
                      content: call.toolResult.content,
                      error: call.toolResult.isError || false,
                      id: call.toolResult.id || "",
                      images: call.toolResult.images || [],
                      name: call.toolResult.name || "",
                  }
                : undefined,
        })
    );
    if (message.toolResult) {
        calls.push(
            JSON.stringify({
                result: {
                    content: message.toolResult.content,
                    error: message.toolResult.isError || false,
                    id: message.toolResult.id || "",
                    images: message.toolResult.images || [],
                    name: message.toolResult.name || "",
                },
            })
        );
    }
    return calls;
}

function thinkingSignatures(message: ChatHistoryMessage): string[] {
    return (message.thinking || []).map((block) => block.text);
}

function hasEverySignature(expected: string[], recovered: string[]): boolean {
    const available = new Map<string, number>();
    for (const signature of recovered) {
        available.set(signature, (available.get(signature) || 0) + 1);
    }
    for (const signature of expected) {
        const count = available.get(signature) || 0;
        if (count === 0) {
            return false;
        }
        available.set(signature, count - 1);
    }
    return true;
}

function isDiagnosticRecovered(
    diagnostic: ChatHistoryMessage,
    messages: ChatHistoryMessage[],
    segment: ResponseSegment,
    run: ChatRunState
): boolean {
    const candidates = messages
        .slice(segment.start, segment.end)
        .filter((candidate) => !candidate.runId || isRunMatchingMessage(run, candidate));
    const tool = toolSignatures(diagnostic);
    const thinking = thinkingSignatures(diagnostic);
    const identity = messageIdentity(diagnostic);

    if (candidates.some((candidate) => messageIdentity(candidate) === identity)) {
        return true;
    }
    if (tool.length === 0 && thinking.length === 0) {
        return false;
    }
    const recoveredTools = candidates.flatMap((candidate) => toolSignatures(candidate));
    const recoveredThinking = candidates.flatMap((candidate) =>
        thinkingSignatures(candidate)
    );
    return (
        hasEverySignature(tool, recoveredTools) &&
        hasEverySignature(thinking, recoveredThinking)
    );
}

function transientMessage(
    message: ChatHistoryMessage,
    run: ChatRunState,
    runtimeKey: string
): ChatHistoryMessage {
    return {
        ...message,
        local: true,
        runId: run.runId,
        runtimeKey,
        timestamp: message.timestamp || run.updatedAt,
    };
}

function diagnosticRank(message: ChatHistoryMessage): number {
    return message.toolCalls?.length || message.toolResult ? 0 : 1;
}

/** Reconciles history with the current provider-independent runtime turn. */
export function reconcileChatMessages(
    history: ChatHistoryMessage[],
    session?: ChatSessionRuntimeState
): ChatHistoryMessage[] {
    const messages = [...history];
    for (const run of orderedRuns(session)) {
        for (const [index, message] of messages.entries()) {
            if (
                message.thinking?.length &&
                !message.text.trim() &&
                isRunMatchingMessage(run, message) &&
                message.runId !== run.runId
            ) {
                messages[index] = { ...message, runId: run.runId };
            }
        }
        const segment = responseSegment(messages, run);
        const diagnostics = run.diagnostics
            .toSorted(
                (left, right) =>
                    diagnosticRank(left.message) - diagnosticRank(right.message)
            )
            .map((entry) => transientMessage(entry.message, run, entry.key))
            .filter((message) => !isDiagnosticRecovered(message, messages, segment, run));
        const finalIndex = canonicalFinalIndex(messages, run, segment);
        if (finalIndex !== -1) {
            const canonical = messages[finalIndex]!;
            if (run.assistant) {
                messages[finalIndex] = mergeChatMessageDetails(
                    canonical,
                    transientMessage(run.assistant, run, "assistant")
                );
            }
            messages.splice(finalIndex, 0, ...diagnostics);
            continue;
        }

        const additions = [...diagnostics];
        if (run.assistant) {
            additions.push(transientMessage(run.assistant, run, "assistant"));
        }
        messages.splice(segment.end, 0, ...additions);
    }
    return dedupeMessages(messages);
}

function visibleAssistantRunIds(messages: ChatHistoryMessage[]): Set<string> {
    return new Set(
        messages
            .filter(
                (message) =>
                    message.local === true &&
                    ["assistant", "system"].includes(message.role.toLowerCase()) &&
                    Boolean(message.text.trim())
            )
            .map((message) => message.runId)
            .filter((runId): runId is string => Boolean(runId))
    );
}

function statusRow(
    runs: ChatRunState[],
    visibleRunIdSet: Set<string>,
    messages: ChatHistoryMessage[]
): ChatRow | undefined {
    const run = runs
        .filter((candidate) => candidate.phase === "active")
        .toSorted((left, right) => right.lastSequence - left.lastSequence)
        .find(
            (candidate) =>
                !visibleRunIdSet.has(candidate.runId) &&
                candidate.aliases.every((alias) => !visibleRunIdSet.has(alias)) &&
                canonicalFinalIndex(
                    messages,
                    candidate,
                    responseSegment(messages, candidate)
                ) === -1
        );
    if (!run) {
        return undefined;
    }
    const text = run.statusText || "Thinking";
    return {
        key: `typing-${run.sessionKey}-${run.runId}-${text}`,
        kind: "typing",
        message: { content: text, role: "assistant", text },
    };
}

/** Builds the exact rows consumed by the unchanged chat message UI. */
export function projectChat(
    history: ChatHistoryMessage[],
    runtime: ChatRuntimeState,
    sessionKey: string,
    visibility: ChatVisibilitySettings,
    shouldKeepThinkingAfterFinal: boolean,
    deletedMessageKeys: ReadonlySet<string>
): ChatProjection {
    const session = findChatSessionRuntimeState(runtime, sessionKey);
    const runs = orderedRuns(session);
    const reconciled = reconcileChatMessages(history, session);
    const presented = presentChatMessages(
        reconciled,
        visibility,
        shouldKeepThinkingAfterFinal
    ).filter((message) => !deletedMessageKeys.has(messageDeleteKey(message)));
    const rows: ChatRow[] = presented.map((message) => ({
        key:
            message.local === true && message.runId
                ? `stream-${message.runId}-${message.runtimeKey || messageDeleteKey(message)}`
                : messageDeleteKey(message),
        kind: message.local === true && message.runId ? "stream" : "message",
        message,
    }));
    const typing = statusRow(runs, visibleAssistantRunIds(presented), history);
    if (typing) {
        rows.push(typing);
    }

    const activeRuns = runs.filter((run) => run.phase === "active");
    return {
        activityFingerprint: runs
            .map((run) =>
                [
                    run.runId,
                    run.lastSequence,
                    run.statusText || "",
                    run.assistant?.text || "",
                ].join(":")
            )
            .join("|"),
        activeRuns,
        isCompacting: activeRuns.some(
            (run) =>
                run.operation === "compact" ||
                run.statusText?.toLowerCase().includes("compact")
        ),
        rows,
    };
}
