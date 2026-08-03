import { canonicalChatContentFingerprint } from "../../../../../../contracts/chat/canonicalContentIdentity";
import { mergeChatMessageDetails } from "../chatMessageIdentity";
import { dedupeMessages } from "../chatMessageReconciliation";
import {
    type ChatHistoryMessage,
    type ChatRow,
    type ChatVisibilitySettings,
} from "../chatTypes";
import { presentStructuredChatMessages } from "./chatPresentation";
import {
    canonicalAssistantDisplay,
    canonicalFinalIndex,
    canonicalFinalRuntimeSequence,
    projectedMessageDisplay,
    responseSegment,
    runtimeAssistantEntries,
    scopeCanonicalResponse,
    transientMessage,
} from "./chatProjectionAnchoring";
import {
    exactToolResultIds,
    indexExactToolMessages,
    recoveredDiagnosticIndexes,
    refreshExactToolCalls,
    refreshExactToolResults,
} from "./chatProjectionDiagnostics";
import {
    isRunMatchingMessage,
    isStandaloneDiagnostic,
    isUserMessage,
    orderedRuns,
    projectedMessageDeleteIdentity,
    projectedMessageRowIdentityAliases,
    projectedMessageRowKey,
} from "./chatProjectionIdentity";
import {
    isAssistantTextStream,
    mergeAllRuntimeUserMessages,
    mergeRuntimeControlMessages,
    orderCompletedHistoryTurns,
    orderRuntimeMessages,
    scopeTranscriptDiagnosticsToRuns,
    scopeTranscriptUsersToRuns,
    transientCommentaryMessages,
} from "./chatProjectionOrdering";
import type {
    ChatRunState,
    ChatRuntimeState,
    ChatSessionRuntimeState,
} from "./chatState";
import { findChatSessionRuntimeState } from "./chatState";
import { structureChatMessages } from "./chatThinkingStructure";

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
        const assistantEntries = runtimeAssistantEntries(run);
        const assistantMessages = assistantEntries.map((entry) =>
            transientMessage(entry.message, run, entry.key, entry.sequence)
        );
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
            const canonicalDisplay = canonicalAssistantDisplay(
                canonical,
                assistantEntries
            );
            const runtimeSequence = canonicalFinalRuntimeSequence(run);
            const latestAssistant = assistantEntries.at(-1)?.message;
            if (latestAssistant) {
                messages[finalIndex] = {
                    ...mergeChatMessageDetails(
                        canonicalDisplay,
                        transientMessage(
                            latestAssistant,
                            run,
                            assistantEntries.at(-1)!.key,
                            runtimeSequence
                        )
                    ),
                    isFinal: canonical.isFinal || run.phase === "completed" || undefined,
                    runtimeSequence,
                };
            }
            messages.splice(
                finalIndex,
                0,
                ...diagnostics,
                ...commentaries,
                ...assistantMessages.slice(0, -1)
            );
            continue;
        }

        const additions = [...diagnostics, ...commentaries, ...assistantMessages];
        messages.splice(segment.end, 0, ...additions);
    }
    const deduped = dedupeMessages(messages);
    return orderRuntimeMessages(deduped, runs);
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
        const identityKeys = projectedMessageRowIdentityAliases(message, runs);
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
                      identityKeys: identityKeys.length > 0 ? identityKeys : undefined,
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
