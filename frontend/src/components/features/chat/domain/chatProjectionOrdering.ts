import type { ChatHistoryMessage } from "../chatTypes";
import {
    insertMessagesByTimestamp,
    mergeChatMessageDetails,
    messageIdentity,
    messageMediaIdentity,
} from "../chatUtilities";
import { hasPrimaryAnswerContent } from "./chatPresentation";
import {
    canUseDashboardTurn,
    isEligibleRunPrompt,
    responseSegment,
    runFinalAnchorIndex,
    sequencedRunPromptIndex,
    transientMessage,
} from "./chatProjectionAnchoring";
import { indexExactToolMessages } from "./chatProjectionDiagnostics";
import {
    isDashboardRunId,
    isRunMatchingMessage,
    isStandaloneDiagnostic,
    isUserMessage,
    messageTimestamp,
    RUN_START_USER_SKEW_MS,
    RUNTIME_USER_ECHO_WINDOW_MS,
} from "./chatProjectionIdentity";
import type { ChatRunState, ChatSessionRuntimeState } from "./chatState";

export function scopeTranscriptUsersToRuns(
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

export function scopeTranscriptDiagnosticsToRuns(
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
export function orderCompletedHistoryTurns(
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
export function orderRuntimeMessages(
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
        let lastNonFinalSlot: IndexedChatMessage | undefined;
        for (const slot of sequencedActivity) {
            if (isFinalRunMessage(slot.message, run)) {
                continue;
            }
            if (
                !lastNonFinalSlot ||
                slot.sequence! > lastNonFinalSlot.sequence! ||
                (slot.sequence === lastNonFinalSlot.sequence &&
                    slot.index > lastNonFinalSlot.index)
            ) {
                lastNonFinalSlot = slot;
            }
        }
        const trailingAssistantSlots = new Set(
            sequencedActivity.filter(
                (slot) =>
                    isAssistantTextStream(slot.message) &&
                    (!lastNonFinalSlot ||
                        slot.sequence! > lastNonFinalSlot.sequence! ||
                        (slot.sequence === lastNonFinalSlot.sequence &&
                            slot.index >= lastNonFinalSlot.index))
            )
        );
        const answerSlots = sequencedActivity.filter(
            (slot) =>
                isFinalRunMessage(slot.message, run) || trailingAssistantSlots.has(slot)
        );
        const answerSlotSet = new Set(answerSlots);
        const thinkingSlots = sequencedActivity.filter(
            (slot) => !answerSlotSet.has(slot) && isThinkingOnlyRunMessage(slot.message)
        );
        const activitySlots = sequencedActivity.filter(
            (slot) => !answerSlotSet.has(slot) && !isThinkingOnlyRunMessage(slot.message)
        );
        const orderedActivity = insertUsersByTimestamp(activitySlots, transcriptUsers);
        const targetIndexes = runtimeSlots
            .map((slot) => slot.index)
            .toSorted((left, right) => left - right);
        const ordered = promptSlot
            ? [promptSlot, ...orderedActivity, ...thinkingSlots, ...answerSlots]
            : [...orderedActivity, ...thinkingSlots, ...answerSlots];
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

export function mergeAllRuntimeUserMessages(
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

export function mergeRuntimeControlMessages(
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

export function transientCommentaryMessages(run: ChatRunState): ChatHistoryMessage[] {
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

export function isAssistantTextStream(message: ChatHistoryMessage): boolean {
    return Boolean(
        message.role.toLowerCase() === "assistant" &&
        message.text.trim() &&
        !message.thinking?.length &&
        !message.toolCalls?.length &&
        !message.toolResult
    );
}
