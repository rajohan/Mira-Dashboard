import { canonicalChatContentFingerprint } from "../../../../../../contracts/chatCanonicalMessage";
import {
    type ChatHistoryMessage,
    type ChatRow,
    type ChatVisibilitySettings,
} from "../chatTypes";
import {
    dedupeMessages,
    insertMessagesByTimestamp,
    isRecoveredAssistantText,
    mergeChatMessageDetails,
    messageIdentity,
    messageMediaIdentity,
} from "../chatUtilities";
import {
    hasPrimaryAnswerContent,
    presentStructuredChatMessages,
    structureChatMessages,
} from "./chatPresentation";
import {
    exactToolIds,
    exactToolResultIds,
    type ExactToolMessageIndex,
    indexExactToolMessages,
    recoveredDiagnosticIndexes,
    refreshExactToolCalls,
    refreshExactToolResults,
} from "./chatProjectionDiagnostics";
import {
    asAssistantToolResultMessage,
    currentResponseStart,
    isDashboardRunId,
    isGatewayRestartContinuation,
    isRunMatchingMessage,
    isStandaloneDiagnostic,
    isUserMessage,
    messageTimestamp,
    orderedRuns,
    projectedMessageDeleteIdentity,
    projectedMessageRowKey,
    type ResponseSegment,
    RUN_START_USER_SKEW_MS,
    RUNTIME_FINAL_SKEW_MS,
    RUNTIME_USER_ECHO_WINDOW_MS,
} from "./chatProjectionIdentity";
import type {
    ChatRunState,
    ChatRuntimeState,
    ChatSessionRuntimeState,
} from "./chatState";
import { findChatSessionRuntimeState } from "./chatState";

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

function projectedMessageDisplay(message: ChatHistoryMessage): ChatHistoryMessage {
    const withoutToolCommentary = message.isToolUse ? { ...message, text: "" } : message;
    return asAssistantToolResultMessage(withoutToolCommentary);
}

function isMatchedToAnotherRun(
    message: ChatHistoryMessage,
    run: ChatRunState,
    runs: ChatRunState[]
): boolean {
    return runs.some((candidate) => {
        const isDashboardSteerOnlyRun =
            isDashboardRunId(candidate.runId) &&
            !candidate.assistant &&
            candidate.diagnostics.length === 0 &&
            (candidate.phase === "active" ||
                (candidate.phase === "completed" &&
                    candidate.lastContentKind === "user" &&
                    candidate.userMessages.length > 0));
        return (
            candidate.runId !== run.runId &&
            !isDashboardSteerOnlyRun &&
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

function latestExactToolMessageIndex(
    ids: ReadonlySet<string>,
    exactToolIndex: ExactToolMessageIndex,
    minimumIndex = 0,
    maximumIndex = Infinity
): number {
    let latestIndex = -1;
    for (const id of ids) {
        const messageIndexes = exactToolIndex.get(id) || [];
        for (const index of messageIndexes) {
            if (index >= minimumIndex && index < maximumIndex) {
                latestIndex = Math.max(latestIndex, index);
            }
        }
    }
    return latestIndex;
}

function isEligibleRunPrompt(message: ChatHistoryMessage, run: ChatRunState): boolean {
    if (!isUserMessage(message) || !isRunMatchingMessage(run, message)) {
        return false;
    }
    const startedAt = Date.parse(run.startedAt);
    const timestamp = messageTimestamp(message);
    return (
        Number.isNaN(startedAt) ||
        timestamp === undefined ||
        timestamp <= startedAt + RUN_START_USER_SKEW_MS
    );
}

function sequencedRunPromptIndex(
    messages: ChatHistoryMessage[],
    run: ChatRunState
): number | undefined {
    return messages
        .map((message, index) => ({ index, message }))
        .filter(
            ({ message }) =>
                isEligibleRunPrompt(message, run) && message.runtimeSequence !== undefined
        )
        .toSorted(
            (left, right) =>
                left.message.runtimeSequence! - right.message.runtimeSequence! ||
                left.index - right.index
        )[0]?.index;
}

function runFinalAnchorIndex(
    messages: ChatHistoryMessage[],
    run: ChatRunState,
    exactToolIndex: ExactToolMessageIndex
): number {
    const explicitMatch = messages.findLastIndex((message) => {
        const role = message.role.toLowerCase();
        return (
            (role === "assistant" || role === "system") &&
            !isStandaloneDiagnostic(message) &&
            isRunMatchingMessage(run, message)
        );
    });
    if (explicitMatch !== -1) {
        return explicitMatch;
    }

    const diagnosticIds = new Set(
        run.diagnostics.flatMap((entry) => [...exactToolIds(entry.message)])
    );
    if (diagnosticIds.size > 0) {
        const startedAt = Date.parse(run.startedAt);
        let diagnosticBoundaryIndex =
            sequencedRunPromptIndex(messages, run) ??
            messages.findLastIndex((message) => isEligibleRunPrompt(message, run));
        if (diagnosticBoundaryIndex === -1 && !Number.isNaN(startedAt)) {
            diagnosticBoundaryIndex = messages.findLastIndex((message) => {
                const timestamp = messageTimestamp(message);
                return (
                    isUserMessage(message) &&
                    timestamp !== undefined &&
                    timestamp <= startedAt
                );
            });
            if (diagnosticBoundaryIndex === -1) {
                diagnosticBoundaryIndex = messages.findLastIndex((message) => {
                    const timestamp = messageTimestamp(message);
                    return (
                        isUserMessage(message) &&
                        timestamp !== undefined &&
                        timestamp <= startedAt + RUN_START_USER_SKEW_MS
                    );
                });
            }
        }
        const nextUserIndex =
            diagnosticBoundaryIndex === -1
                ? -1
                : messages.findIndex(
                      (message, index) =>
                          index > diagnosticBoundaryIndex &&
                          isUserMessage(message) &&
                          !isRunMatchingMessage(run, message) &&
                          !isGatewayRestartContinuation(message)
                  );
        const end = nextUserIndex === -1 ? messages.length : nextUserIndex;
        const evidenceIndex = latestExactToolMessageIndex(
            diagnosticIds,
            exactToolIndex,
            diagnosticBoundaryIndex + 1,
            end
        );
        if (evidenceIndex !== -1) {
            const isAnswerCandidate = (message: ChatHistoryMessage, index: number) => {
                const role = message.role.toLowerCase();
                return (
                    index > evidenceIndex &&
                    index < end &&
                    (role === "assistant" || role === "system") &&
                    !isStandaloneDiagnostic(message) &&
                    hasPrimaryAnswerContent(message)
                );
            };
            const explicitFinalIndex = messages.findIndex(
                (message, index) =>
                    message.isFinal === true && isAnswerCandidate(message, index)
            );
            if (explicitFinalIndex !== -1) {
                return explicitFinalIndex;
            }
            const answerIndex = messages.findIndex((message, index) =>
                isAnswerCandidate(message, index)
            );
            if (answerIndex !== -1) {
                return answerIndex;
            }
        }
    }

    const assistantText = run.assistant?.text;
    const terminalTimestamp = Date.parse(run.terminalAt ?? run.updatedAt);
    if (!assistantText || Number.isNaN(terminalTimestamp)) {
        return -1;
    }
    let closestIndex = -1;
    let closestDistance = Infinity;
    for (const [index, message] of messages.entries()) {
        const role = message.role.toLowerCase();
        const timestamp = messageTimestamp(message);
        if (
            timestamp === undefined ||
            message.runId ||
            (role !== "assistant" && role !== "system") ||
            isStandaloneDiagnostic(message) ||
            !isRecoveredAssistantText(message.text, assistantText)
        ) {
            continue;
        }
        const distance = Math.abs(timestamp - terminalTimestamp);
        if (
            distance <= RUNTIME_FINAL_SKEW_MS &&
            (distance < closestDistance ||
                (distance === closestDistance && index > closestIndex))
        ) {
            closestDistance = distance;
            closestIndex = index;
        }
    }
    return closestIndex;
}

function userBoundaryIndex(
    messages: ChatHistoryMessage[],
    run: ChatRunState,
    runs: ChatRunState[],
    exactToolIndex: ExactToolMessageIndex
): number {
    const finalAnchorIndex = runFinalAnchorIndex(messages, run, exactToolIndex);
    const isBeforeFinalAnchor = (_message: ChatHistoryMessage, index: number) =>
        finalAnchorIndex === -1 || index < finalAnchorIndex;
    const sequencedPromptIndex = sequencedRunPromptIndex(messages, run);
    if (sequencedPromptIndex !== undefined) {
        return sequencedPromptIndex;
    }
    let userIndex = messages.findLastIndex(
        (message, index) =>
            isBeforeFinalAnchor(message, index) &&
            isUserMessage(message) &&
            isRunMatchingMessage(run, message)
    );
    const startedAt = Date.parse(run.startedAt);

    if (!Number.isNaN(startedAt)) {
        const startBoundary = messages.findLastIndex((message, index) => {
            const timestamp = messageTimestamp(message);
            return (
                isBeforeFinalAnchor(message, index) &&
                isUserMessage(message) &&
                (!message.runId || canUseDashboardTurn(message, run, runs)) &&
                timestamp !== undefined &&
                timestamp <= startedAt + RUN_START_USER_SKEW_MS
            );
        });
        const hasSettledAnswerBeforeMatchingUser =
            startBoundary !== -1 &&
            userIndex > startBoundary &&
            messages.slice(startBoundary + 1, userIndex).some((message) => {
                const role = message.role.toLowerCase();
                return (
                    (role === "assistant" || role === "system") &&
                    hasPrimaryAnswerContent(message)
                );
            });
        if (startBoundary !== -1 && !hasSettledAnswerBeforeMatchingUser) {
            userIndex = startBoundary;
        }
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
    const dashboardBoundary = messages.findLastIndex((message, index) => {
        const timestamp = messageTimestamp(message);
        return (
            isBeforeFinalAnchor(message, index) &&
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
    runs: ChatRunState[],
    exactToolIndex: ExactToolMessageIndex
): ResponseSegment {
    const userIndex = userBoundaryIndex(messages, run, runs, exactToolIndex);
    const start = userIndex === -1 ? currentResponseStart(messages) : userIndex + 1;
    const nextUserOffset = messages
        .slice(start)
        .findIndex(
            (message) => isUserMessage(message) && !isRunMatchingMessage(run, message)
        );
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
    segment: ResponseSegment,
    exactToolIndex: ExactToolMessageIndex
): number {
    const assistantText = run.assistant?.text || "";
    const hasOverlappingUserTurn = hasUnansweredUserBeforeSegment(messages, segment);
    const anchoredFinalIndex = runFinalAnchorIndex(messages, run, exactToolIndex);
    for (let index = segment.end - 1; index >= segment.start; index -= 1) {
        const message = messages[index]!;
        const role = message.role.toLowerCase();
        if (role !== "assistant" && role !== "system") {
            continue;
        }
        if (isStandaloneDiagnostic(message)) {
            continue;
        }
        if (index === anchoredFinalIndex) {
            return index;
        }
        if (isRunMatchingMessage(run, message)) {
            return index;
        }
        if (message.runId) {
            continue;
        }
        if (!assistantText && hasPrimaryAnswerContent(message)) {
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
                finalTimestamp + RUNTIME_FINAL_SKEW_MS >= latestEvidenceTimestamp
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

function completedDiagnosticStart(
    messages: ChatHistoryMessage[],
    segment: ResponseSegment,
    finalIndex: number
): number {
    for (let index = finalIndex - 1; index >= segment.start; index -= 1) {
        const message = messages[index];
        if (
            message &&
            !isStandaloneDiagnostic(message) &&
            hasPrimaryAnswerContent(message)
        ) {
            return index + 1;
        }
    }
    return segment.start;
}

function isMatchingFinalEvidence(
    message: ChatHistoryMessage | undefined,
    assistantText: string,
    assistantMediaIdentity: string | undefined
): boolean {
    if (!message) {
        return false;
    }
    if (assistantText && !isRecoveredAssistantText(message.text, assistantText)) {
        return false;
    }
    return (
        !assistantMediaIdentity ||
        messageMediaIdentity(message) === assistantMediaIdentity
    );
}

function hasUnambiguousFinalEvidence(
    messages: ChatHistoryMessage[],
    run: ChatRunState,
    segment: ResponseSegment,
    finalIndex: number,
    exactToolIndex: ExactToolMessageIndex
): boolean {
    const canonicalFinal = messages[finalIndex];
    if (canonicalFinal && isRunMatchingMessage(run, canonicalFinal)) {
        return true;
    }
    if (runFinalAnchorIndex(messages, run, exactToolIndex) === finalIndex) {
        return true;
    }
    if (!run.assistant || !hasPrimaryAnswerContent(run.assistant)) {
        return false;
    }
    const assistantText = run.assistant.text;
    const assistantMediaIdentity = messageMediaIdentity(run.assistant);
    if (!assistantText && !assistantMediaIdentity) {
        return false;
    }
    if (!isMatchingFinalEvidence(canonicalFinal, assistantText, assistantMediaIdentity)) {
        return false;
    }
    let matchingFinals = 0;
    for (let index = segment.start; index < segment.end; index += 1) {
        const message = messages[index];
        const role = message?.role.toLowerCase();
        const isMatchingFinal = Boolean(
            message &&
            !message.runId &&
            (role === "assistant" || role === "system") &&
            !isStandaloneDiagnostic(message) &&
            isMatchingFinalEvidence(message, assistantText, assistantMediaIdentity)
        );
        if (isMatchingFinal) {
            matchingFinals += 1;
        }
    }
    return matchingFinals === 1;
}

function scopeCanonicalResponse(
    messages: ChatHistoryMessage[],
    run: ChatRunState,
    segment: ResponseSegment,
    finalIndex: number,
    exactToolIndex: ExactToolMessageIndex
): void {
    const canonicalFinal = messages[finalIndex];
    const isAnchoredRecoveredFinal =
        run.phase === "active" &&
        canonicalFinal?.isFinal === true &&
        runFinalAnchorIndex(messages, run, exactToolIndex) === finalIndex;
    if (!isAnchoredRecoveredFinal && run.phase !== "completed") {
        return;
    }
    if (
        !hasUnambiguousFinalEvidence(messages, run, segment, finalIndex, exactToolIndex)
    ) {
        return;
    }
    const diagnosticStart = completedDiagnosticStart(messages, segment, finalIndex);
    for (let index = diagnosticStart; index <= finalIndex; index += 1) {
        const message = messages[index];
        const belongsToCompletedRun =
            index === finalIndex || (message && isStandaloneDiagnostic(message));
        if (message && belongsToCompletedRun && !message.runId) {
            messages[index] = { ...message, runId: run.runId };
        }
    }
}

function transientMessage(
    message: ChatHistoryMessage,
    run: ChatRunState,
    runtimeKey: string,
    runtimeSequence?: number
): ChatHistoryMessage {
    return {
        ...message,
        local: true,
        runId: run.runId,
        runtimeKey,
        runtimeSequence,
        timestamp: message.timestamp || run.updatedAt,
    };
}

function assistantRuntimeSequence(run: ChatRunState): number | undefined {
    return run.phase === "active"
        ? run.lastContentSequence
        : (run.terminalSequence ?? run.lastContentSequence);
}

function scopeTranscriptUsersToRuns(
    messages: ChatHistoryMessage[],
    runs: ChatRunState[]
): ChatHistoryMessage[] {
    const exactToolIndex = indexExactToolMessages(messages);
    const windows = runs.flatMap((run) => {
        const sequencedPromptIndex = sequencedRunPromptIndex(messages, run);
        const startedAt = Date.parse(run.startedAt);
        const timestampPromptIndex = Number.isNaN(startedAt)
            ? -1
            : messages.findLastIndex((message) => {
                  const timestamp = messageTimestamp(message);
                  return (
                      isUserMessage(message) &&
                      (!message.runId ||
                          isRunMatchingMessage(run, message) ||
                          canUseDashboardTurn(message, run, runs)) &&
                      timestamp !== undefined &&
                      timestamp <= startedAt + RUN_START_USER_SKEW_MS
                  );
              });
        const explicitPromptIndex = messages.findIndex(
            (message) => isUserMessage(message) && isRunMatchingMessage(run, message)
        );
        const start =
            sequencedPromptIndex ??
            (timestampPromptIndex === -1 ? explicitPromptIndex : timestampPromptIndex);
        if (start === -1) {
            return [];
        }
        const finalIndex = runFinalAnchorIndex(messages, run, exactToolIndex);
        if (finalIndex === -1 && run.phase !== "active") {
            return [];
        }
        return [{ end: finalIndex === -1 ? messages.length : finalIndex, run, start }];
    });

    return messages.map((message, index) => {
        if (
            !isUserMessage(message) ||
            (message.runId && !isDashboardRunId(message.runId))
        ) {
            return message;
        }
        const matchingRun = windows
            .filter(
                (window) =>
                    index > window.start &&
                    index < window.end &&
                    (!message.runId || canUseDashboardTurn(message, window.run, runs))
            )
            .toSorted((left, right) => right.start - left.start)[0]?.run;
        return matchingRun ? { ...message, runId: matchingRun.runId } : message;
    });
}

function scopeTranscriptDiagnosticsToRuns(
    messages: ChatHistoryMessage[],
    runs: ChatRunState[]
): ChatHistoryMessage[] {
    const activeRuns = runs.filter((run) => run.phase === "active");
    if (activeRuns.length === 0) {
        return messages;
    }
    const exactToolIndex = indexExactToolMessages(messages);
    const candidates = new Map<number, ChatRunState[]>();
    for (const run of activeRuns) {
        const segment = responseSegment(messages, run, runs, exactToolIndex);
        for (let index = segment.start; index < segment.end; index += 1) {
            const message = messages[index];
            if (message && !message.runId && isStandaloneDiagnostic(message)) {
                candidates.set(index, [...(candidates.get(index) || []), run]);
            }
        }
    }
    return messages.map((message, index) => {
        const matchingRuns = candidates.get(index);
        return matchingRuns?.length === 1
            ? { ...message, runId: matchingRuns[0]!.runId }
            : message;
    });
}

function isFinalRunMessage(message: ChatHistoryMessage, run: ChatRunState): boolean {
    const role = message.role.toLowerCase();
    return (
        run.phase !== "active" &&
        message.isFinal === true &&
        (role === "assistant" || role === "system") &&
        hasPrimaryAnswerContent(message)
    );
}

function isThinkingOnlyRunMessage(message: ChatHistoryMessage): boolean {
    return Boolean(
        message.thinking?.length &&
        !message.toolCalls?.length &&
        !message.toolResult &&
        !hasPrimaryAnswerContent(message)
    );
}

interface IndexedChatMessage {
    index: number;
    message: ChatHistoryMessage;
    sequence?: number;
}

function insertUsersByTimestamp(
    activity: IndexedChatMessage[],
    users: IndexedChatMessage[]
): IndexedChatMessage[] {
    const ordered = [...activity];
    const timestampedUsers = users.toSorted((left, right) => {
        const leftTimestamp = messageTimestamp(left.message) ?? Infinity;
        const rightTimestamp = messageTimestamp(right.message) ?? Infinity;
        return leftTimestamp - rightTimestamp || left.index - right.index;
    });
    for (const user of timestampedUsers) {
        const userTimestamp = messageTimestamp(user.message);
        const insertionIndex = ordered.findIndex((slot) => {
            const slotTimestamp = messageTimestamp(slot.message);
            return (
                userTimestamp !== undefined &&
                slotTimestamp !== undefined &&
                slotTimestamp > userTimestamp
            );
        });
        if (insertionIndex === -1) {
            ordered.push(user);
        } else {
            ordered.splice(insertionIndex, 0, user);
        }
    }
    return ordered;
}

function isCompletedHistoryFinal(message: ChatHistoryMessage): boolean {
    const role = message.role.toLowerCase();
    return (
        (role === "assistant" || role === "system") &&
        message.isFinal === true &&
        !isStandaloneDiagnostic(message) &&
        hasPrimaryAnswerContent(message)
    );
}

function isMovableUser(slot: IndexedChatMessage): boolean {
    return (
        isUserMessage(slot.message) &&
        (!slot.message.runId || isDashboardRunId(slot.message.runId))
    );
}

/**
 * Restores causal user/tool order after completed restart batches lose runtime replay.
 * @param messages Messages value.
 * @param runs Runs value.
 * @returns Order completed history turns result.
 */
function orderCompletedHistoryTurns(
    messages: ChatHistoryMessage[],
    runs: ChatRunState[]
): ChatHistoryMessage[] {
    const next = [...messages];
    const exactToolIndex = indexExactToolMessages(messages);
    const runtimeFinalIndexes = new Set(
        runs
            .map((run) => runFinalAnchorIndex(messages, run, exactToolIndex))
            .filter((index) => index !== -1)
    );
    let segmentStart = 0;
    for (const [finalIndex, final] of messages.entries()) {
        if (runtimeFinalIndexes.has(finalIndex)) {
            segmentStart = finalIndex + 1;
            continue;
        }
        if (!isCompletedHistoryFinal(final)) {
            continue;
        }
        const segment = messages
            .slice(segmentStart, finalIndex + 1)
            .map((message, offset) => ({
                index: segmentStart + offset,
                message,
            }));
        const promptOffset = segment.findIndex((slot) => isUserMessage(slot.message));
        if (promptOffset !== -1) {
            const prefix = segment.slice(0, promptOffset);
            const prompt = segment[promptOffset]!;
            const turn = segment.slice(promptOffset + 1, -1);
            const users = turn.filter((slot) => isMovableUser(slot));
            const thinking = turn.filter((slot) =>
                isThinkingOnlyRunMessage(slot.message)
            );
            const activity = turn.filter(
                (slot) => !isMovableUser(slot) && !isThinkingOnlyRunMessage(slot.message)
            );
            const hasToolActivity = activity.some(
                (slot) => slot.message.toolCalls?.length || slot.message.toolResult
            );
            if (hasToolActivity && users.length > 0) {
                const ordered = [
                    ...prefix,
                    prompt,
                    ...insertUsersByTimestamp(activity, users),
                    ...thinking,
                    segment.at(-1)!,
                ];
                for (const [slotIndex, slot] of segment.entries()) {
                    next[slot.index] = ordered[slotIndex]!.message;
                }
            }
        }
        segmentStart = finalIndex + 1;
    }
    return next;
}

/**
 * Orders one run by provider sequence, inserting transcript-only users by time.
 * @param messages Messages value.
 * @param runs Runs value.
 * @returns Order runtime messages result.
 */
function orderRuntimeMessages(
    messages: ChatHistoryMessage[],
    runs: ChatRunState[]
): ChatHistoryMessage[] {
    const slotsByRun = new Map<string, IndexedChatMessage[]>();
    for (const [index, message] of messages.entries()) {
        if (
            !message.runId ||
            (message.runtimeSequence === undefined && !isUserMessage(message))
        ) {
            continue;
        }
        const slots = slotsByRun.get(message.runId) || [];
        slots.push({ index, message, sequence: message.runtimeSequence });
        slotsByRun.set(message.runId, slots);
    }
    const next = [...messages];
    for (const run of runs) {
        const runtimeSlots = slotsByRun.get(run.runId) || [];
        const startedAt = Date.parse(run.startedAt);
        const sequencedPrompt = runtimeSlots
            .filter(
                (slot) =>
                    isEligibleRunPrompt(slot.message, run) && slot.sequence !== undefined
            )
            .toSorted(
                (left, right) =>
                    (left.sequence ?? Infinity) - (right.sequence ?? Infinity) ||
                    left.index - right.index
            )[0];
        const timestampedPrompt = runtimeSlots
            .flatMap((slot) => {
                const timestamp = messageTimestamp(slot.message);
                const distance =
                    timestamp === undefined || Number.isNaN(startedAt)
                        ? Infinity
                        : Math.abs(timestamp - startedAt);
                return isUserMessage(slot.message) &&
                    slot.sequence === undefined &&
                    distance <= RUN_START_USER_SKEW_MS
                    ? [{ distance, slot }]
                    : [];
            })
            .toSorted(
                (left, right) =>
                    left.distance - right.distance || left.slot.index - right.slot.index
            )[0]?.slot;
        const untimestampedPrompt = runtimeSlots.find(
            (slot) =>
                isUserMessage(slot.message) &&
                slot.sequence === undefined &&
                messageTimestamp(slot.message) === undefined
        );
        const promptSlot = sequencedPrompt ?? timestampedPrompt ?? untimestampedPrompt;
        const sequencedActivity = runtimeSlots
            .filter((slot) => slot !== promptSlot && slot.sequence !== undefined)
            .toSorted((left, right) => left.sequence! - right.sequence!);
        const transcriptUsers = runtimeSlots
            .filter((slot) => slot !== promptSlot && slot.sequence === undefined)
            .toSorted((left, right) => left.index - right.index);
        const finalSlots = sequencedActivity.filter((slot) =>
            isFinalRunMessage(slot.message, run)
        );
        const thinkingSlots = sequencedActivity.filter(
            (slot) =>
                !isFinalRunMessage(slot.message, run) &&
                isThinkingOnlyRunMessage(slot.message)
        );
        const activitySlots = sequencedActivity.filter(
            (slot) =>
                !isFinalRunMessage(slot.message, run) &&
                !isThinkingOnlyRunMessage(slot.message)
        );
        const orderedActivity = insertUsersByTimestamp(activitySlots, transcriptUsers);
        const targetIndexes = runtimeSlots
            .map((slot) => slot.index)
            .toSorted((left, right) => left - right);
        const ordered = promptSlot
            ? [promptSlot, ...orderedActivity, ...thinkingSlots, ...finalSlots]
            : [...orderedActivity, ...thinkingSlots, ...finalSlots];
        for (const [slotIndex, index] of targetIndexes.entries()) {
            next[index] = ordered[slotIndex]!.message;
        }
    }
    return next;
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
        candidateMediaIdentity &&
        !candidate.text.trim() &&
        !runtimeMessage.text.trim() &&
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
        const runtimeMessage = transientMessage(
            entry.message,
            run,
            entry.key,
            entry.sequence
        );
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
            runtimeSequence: entry.sequence,
        };
        next[recoveredIndex] = enriched;
        recoveredCandidates.add(enriched);
    }
    return insertMessagesByTimestamp(next, missingMessages.toReversed());
}

function mergeRuntimeControlMessages(
    messages: ChatHistoryMessage[],
    controls: Readonly<ChatSessionRuntimeState["controls"]>
): ChatHistoryMessage[] {
    const next = [...messages];
    const missing: ChatHistoryMessage[] = [];
    for (const entry of controls) {
        const runtimeMessage: ChatHistoryMessage = {
            ...entry.message,
            intent: "control",
            local: true,
            role: "system",
            runId: undefined,
            runtimeKey: entry.key,
            runtimeSequence: entry.sequence,
        };
        const recoveredIndex = runtimeMessage.controlId
            ? next.findIndex(
                  (candidate) =>
                      candidate.intent === "control" &&
                      candidate.controlId === runtimeMessage.controlId
              )
            : -1;
        if (recoveredIndex === -1) {
            missing.push(runtimeMessage);
            continue;
        }
        const recovered = next[recoveredIndex]!;
        next[recoveredIndex] = {
            ...mergeChatMessageDetails(recovered, runtimeMessage),
            controlId: runtimeMessage.controlId,
            intent: "control",
            role: "system",
            runId: undefined,
            runtimeKey: entry.key,
            runtimeSequence: entry.sequence,
        };
    }
    return insertMessagesByTimestamp(next, missing);
}

function transientCommentaryMessages(run: ChatRunState): ChatHistoryMessage[] {
    return run.commentary.map((entry) => ({
        ...entry.message,
        content: "",
        intent: "commentary" as const,
        local: true,
        role: "assistant",
        runId: run.runId,
        runtimeKey: entry.key,
        runtimeSequence: entry.sequence,
        text: "",
        thinking: [
            {
                id: entry.key,
                snapshot: true,
                text: entry.message.text,
            },
        ],
        timestamp: entry.message.timestamp || run.updatedAt,
    }));
}

/**
 * Reconciles history with the current provider-independent runtime turn.
 * @param history History value.
 * @param session Session to process.
 * @returns Reconcile chat messages result.
 */
export function reconcileChatMessages(
    history: ChatHistoryMessage[],
    session?: ChatSessionRuntimeState
): ChatHistoryMessage[] {
    const runs = orderedRuns(session);
    const historyWithControls = mergeRuntimeControlMessages(
        history,
        session?.controls || []
    );
    const orderedHistory = orderCompletedHistoryTurns(historyWithControls, runs);
    const historyWithRuntimeUsers = mergeAllRuntimeUserMessages(orderedHistory, runs);
    const historyWithScopedUsers = scopeTranscriptUsersToRuns(
        historyWithRuntimeUsers,
        runs
    );
    const messages = scopeTranscriptDiagnosticsToRuns(historyWithScopedUsers, runs);
    for (const run of runs) {
        const commentaries = transientCommentaryMessages(run);
        for (const [index, message] of messages.entries()) {
            const shouldUseCanonicalRunId =
                (isUserMessage(message) || isStandaloneDiagnostic(message)) &&
                isRunMatchingMessage(run, message) &&
                message.runId !== run.runId;
            if (shouldUseCanonicalRunId) {
                messages[index] = { ...message, runId: run.runId };
            }
        }
        const exactToolIndex = indexExactToolMessages(messages);
        const segment = responseSegment(messages, run, runs, exactToolIndex);
        const diagnostics: ChatHistoryMessage[] = [];
        const claimedRecoveredSignatures = new Map<number, Map<string, number>>();
        const signatureCache = new Map<ChatHistoryMessage, string[]>();
        for (const entry of run.diagnostics) {
            const diagnostic = transientMessage(
                entry.message,
                run,
                entry.key,
                entry.sequence
            );
            if (diagnostic.toolCalls?.some((call) => call.id)) {
                refreshExactToolCalls(diagnostic, messages, exactToolIndex, segment, run);
            }
            if (exactToolResultIds(diagnostic).size > 0) {
                refreshExactToolResults(
                    diagnostic,
                    messages,
                    exactToolIndex,
                    segment,
                    run
                );
            }
            const recoveredIndexes = recoveredDiagnosticIndexes(
                diagnostic,
                messages,
                segment,
                run,
                claimedRecoveredSignatures,
                exactToolIndex,
                signatureCache
            );
            if (recoveredIndexes) {
                for (const index of recoveredIndexes) {
                    messages[index] = {
                        ...messages[index]!,
                        runId: run.runId,
                        runtimeKey: entry.key,
                        runtimeSequence: entry.sequence,
                    };
                }
            } else {
                diagnostics.push(diagnostic);
            }
        }
        const finalIndex = canonicalFinalIndex(messages, run, segment, exactToolIndex);
        if (finalIndex !== -1) {
            scopeCanonicalResponse(messages, run, segment, finalIndex, exactToolIndex);
            const canonical = messages[finalIndex]!;
            if (run.assistant) {
                messages[finalIndex] = {
                    ...mergeChatMessageDetails(
                        canonical,
                        transientMessage(
                            run.assistant,
                            run,
                            "assistant",
                            assistantRuntimeSequence(run)
                        )
                    ),
                    isFinal: canonical.isFinal || run.phase === "completed" || undefined,
                    runtimeSequence: assistantRuntimeSequence(run),
                };
            }
            messages.splice(finalIndex, 0, ...diagnostics, ...commentaries);
            continue;
        }

        const additions = [...diagnostics, ...commentaries];
        if (run.assistant) {
            additions.push(
                transientMessage(
                    run.assistant,
                    run,
                    "assistant",
                    assistantRuntimeSequence(run)
                )
            );
        }
        messages.splice(segment.end, 0, ...additions);
    }
    const deduped = dedupeMessages(messages);
    return orderRuntimeMessages(deduped, runs);
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
            return latestVisibleTurnMessage &&
                run.lastContentKind === "assistant" &&
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

/** Provider-independent history/runtime inputs selected for projection. */
export interface ChatProjectionContext {
    boundaryMessages: ChatHistoryMessage[];
    history: ChatHistoryMessage[];
    runs: ChatRunState[];
    session?: ChatSessionRuntimeState;
    sessionKey: string;
}

/** Reconciled canonical messages before visibility policy is applied. */
export interface ReconciledChatProjection {
    context: ChatProjectionContext;
    messages: ChatHistoryMessage[];
}

/** Reconciled messages with deterministic thinking placement before visibility. */
export interface StructuredChatProjection {
    messages: ChatHistoryMessage[];
    reconciliation: ReconciledChatProjection;
}

/** Canonical messages after visibility and thinking-retention policy. */
export interface PresentedChatProjection {
    messages: ChatHistoryMessage[];
    structure: StructuredChatProjection;
}

/**
 * Selects the session, ordered runs, and transcript boundary inputs.
 * @param history Canonical history messages.
 * @param runtime Canonical runtime state.
 * @param sessionKey Selected session key.
 * @returns Immutable projection context.
 */
export function selectChatProjectionContext(
    history: ChatHistoryMessage[],
    runtime: ChatRuntimeState,
    sessionKey: string
): ChatProjectionContext {
    const session = findChatSessionRuntimeState(runtime, sessionKey);
    const runs = orderedRuns(session);
    return {
        boundaryMessages: scopeTranscriptUsersToRuns(
            mergeAllRuntimeUserMessages(history, runs),
            runs
        ),
        history,
        runs,
        session,
        sessionKey,
    };
}

/**
 * Reconciles one selected transcript with its runtime state.
 * @param context Selected projection context.
 * @returns Reconciled projection stage.
 */
export function reconcileChatProjectionContext(
    context: ChatProjectionContext
): ReconciledChatProjection {
    return {
        context,
        messages: reconcileChatMessages(context.history, context.session),
    };
}

/**
 * Structures reconciled messages before turn grouping and visibility.
 * @param reconciliation Reconciled projection stage.
 * @returns Structured projection stage.
 */
export function structureChatProjectionContext(
    reconciliation: ReconciledChatProjection
): StructuredChatProjection {
    return {
        messages: structureChatMessages(reconciliation.messages),
        reconciliation,
    };
}

/**
 * Applies visibility and thinking-retention policy to structured messages.
 * @param structure Structured projection stage.
 * @param visibility Visibility policy.
 * @param shouldKeepThinkingAfterFinal Whether settled thinking remains visible.
 * @returns Presented projection stage.
 */
export function presentChatProjectionContext(
    structure: StructuredChatProjection,
    visibility: ChatVisibilitySettings,
    shouldKeepThinkingAfterFinal: boolean
): PresentedChatProjection {
    return {
        messages: presentStructuredChatMessages(
            structure.messages,
            visibility,
            shouldKeepThinkingAfterFinal
        ),
        structure,
    };
}

/**
 * Converts presented messages into the unchanged UI row contract.
 * @param messages Presented canonical messages.
 * @param deletedMessageKeys Persisted message deletion identities.
 * @param runs Canonical runtime runs carrying acknowledged identity aliases.
 * @returns Message and stream rows in presentation order.
 */
export function renderChatProjectionRows(
    messages: ChatHistoryMessage[],
    deletedMessageKeys: ReadonlySet<string>,
    runs: ChatRunState[]
): ChatRow[] {
    const deleteKeyOccurrences = new Map<string, number>();
    const rowKeyOccurrences = new Map<string, number>();
    const messageDeleteIdentities = messages.map((message) =>
        projectedMessageDeleteIdentity(message, runs)
    );
    const naturalDeleteKeys = new Set(
        messageDeleteIdentities.flatMap((identity) => identity.baseKeys)
    );
    const generatedDeleteKeys = new Set<string>();
    const naturalRowKeys = new Set(
        messages.map((message) => projectedMessageRowKey(message))
    );
    const generatedRowKeys = new Set<string>();
    return messages.flatMap((message, messageIndex) => {
        const identity = messageDeleteIdentities[messageIndex]!;
        const matchDeleteKeys = identity.baseKeys.map((baseKey) => {
            const occurrence = deleteKeyOccurrences.get(baseKey) ?? 0;
            deleteKeyOccurrences.set(baseKey, occurrence + 1);
            if (occurrence === 0) {
                return baseKey;
            }
            const key = unusedChatProjectionRowOccurrenceKey(
                baseKey,
                occurrence,
                naturalDeleteKeys,
                generatedDeleteKeys
            );
            generatedDeleteKeys.add(key);
            return key;
        });
        const deleteKeys = matchDeleteKeys.slice(0, identity.persistedKeyCount);
        const baseRowKey = projectedMessageRowKey(message);
        const rowOccurrence = rowKeyOccurrences.get(baseRowKey) ?? 0;
        rowKeyOccurrences.set(baseRowKey, rowOccurrence + 1);
        const rowKey =
            rowOccurrence === 0
                ? baseRowKey
                : unusedChatProjectionRowOccurrenceKey(
                      baseRowKey,
                      rowOccurrence,
                      naturalRowKeys,
                      generatedRowKeys
                  );
        generatedRowKeys.add(rowKey);
        return [...matchDeleteKeys, rowKey].some((key) => deletedMessageKeys.has(key))
            ? []
            : [
                  {
                      deleteKeys,
                      key: rowKey,
                      kind:
                          message.local === true &&
                          message.runId &&
                          !isUserMessage(message)
                              ? ("stream" as const)
                              : ("message" as const),
                      message: projectedMessageDisplay(message),
                  },
              ];
    });
}

/**
 * Selects runs whose canonical final is not yet present in history.
 * @param context Selected projection context.
 * @returns Active visible response runs.
 */
export function selectActiveChatProjectionRuns(
    context: ChatProjectionContext
): ChatRunState[] {
    const exactToolIndex = indexExactToolMessages(context.boundaryMessages);
    return context.runs.filter(
        (run) =>
            run.phase === "active" &&
            run.operation !== "compact" &&
            canonicalFinalIndex(
                context.boundaryMessages,
                run,
                responseSegment(
                    context.boundaryMessages,
                    run,
                    context.runs,
                    exactToolIndex
                ),
                exactToolIndex
            ) === -1
    );
}

/**
 * Appends a typing row when an active run has no visible assistant stream.
 * @param rows Presented message rows.
 * @param messages Presented canonical messages.
 * @param activeRuns Active visible response runs.
 * @returns Rows with an optional typing status.
 */
export function appendChatProjectionStatus(
    rows: ChatRow[],
    messages: ChatHistoryMessage[],
    activeRuns: ChatRunState[]
): ChatRow[] {
    const typing = statusRow(
        activeRuns,
        visibleAssistantStreamRunIds(messages, activeRuns)
    );
    return typing ? [...rows, typing] : rows;
}

function chatProjectionRowOccurrenceKey(
    baseKey: string,
    occurrence: number,
    collision: number
): string {
    return [
        "chat-row-occurrence",
        "v1",
        occurrence,
        collision,
        canonicalChatContentFingerprint(baseKey),
    ].join(":");
}

function unusedChatProjectionRowOccurrenceKey(
    baseKey: string,
    occurrence: number,
    reservedKeys: ReadonlySet<string>,
    usedKeys: ReadonlySet<string>
): string {
    let collision = 0;
    let key = chatProjectionRowOccurrenceKey(baseKey, occurrence, collision);
    while (reservedKeys.has(key) || usedKeys.has(key)) {
        collision += 1;
        key = chatProjectionRowOccurrenceKey(baseKey, occurrence, collision);
    }
    return key;
}

function uniqueChatProjectionRowKeys(rows: ChatRow[]): ChatRow[] {
    const reservedKeys = new Set(rows.map((row) => row.key));
    const usedKeys = new Set<string>();
    const occurrences = new Map<string, number>();
    return rows.map((row) => {
        const baseKey = row.key;
        let occurrence = occurrences.get(baseKey) ?? 0;
        let key = baseKey;
        if (usedKeys.has(key)) {
            occurrence += 1;
            key = unusedChatProjectionRowOccurrenceKey(
                baseKey,
                occurrence,
                reservedKeys,
                usedKeys
            );
        }
        occurrences.set(baseKey, occurrence);
        usedKeys.add(key);
        return key === baseKey ? row : { ...row, key };
    });
}

/**
 * Selects the latest visible context-compaction lifecycle.
 * @param runs Ordered session runs.
 * @returns Current compaction status.
 */
export function selectChatCompactionStatus(
    runs: ChatRunState[]
): ChatCompactionStatus | undefined {
    return currentCompactionStatus(runs);
}

/**
 * Finalizes presented messages into the stable UI projection contract.
 * @param presentation Presented projection stage.
 * @param deletedMessageKeys Persisted message deletion identities.
 * @returns Final chat projection.
 */
export function finalizeChatProjection(
    presentation: PresentedChatProjection,
    deletedMessageKeys: ReadonlySet<string>
): ChatProjection {
    const { context } = presentation.structure.reconciliation;
    const activeRuns = selectActiveChatProjectionRuns(context);
    const rows = appendChatProjectionStatus(
        renderChatProjectionRows(presentation.messages, deletedMessageKeys, context.runs),
        presentation.messages,
        activeRuns
    );
    return {
        activeRuns,
        compactionStatus: selectChatCompactionStatus(context.runs),
        rows: uniqueChatProjectionRowKeys(rows),
    };
}
