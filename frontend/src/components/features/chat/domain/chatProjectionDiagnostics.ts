import { stableChatStringify } from "../chatMessageIdentity";
import type { ChatHistoryMessage } from "../chatTypes";
import { isRunMatchingMessage, type ResponseSegment } from "./chatProjectionIdentity";
import type { ChatRunState } from "./chatState";

export function exactToolIds(message: ChatHistoryMessage): Set<string> {
    return new Set(
        [
            message.toolResult?.id,
            ...(message.toolCalls || []).flatMap((call) => [
                call.id,
                call.toolResult?.id,
            ]),
        ].filter((id): id is string => Boolean(id))
    );
}

export type ExactToolMessageIndex = ReadonlyMap<string, readonly number[]>;

export function indexExactToolMessages(
    messages: ChatHistoryMessage[]
): ExactToolMessageIndex {
    const index = new Map<string, number[]>();
    for (const [messageIndex, message] of messages.entries()) {
        for (const id of exactToolIds(message)) {
            const indexes = index.get(id) || [];
            indexes.push(messageIndex);
            index.set(id, indexes);
        }
    }
    return index;
}

export function exactToolResultIds(message: ChatHistoryMessage): Set<string> {
    return new Set(
        [
            message.toolResult?.id,
            ...(message.toolCalls || []).map((call) => call.toolResult?.id),
        ].filter((id): id is string => Boolean(id))
    );
}

function hasExactToolIdentity(message: ChatHistoryMessage): boolean {
    return Boolean(
        message.toolResult?.id ||
        message.toolCalls?.some((call) => call.id || call.toolResult?.id)
    );
}

function mergeExactToolResult(
    previous: ChatHistoryMessage["toolResult"],
    current: NonNullable<ChatHistoryMessage["toolResult"]>
): NonNullable<ChatHistoryMessage["toolResult"]> {
    if (!previous || !current.isPlaceholder || previous.isPlaceholder) {
        return current;
    }
    return {
        ...previous,
        id: current.id || previous.id,
        isError: current.isError || previous.isError || undefined,
        isPlaceholder: undefined,
        name: previous.name || current.name,
    };
}

type ExactToolCall = NonNullable<ChatHistoryMessage["toolCalls"]>[number];

function mergeExactToolCall(
    historyCall: ExactToolCall | undefined,
    runtimeCall: ExactToolCall,
    historyResult: ChatHistoryMessage["toolResult"]
): ExactToolCall {
    return {
        ...runtimeCall,
        ...historyCall,
        arguments: historyCall?.arguments ?? runtimeCall.arguments,
        name: historyCall?.name || runtimeCall.name,
        toolResult: historyResult
            ? mergeExactToolResult(
                  historyCall?.toolResult || runtimeCall.toolResult,
                  historyResult
              )
            : historyCall?.toolResult || runtimeCall.toolResult,
    };
}

export function refreshExactToolCalls(
    diagnostic: ChatHistoryMessage,
    messages: ChatHistoryMessage[],
    exactToolIndex: ExactToolMessageIndex,
    segment: ResponseSegment,
    run: ChatRunState
): void {
    const runtimeCalls = diagnostic.toolCalls || [];
    for (const runtimeCall of runtimeCalls) {
        if (!runtimeCall.id) {
            continue;
        }
        const matchingIndexes = (exactToolIndex.get(runtimeCall.id) || []).filter(
            (index) => {
                const candidate = messages[index];
                const isInResponseSegment = index >= segment.start && index < segment.end;
                return Boolean(
                    candidate &&
                    (isInResponseSegment || isRunMatchingMessage(run, candidate))
                );
            }
        );
        const callIndex = matchingIndexes.find((index) =>
            messages[index]?.toolCalls?.some((call) => call.id === runtimeCall.id)
        );
        const resultIndex = matchingIndexes.findLast(
            (index) => messages[index]?.toolResult?.id === runtimeCall.id
        );
        const targetIndex = callIndex ?? resultIndex;
        if (targetIndex === undefined) {
            continue;
        }
        const candidate = messages[targetIndex]!;
        const toolCalls = [...(candidate.toolCalls || [])];
        const existingIndex = toolCalls.findIndex((call) => call.id === runtimeCall.id);
        const historyResult =
            candidate.toolResult?.id === runtimeCall.id
                ? candidate.toolResult
                : toolCalls[existingIndex]?.toolResult;
        const mergedCall = mergeExactToolCall(
            toolCalls[existingIndex],
            runtimeCall,
            historyResult
        );
        if (existingIndex === -1) {
            toolCalls.push(mergedCall);
        } else {
            toolCalls[existingIndex] = mergedCall;
        }
        messages[targetIndex] = { ...candidate, toolCalls };
    }
}

function refreshExactToolResult(
    current: NonNullable<ChatHistoryMessage["toolResult"]>,
    messages: ChatHistoryMessage[],
    exactToolIndex: ExactToolMessageIndex,
    segment: ResponseSegment,
    run: ChatRunState
): void {
    const matchingIndexes = exactToolIndex.get(current.id || "") || [];
    for (const index of matchingIndexes) {
        const candidate = messages[index];
        const isInResponseSegment = index >= segment.start && index < segment.end;
        if (
            !candidate ||
            (!isInResponseSegment && !isRunMatchingMessage(run, candidate))
        ) {
            continue;
        }
        const hasMatchingCall = candidate.toolCalls?.some(
            (call) => call.id === current.id || call.toolResult?.id === current.id
        );
        const hasMatchingResult = candidate.toolResult?.id === current.id;
        if (hasMatchingCall || hasMatchingResult) {
            const toolCalls = candidate.toolCalls?.map((call) =>
                call.id === current.id || call.toolResult?.id === current.id
                    ? {
                          ...call,
                          toolResult: mergeExactToolResult(call.toolResult, current),
                      }
                    : call
            );
            messages[index] = {
                ...candidate,
                toolCalls,
                toolResult: hasMatchingResult
                    ? mergeExactToolResult(candidate.toolResult, current)
                    : candidate.toolResult,
            };
        }
    }
}

export function refreshExactToolResults(
    diagnostic: ChatHistoryMessage,
    messages: ChatHistoryMessage[],
    exactToolIndex: ExactToolMessageIndex,
    segment: ResponseSegment,
    run: ChatRunState
): void {
    const currentResults = [
        diagnostic.toolResult,
        ...(diagnostic.toolCalls || []).map((call) => call.toolResult),
    ].filter((result): result is NonNullable<ChatHistoryMessage["toolResult"]> =>
        Boolean(result?.id)
    );
    for (const current of currentResults) {
        refreshExactToolResult(current, messages, exactToolIndex, segment, run);
    }
}

function toolResultSignatures(
    result: NonNullable<ChatHistoryMessage["toolResult"]>
): string[] {
    if (result.id) {
        return [`result-id:${result.id}`];
    }
    const payload = stableChatStringify({
        result: {
            content: result.content,
            error: result.isError || false,
            images: result.images || [],
            name: result.name || "",
        },
    });
    return [`result-payload:${payload}`];
}

function toolSignatures(message: ChatHistoryMessage): string[] {
    const signatures: string[] = [];
    const nestedResultSignatures: string[] = [];
    const toolCalls = message.toolCalls || [];
    for (const call of toolCalls) {
        signatures.push(
            call.id
                ? `call-id:${call.id}`
                : stableChatStringify({
                      arguments: call.arguments ?? undefined,
                      name: call.name,
                  })
        );
        if (call.toolResult) {
            const result = toolResultSignatures(call.toolResult);
            signatures.push(...result);
            nestedResultSignatures.push(...result);
        }
    }
    if (message.toolResult) {
        for (const signature of toolResultSignatures(message.toolResult)) {
            if (!nestedResultSignatures.includes(signature)) {
                signatures.push(signature);
            }
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

function cachedDiagnosticSignatures(
    message: ChatHistoryMessage,
    cache: Map<ChatHistoryMessage, string[]>
): string[] {
    const cached = cache.get(message);
    if (cached) {
        return cached;
    }
    const signatures = diagnosticSignatures(message);
    cache.set(message, signatures);
    return signatures;
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
    remaining: Map<string, number>,
    signatureCache: Map<ChatHistoryMessage, string[]>
): Map<string, number> {
    const consumed = new Map<string, number>();
    const availableSignatures = countSignatures(
        cachedDiagnosticSignatures(message, signatureCache)
    );
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

function requiresSegmentSignatureSearch(message: ChatHistoryMessage): boolean {
    return Boolean(
        message.thinking?.length ||
        (message.toolResult && !message.toolResult.id) ||
        message.toolCalls?.some(
            (call) => !call.id || (call.toolResult && !call.toolResult.id)
        )
    );
}

export function recoveredDiagnosticIndexes(
    diagnostic: ChatHistoryMessage,
    messages: ChatHistoryMessage[],
    segment: ResponseSegment,
    run: ChatRunState,
    claimedSignatures: Map<number, Map<string, number>>,
    exactToolIndex: ExactToolMessageIndex,
    signatureCache: Map<ChatHistoryMessage, string[]>
): number[] | undefined {
    const hasExactIdentity = hasExactToolIdentity(diagnostic);
    const diagnosticIds = hasExactIdentity ? exactToolIds(diagnostic) : new Set<string>();
    const exactCandidateIndexes = new Set(
        [...diagnosticIds]
            .flatMap((id) => exactToolIndex.get(id) || [])
            .filter((index) => {
                const candidate = messages[index];
                const isInResponseSegment = index >= segment.start && index < segment.end;
                return Boolean(
                    candidate &&
                    (isInResponseSegment || isRunMatchingMessage(run, candidate))
                );
            })
    );
    const shouldSearchSegment =
        !hasExactIdentity || requiresSegmentSignatureSearch(diagnostic);
    const candidates = shouldSearchSegment
        ? messages
              .slice(segment.start, segment.end)
              .map((message, offset) => ({
                  index: segment.start + offset,
                  message,
              }))
              .filter(
                  (candidate) =>
                      hasExactIdentity ||
                      !candidate.message.runId ||
                      isRunMatchingMessage(run, candidate.message)
              )
        : [];
    const candidateIndexes = new Set(candidates.map((candidate) => candidate.index));
    for (const index of exactCandidateIndexes) {
        const message = messages[index];
        if (message && !candidateIndexes.has(index)) {
            candidates.push({ index, message });
            candidateIndexes.add(index);
        }
    }
    const expected = cachedDiagnosticSignatures(diagnostic, signatureCache);
    if (expected.length === 0) {
        return undefined;
    }
    const remaining = countSignatures(expected);
    const consumedByIndex = new Map<number, Map<string, number>>();
    for (const candidate of candidates) {
        const consumed = consumeCandidateSignatures(
            candidate.message,
            claimedSignatures.get(candidate.index) || new Map(),
            remaining,
            signatureCache
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
    const recoveredIndexes = new Set(consumedByIndex.keys());
    if (hasExactIdentity) {
        for (const index of exactCandidateIndexes) {
            recoveredIndexes.add(index);
        }
    }
    return [...recoveredIndexes];
}
