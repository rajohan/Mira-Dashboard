import {
    isRecoveredAssistantText,
    messageMediaIdentity,
    stripEquivalentChatTextPrefix,
} from "../chatMessageIdentity";
import type { ChatHistoryMessage } from "../chatTypes";
import { hasPrimaryAnswerContent } from "./chatPresentation";
import { exactToolIds, type ExactToolMessageIndex } from "./chatProjectionDiagnostics";
import {
    asAssistantToolResultMessage,
    currentResponseStart,
    isDashboardRunId,
    isGatewayRestartContinuation,
    isRunMatchingMessage,
    isStandaloneDiagnostic,
    isUserMessage,
    messageTimestamp,
    type ResponseSegment,
    RUN_START_USER_SKEW_MS,
    RUNTIME_FINAL_SKEW_MS,
} from "./chatProjectionIdentity";
import type { ChatRunState, ChatRuntimeMessageEntry } from "./chatState";

export function runtimeAssistantEntries(run: ChatRunState): ChatRuntimeMessageEntry[] {
    if (run.assistantSegments?.length) {
        return run.assistantSegments;
    }
    return run.assistant
        ? [
              {
                  key: "assistant",
                  message: run.assistant,
                  sequence:
                      run.phase === "active"
                          ? (run.assistantSequence ??
                            run.lastContentSequence ??
                            run.lastSequence)
                          : (run.terminalSequence ??
                            run.lastContentSequence ??
                            run.assistantSequence ??
                            run.lastSequence),
              },
          ]
        : [];
}

function canonicalRuntimeAssistant(run: ChatRunState): ChatHistoryMessage | undefined {
    return run.assistant ?? runtimeAssistantEntries(run).at(-1)?.message;
}

export function canonicalAssistantDisplay(
    canonical: ChatHistoryMessage,
    assistantEntries: ChatRuntimeMessageEntry[]
): ChatHistoryMessage {
    const sealedText = assistantEntries
        .slice(0, -1)
        .map((entry) => entry.message.text)
        .join("");
    if (!sealedText) {
        return canonical;
    }
    const trailingText = stripEquivalentChatTextPrefix(canonical.text, sealedText);
    if (trailingText === undefined) {
        return canonical;
    }
    return {
        ...canonical,
        content: typeof canonical.content === "string" ? trailingText : canonical.content,
        text: trailingText,
    };
}

export function projectedMessageDisplay(message: ChatHistoryMessage): ChatHistoryMessage {
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

export function canUseDashboardTurn(
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

export function isEligibleRunPrompt(
    message: ChatHistoryMessage,
    run: ChatRunState
): boolean {
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

export function sequencedRunPromptIndex(
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

export function runFinalAnchorIndex(
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

    const assistantText = canonicalRuntimeAssistant(run)?.text;
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

export function responseSegment(
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

export function canonicalFinalIndex(
    messages: ChatHistoryMessage[],
    run: ChatRunState,
    segment: ResponseSegment,
    exactToolIndex: ExactToolMessageIndex
): number {
    const assistantText = canonicalRuntimeAssistant(run)?.text || "";
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
    const runtimeAssistant = canonicalRuntimeAssistant(run);
    if (!runtimeAssistant || !hasPrimaryAnswerContent(runtimeAssistant)) {
        return false;
    }
    const assistantText = runtimeAssistant.text;
    const assistantMediaIdentity = messageMediaIdentity(runtimeAssistant);
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

export function scopeCanonicalResponse(
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

export function transientMessage(
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

export function canonicalFinalRuntimeSequence(run: ChatRunState): number | undefined {
    return run.terminalSequence ?? run.lastContentSequence ?? run.assistantSequence;
}
