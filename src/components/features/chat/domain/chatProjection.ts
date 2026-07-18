import {
    type ChatHistoryMessage,
    type ChatRow,
    type ChatVisibilitySettings,
    TOOL_ROLE_VARIANTS,
} from "../chatTypes";
import {
    dedupeMessages,
    insertMessagesByTimestamp,
    isRecoveredAssistantText,
    mergeChatMessageDetails,
    messageDeleteKey,
    messageIdentity,
    messageMediaIdentity,
    stableChatStringify,
} from "../chatUtilities";
import { hasPrimaryAnswerContent, presentChatMessages } from "./chatPresentation";
import type {
    ChatRunState,
    ChatRuntimeState,
    ChatSessionRuntimeState,
} from "./chatState";
import { findChatSessionRuntimeState } from "./chatState";

const RUN_START_USER_SKEW_MS = 1000;
const RUNTIME_USER_ECHO_WINDOW_MS = 5000;

export interface ChatProjection {
    activeRuns: ChatRunState[];
    compactionStatus?: ChatCompactionStatus;
    rows: ChatRow[];
}

export interface ChatCompactionStatus {
    key: string;
    phase: "active" | "complete";
    text: string;
    timestamp: string;
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

function isDashboardRunId(runId?: string): boolean {
    return Boolean(
        runId?.startsWith("dashboard-chat-") || runId?.startsWith("dashboard-compact-")
    );
}

function isStandaloneDiagnostic(message: ChatHistoryMessage): boolean {
    const hasToolDetails = Boolean(message.toolCalls?.length || message.toolResult);
    return Boolean(
        (hasToolDetails && message.isFinal !== true) ||
        (message.thinking?.length &&
            (!message.text.trim() ||
                TOOL_ROLE_VARIANTS.includes(message.role.toLowerCase())))
    );
}

function stableDiagnosticRowKey(message: ChatHistoryMessage): string | undefined {
    if (!message.runId || !isStandaloneDiagnostic(message)) {
        return undefined;
    }
    if (message.thinking?.length && !message.toolCalls?.length && !message.toolResult) {
        return `diagnostic-${message.runId}-thinking`;
    }
    const toolCalls = message.toolCalls || [];
    const toolCallIds = toolCalls
        .map((toolCall) => toolCall.id)
        .filter((id): id is string => Boolean(id));
    if (toolCalls.length > 0 && toolCallIds.length === toolCalls.length) {
        return `diagnostic-${message.runId}-tool-call-${toolCallIds.join(":")}`;
    }
    if (toolCalls.length === 0 && message.toolResult?.id) {
        return `diagnostic-${message.runId}-tool-result-${message.toolResult.id}`;
    }
    return undefined;
}

function userMessageDeleteKey(message: ChatHistoryMessage): string {
    return messageDeleteKey({
        ...message,
        runId: undefined,
        runtimeKey: undefined,
    });
}

function projectedMessageRowKey(message: ChatHistoryMessage): string {
    if (isUserMessage(message)) {
        return userMessageDeleteKey(message);
    }
    return (
        stableDiagnosticRowKey(message) ||
        (message.local === true && message.runId
            ? `stream-${message.runId}-${message.runtimeKey || messageDeleteKey(message)}`
            : messageDeleteKey(message))
    );
}

/** Keeps persisted delete keys valid when runtime reconciliation adds a run id. */
function projectedMessageDeleteKeys(message: ChatHistoryMessage): string[] {
    const currentKey = projectedMessageRowKey(message);
    if (message.role.toLowerCase() !== "user" || !message.runId) {
        return [currentKey];
    }
    const persistedHistoryKey = userMessageDeleteKey(message);
    return currentKey === persistedHistoryKey
        ? [currentKey]
        : [currentKey, persistedHistoryKey];
}

function isMatchedToAnotherRun(
    message: ChatHistoryMessage,
    run: ChatRunState,
    runs: ChatRunState[]
): boolean {
    return runs.some((candidate) => {
        const isUnacknowledgedDashboardRun =
            candidate.phase === "active" &&
            !candidate.assistant &&
            candidate.diagnostics.length === 0 &&
            isDashboardRunId(candidate.runId);
        return (
            candidate.runId !== run.runId &&
            !isUnacknowledgedDashboardRun &&
            isRunMatchingMessage(candidate, message)
        );
    });
}

function canUseDashboardTurn(
    message: ChatHistoryMessage,
    run: ChatRunState,
    runs: ChatRunState[]
): boolean {
    return (
        isDashboardRunId(message.runId) &&
        (isRunMatchingMessage(run, message) || !isMatchedToAnotherRun(message, run, runs))
    );
}

function userBoundaryIndex(
    messages: ChatHistoryMessage[],
    run: ChatRunState,
    runs: ChatRunState[]
): number {
    let userIndex = messages.findLastIndex(
        (message) => isUserMessage(message) && isRunMatchingMessage(run, message)
    );
    const startedAt = Date.parse(run.startedAt);

    if (!Number.isNaN(startedAt)) {
        const startBoundary = messages.findLastIndex((message) => {
            const timestamp = messageTimestamp(message);
            return (
                isUserMessage(message) &&
                (!message.runId || canUseDashboardTurn(message, run, runs)) &&
                timestamp !== undefined &&
                timestamp <= startedAt + RUN_START_USER_SKEW_MS
            );
        });
        userIndex = Math.max(userIndex, startBoundary);
    }

    if (userIndex === -1 && Number.isNaN(startedAt)) {
        const matchingIndex = messages.findIndex((message) =>
            isRunMatchingMessage(run, message)
        );
        userIndex = messages.findLastIndex(
            (message, index) => index < matchingIndex && isUserMessage(message)
        );
    }

    const terminalAt = Date.parse(run.terminalAt ?? run.updatedAt);
    const dashboardBoundary = messages.findLastIndex((message) => {
        const timestamp = messageTimestamp(message);
        return (
            isUserMessage(message) &&
            canUseDashboardTurn(message, run, runs) &&
            timestamp !== undefined &&
            (Number.isNaN(startedAt) ||
                timestamp >= startedAt - RUN_START_USER_SKEW_MS) &&
            (run.phase === "active" ||
                (!Number.isNaN(terminalAt) && timestamp <= terminalAt))
        );
    });
    return Math.max(userIndex, dashboardBoundary);
}

function responseSegment(
    messages: ChatHistoryMessage[],
    run: ChatRunState,
    runs: ChatRunState[]
): ResponseSegment {
    const userIndex = userBoundaryIndex(messages, run, runs);
    const start = userIndex === -1 ? currentResponseStart(messages) : userIndex + 1;
    const nextUserOffset = messages
        .slice(start)
        .findIndex((message) => isUserMessage(message));
    return {
        end: nextUserOffset === -1 ? messages.length : start + nextUserOffset,
        start,
    };
}

function hasUnansweredUserBeforeSegment(
    messages: ChatHistoryMessage[],
    segment: ResponseSegment
): boolean {
    const boundaryIndex = segment.start - 1;
    if (boundaryIndex < 0 || !isUserMessage(messages[boundaryIndex]!)) {
        return false;
    }
    const previousUserIndex = messages.findLastIndex(
        (message, index) => index < boundaryIndex && isUserMessage(message)
    );
    if (previousUserIndex === -1) {
        return false;
    }
    return !messages.slice(previousUserIndex + 1, boundaryIndex).some((message) => {
        const role = message.role.toLowerCase();
        return (
            (role === "assistant" || role === "system") &&
            hasPrimaryAnswerContent(message)
        );
    });
}

function canonicalFinalIndex(
    messages: ChatHistoryMessage[],
    run: ChatRunState,
    segment: ResponseSegment
): number {
    const assistantText = run.assistant?.text || "";
    const hasOverlappingUserTurn = hasUnansweredUserBeforeSegment(messages, segment);
    for (let index = segment.end - 1; index >= segment.start; index -= 1) {
        const message = messages[index]!;
        const role = message.role.toLowerCase();
        if (role !== "assistant" && role !== "system") {
            continue;
        }
        if (isStandaloneDiagnostic(message)) {
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
            if (hasOverlappingUserTurn) {
                continue;
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
    const signatures: string[] = [];
    const nestedResultSignatures: string[] = [];
    const toolCalls = message.toolCalls || [];
    const resultSignature = (result: NonNullable<ChatHistoryMessage["toolResult"]>) =>
        stableChatStringify({
            result: {
                content: result.content,
                error: result.isError || false,
                id: result.id || "",
                images: result.images || [],
                name: result.name || "",
            },
        });
    for (const call of toolCalls) {
        signatures.push(
            stableChatStringify({
                arguments: call.arguments ?? undefined,
                id: call.id || "",
                name: call.name,
            })
        );
        if (call.toolResult) {
            const signature = resultSignature(call.toolResult);
            signatures.push(signature);
            nestedResultSignatures.push(signature);
        }
    }
    if (message.toolResult) {
        const signature = resultSignature(message.toolResult);
        if (!nestedResultSignatures.includes(signature)) {
            signatures.push(signature);
        }
    }
    return signatures;
}

function thinkingSignatures(message: ChatHistoryMessage): string[] {
    return (message.thinking || []).map((block) => block.text);
}

function diagnosticSignatures(message: ChatHistoryMessage): string[] {
    return [
        ...toolSignatures(message).map((signature) => `tool:${signature}`),
        ...thinkingSignatures(message).map((signature) => `thinking:${signature}`),
    ];
}

function countSignatures(signatures: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const signature of signatures) {
        counts.set(signature, (counts.get(signature) || 0) + 1);
    }
    return counts;
}

function consumeCandidateSignatures(
    message: ChatHistoryMessage,
    claimed: ReadonlyMap<string, number>,
    remaining: Map<string, number>
): Map<string, number> {
    const consumed = new Map<string, number>();
    const availableSignatures = countSignatures(diagnosticSignatures(message));
    for (const [signature, availableCount] of availableSignatures) {
        const remainingCount = remaining.get(signature) || 0;
        const unclaimedCount = availableCount - (claimed.get(signature) || 0);
        const consumedCount = Math.min(remainingCount, unclaimedCount);
        if (consumedCount > 0) {
            remaining.set(signature, remainingCount - consumedCount);
            consumed.set(signature, consumedCount);
        }
    }
    return consumed;
}

function recoveredDiagnosticIndexes(
    diagnostic: ChatHistoryMessage,
    messages: ChatHistoryMessage[],
    segment: ResponseSegment,
    run: ChatRunState,
    claimedSignatures: Map<number, Map<string, number>>
): number[] | undefined {
    const candidates = messages
        .slice(segment.start, segment.end)
        .map((message, offset) => ({ index: segment.start + offset, message }))
        .filter(
            (candidate) =>
                !candidate.message.runId || isRunMatchingMessage(run, candidate.message)
        );
    const expected = diagnosticSignatures(diagnostic);
    if (expected.length === 0) {
        return undefined;
    }
    const remaining = countSignatures(expected);
    const consumedByIndex = new Map<number, Map<string, number>>();
    for (const candidate of candidates) {
        const consumed = consumeCandidateSignatures(
            candidate.message,
            claimedSignatures.get(candidate.index) || new Map(),
            remaining
        );
        if (consumed.size > 0) {
            consumedByIndex.set(candidate.index, consumed);
        }
    }
    if (remaining.values().some((count) => count > 0)) {
        return undefined;
    }
    for (const [index, consumed] of consumedByIndex) {
        const claimed = claimedSignatures.get(index) || new Map<string, number>();
        for (const [signature, count] of consumed) {
            claimed.set(signature, (claimed.get(signature) || 0) + count);
        }
        claimedSignatures.set(index, claimed);
    }
    return consumedByIndex.keys().toArray();
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

function isMatchingRuntimeUser(
    candidate: ChatHistoryMessage,
    runtimeMessage: ChatHistoryMessage,
    run: ChatRunState
): boolean {
    if (!isUserMessage(candidate) || !isUserMessage(runtimeMessage)) {
        return false;
    }
    const areIdentitiesMatching =
        messageIdentity(candidate) === messageIdentity(runtimeMessage);
    const candidateMediaIdentity = messageMediaIdentity(candidate);
    const isMediaOnlyContentMatching = Boolean(
        !candidate.text.trim() &&
        !runtimeMessage.text.trim() &&
        candidateMediaIdentity &&
        candidateMediaIdentity === messageMediaIdentity(runtimeMessage)
    );
    if (!areIdentitiesMatching && !isMediaOnlyContentMatching) {
        return false;
    }
    const candidateTimestamp = messageTimestamp(candidate);
    const runtimeTimestamp = messageTimestamp(runtimeMessage);
    const canAdoptCandidateRun =
        !candidate.runId ||
        isRunMatchingMessage(run, candidate) ||
        isDashboardRunId(candidate.runId);
    if (!canAdoptCandidateRun) {
        return false;
    }
    if (candidateTimestamp === undefined || runtimeTimestamp === undefined) {
        return true;
    }
    return Math.abs(candidateTimestamp - runtimeTimestamp) <= RUNTIME_USER_ECHO_WINDOW_MS;
}

function runtimeUserMatchIndex(
    messages: ChatHistoryMessage[],
    runtimeMessage: ChatHistoryMessage,
    run: ChatRunState,
    claimedCandidates: ReadonlySet<ChatHistoryMessage>
): number {
    const runtimeTimestamp = messageTimestamp(runtimeMessage);
    let bestDistance = Infinity;
    let bestIndex = -1;
    for (const [index, candidate] of messages.entries()) {
        if (
            claimedCandidates.has(candidate) ||
            !isMatchingRuntimeUser(candidate, runtimeMessage, run)
        ) {
            continue;
        }
        const candidateTimestamp = messageTimestamp(candidate);
        const distance =
            candidateTimestamp === undefined || runtimeTimestamp === undefined
                ? 0
                : Math.abs(candidateTimestamp - runtimeTimestamp);
        if (distance < bestDistance || (distance === bestDistance && index > bestIndex)) {
            bestDistance = distance;
            bestIndex = index;
        }
    }
    return bestIndex;
}

function mergeAllRuntimeUserMessages(
    messages: ChatHistoryMessage[],
    runs: ChatRunState[]
): ChatHistoryMessage[] {
    const next = [...messages];
    const recoveredCandidates = new Set<ChatHistoryMessage>();
    const missingMessages: ChatHistoryMessage[] = [];
    const runtimeMessages = runs
        .flatMap((run) => run.userMessages.map((entry) => ({ entry, run })))
        .toReversed();
    for (const { entry, run } of runtimeMessages) {
        const runtimeMessage = transientMessage(entry.message, run, entry.key);
        const recoveredIndex = runtimeUserMatchIndex(
            next,
            runtimeMessage,
            run,
            recoveredCandidates
        );
        if (recoveredIndex === -1) {
            missingMessages.push(runtimeMessage);
            continue;
        }
        const recovered = next[recoveredIndex]!;
        const enriched = {
            ...recovered,
            runId: run.runId,
        };
        next[recoveredIndex] = enriched;
        recoveredCandidates.add(enriched);
    }
    return insertMessagesByTimestamp(next, missingMessages.toReversed());
}

/** Reconciles history with the current provider-independent runtime turn. */
export function reconcileChatMessages(
    history: ChatHistoryMessage[],
    session?: ChatSessionRuntimeState
): ChatHistoryMessage[] {
    const runs = orderedRuns(session);
    const messages = mergeAllRuntimeUserMessages(history, runs);
    for (const run of runs) {
        for (const [index, message] of messages.entries()) {
            const shouldUseCanonicalRunId =
                (isUserMessage(message) || isStandaloneDiagnostic(message)) &&
                isRunMatchingMessage(run, message) &&
                message.runId !== run.runId;
            if (shouldUseCanonicalRunId) {
                messages[index] = { ...message, runId: run.runId };
            }
        }
        const segment = responseSegment(messages, run, runs);
        const diagnostics: ChatHistoryMessage[] = [];
        const claimedRecoveredSignatures = new Map<number, Map<string, number>>();
        for (const entry of run.diagnostics) {
            const diagnostic = transientMessage(entry.message, run, entry.key);
            const recoveredIndexes = recoveredDiagnosticIndexes(
                diagnostic,
                messages,
                segment,
                run,
                claimedRecoveredSignatures
            );
            if (recoveredIndexes) {
                for (const index of recoveredIndexes) {
                    messages[index] = { ...messages[index]!, runId: run.runId };
                }
            } else {
                diagnostics.push(diagnostic);
            }
        }
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

function isAssistantTextStream(message: ChatHistoryMessage): boolean {
    return Boolean(
        message.role.toLowerCase() === "assistant" &&
        message.text.trim() &&
        !message.thinking?.length &&
        !message.toolCalls?.length &&
        !message.toolResult
    );
}

function visibleAssistantStreamRunIds(
    presented: ChatHistoryMessage[],
    runs: ChatRunState[]
): ReadonlySet<string> {
    return new Set(
        runs.flatMap((run) => {
            const latestVisibleTurnMessage = presented.findLast(
                (message) =>
                    isRunMatchingMessage(run, message) &&
                    (isUserMessage(message) || isAssistantTextStream(message))
            );
            return run.lastContentKind === "assistant" &&
                latestVisibleTurnMessage &&
                isAssistantTextStream(latestVisibleTurnMessage)
                ? [run.runId, ...run.aliases]
                : [];
        })
    );
}

function statusRow(
    runs: ChatRunState[],
    visibleStreamRunIds: ReadonlySet<string>
): ChatRow | undefined {
    const run = runs
        .toSorted((left, right) => right.lastSequence - left.lastSequence)
        .find(
            (candidate) =>
                candidate.operation !== "compact" &&
                !visibleStreamRunIds.has(candidate.runId) &&
                candidate.aliases.every((alias) => !visibleStreamRunIds.has(alias))
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

function currentCompactionStatus(runs: ChatRunState[]): ChatCompactionStatus | undefined {
    const run = runs
        .filter((candidate) => candidate.operation === "compact")
        .toSorted((left, right) => {
            const leftTimestamp = Date.parse(
                left.operationUpdatedAt || left.terminalAt || left.updatedAt
            );
            const rightTimestamp = Date.parse(
                right.operationUpdatedAt || right.terminalAt || right.updatedAt
            );
            return rightTimestamp - leftTimestamp;
        })[0];
    if (!run) {
        return undefined;
    }
    if (run.operationPhase === "inactive") {
        return undefined;
    }
    const phase =
        run.operationPhase === "complete" || run.phase !== "active"
            ? "complete"
            : "active";
    const timestamp = run.operationUpdatedAt || run.terminalAt || run.updatedAt;
    return {
        key: `${run.sessionKey}:${run.runId}:${phase}:${timestamp}`,
        phase,
        text: phase === "active" ? "Compacting context" : "Context compacted",
        timestamp,
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
    const boundaryMessages = mergeAllRuntimeUserMessages(history, runs);
    const reconciled = reconcileChatMessages(history, session);
    const presented = presentChatMessages(
        reconciled,
        visibility,
        shouldKeepThinkingAfterFinal
    ).filter((message) =>
        projectedMessageDeleteKeys(message).every((key) => !deletedMessageKeys.has(key))
    );
    const rows: ChatRow[] = presented.map((message) => {
        return {
            key: projectedMessageRowKey(message),
            kind:
                message.local === true && message.runId && !isUserMessage(message)
                    ? "stream"
                    : "message",
            message,
        };
    });
    const activeRuns = runs.filter(
        (run) =>
            run.phase === "active" &&
            run.operation !== "compact" &&
            canonicalFinalIndex(
                boundaryMessages,
                run,
                responseSegment(boundaryMessages, run, runs)
            ) === -1
    );
    const typing = statusRow(
        activeRuns,
        visibleAssistantStreamRunIds(presented, activeRuns)
    );
    if (typing) {
        rows.push(typing);
    }

    const compactionStatus = currentCompactionStatus(runs);
    return {
        activeRuns,
        compactionStatus,
        rows,
    };
}
