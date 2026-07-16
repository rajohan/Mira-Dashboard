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

export interface ChatProjection {
    activityFingerprint: string;
    activeRuns: ChatRunState[];
    isCompacting: boolean;
    rows: ChatRow[];
}

function orderedRuns(session?: ChatSessionRuntimeState): ChatRunState[] {
    return Object.values(session?.runs || {}).toSorted((left, right) => {
        const sequenceDifference = left.lastSequence - right.lastSequence;
        return sequenceDifference || left.runId.localeCompare(right.runId);
    });
}

function currentResponseStart(messages: ChatHistoryMessage[]): number {
    return messages.findLastIndex((message) => message.role.toLowerCase() === "user") + 1;
}

function isRunMatchingMessage(run: ChatRunState, message: ChatHistoryMessage): boolean {
    return Boolean(
        message.runId &&
        (message.runId === run.runId || run.aliases.includes(message.runId))
    );
}

function canonicalFinalIndex(messages: ChatHistoryMessage[], run: ChatRunState): number {
    const start = currentResponseStart(messages);
    const assistantText = run.assistant?.text || "";
    for (let index = messages.length - 1; index >= start; index -= 1) {
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
        if (!assistantText && run.phase !== "active" && message.text.trim()) {
            return index;
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
    return (message.thinking || []).map((block) =>
        JSON.stringify({ id: block.id || "", text: block.text })
    );
}

function isDiagnosticRecovered(
    diagnostic: ChatHistoryMessage,
    messages: ChatHistoryMessage[],
    responseStart: number,
    run: ChatRunState
): boolean {
    const candidates = messages.slice(responseStart);
    const tool = new Set(toolSignatures(diagnostic));
    const thinking = new Set(thinkingSignatures(diagnostic));
    const identity = messageIdentity(diagnostic);

    return candidates.some((candidate) => {
        if (candidate.runId && !isRunMatchingMessage(run, candidate)) {
            return false;
        }
        if (messageIdentity(candidate) === identity) {
            return true;
        }
        if (
            tool.size > 0 &&
            toolSignatures(candidate).some((signature) => tool.has(signature))
        ) {
            return true;
        }
        return (
            thinking.size > 0 &&
            thinkingSignatures(candidate).some((signature) => thinking.has(signature))
        );
    });
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
        const responseStart = currentResponseStart(messages);
        const diagnostics = run.diagnostics
            .toSorted(
                (left, right) =>
                    diagnosticRank(left.message) - diagnosticRank(right.message)
            )
            .map((entry) => transientMessage(entry.message, run, entry.key))
            .filter(
                (message) => !isDiagnosticRecovered(message, messages, responseStart, run)
            );
        const finalIndex = canonicalFinalIndex(messages, run);
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

        messages.push(...diagnostics);
        if (run.assistant) {
            messages.push(transientMessage(run.assistant, run, "assistant"));
        }
    }
    return dedupeMessages(messages);
}

function visibleRunIds(messages: ChatHistoryMessage[]): Set<string> {
    return new Set(
        messages
            .filter((message) => message.local === true)
            .map((message) => message.runId)
            .filter((runId): runId is string => Boolean(runId))
    );
}

function statusRow(
    runs: ChatRunState[],
    visibleRunIdSet: Set<string>
): ChatRow | undefined {
    const run = runs
        .filter((candidate) => candidate.phase === "active")
        .toSorted((left, right) => right.lastSequence - left.lastSequence)
        .find(
            (candidate) =>
                !visibleRunIdSet.has(candidate.runId) &&
                candidate.aliases.every((alias) => !visibleRunIdSet.has(alias))
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
    const session = runtime.sessions[sessionKey];
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
    const typing = statusRow(runs, visibleRunIds(presented));
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
