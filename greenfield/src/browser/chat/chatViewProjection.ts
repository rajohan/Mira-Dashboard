import type { InfiniteData } from "@tanstack/react-query";

import type {
    ChatHistoryOutput,
    ChatMessageGetOutput,
    ChatModelsListOutput,
} from "../../contracts/chat.ts";
import {
    gatewayPrimarySessionKey,
    type GatewaySession,
    type ListGatewaySessionsResult,
} from "../../contracts/gatewaySessions.ts";
import {
    chatToolResultMatchesCall,
    mergeChatToolPart,
    projectChatContractMessage,
} from "./chatContractAdapter.ts";
import type {
    ChatDisplayMessage,
    ChatMessageAttachment,
    ChatMessagePart,
    ChatSessionOption,
} from "./chatTypes.ts";

function unique(values: readonly (string | undefined)[]): readonly string[] {
    return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function sessionThinkingOptions(session: GatewaySession): readonly string[] {
    return unique([
        session.thinkingLevel,
        session.thinkingDefault,
        ...(session.thinkingLevels?.map(({ id }) => id) ?? []),
        ...(session.thinkingOptions ?? []),
    ]);
}

/**
 * Projects the fresh-or-LKG Gateway inventory into stable picker rows.
 * @param snapshot Current bounded Gateway session inventory.
 * @param modelInventory Configured model capabilities, when available.
 * @returns Stable chat session picker rows.
 */
export function projectChatSessions(
    snapshot: ListGatewaySessionsResult,
    modelInventory: ChatModelsListOutput | undefined
): readonly ChatSessionOption[] {
    const globalModels = modelInventory?.models.map(({ id }) => id) ?? [];
    return snapshot.sessions.map((session) => ({
        activeRunCount: session.activeRunIds?.length ?? (session.hasActiveRun ? 1 : 0),
        ...(session.contextTokens === undefined
            ? {}
            : { contextTokens: session.contextTokens }),
        displayName: session.displayName,
        ...(session.fastMode === undefined ? {} : { fastMode: session.fastMode }),
        isDefault: session.key === gatewayPrimarySessionKey,
        key: session.key,
        ...(session.model === undefined ? {} : { model: session.model }),
        modelOptions: unique([session.model, ...globalModels]),
        speed:
            session.fastMode === true || session.effectiveFastMode === true
                ? "fast"
                : "standard",
        thinking: session.thinkingLevel ?? session.thinkingDefault ?? "default",
        thinkingOptions: sessionThinkingOptions(session),
        ...(session.totalTokens === undefined
            ? {}
            : { totalTokens: session.totalTokens }),
        totalTokensFresh: session.totalTokensFresh,
        ...(session.updatedAtMs === undefined
            ? {}
            : { updatedAtMs: session.updatedAtMs }),
    }));
}

export interface ChatHydrationProjection {
    readonly detail?: ChatMessageGetOutput;
    readonly messageId?: string;
    readonly status?: "error" | "loading";
}

function hydrationState(
    hydration: ChatHydrationProjection
): "error" | "loading" | "required" {
    if (hydration.status === "loading") return "loading";
    if (hydration.status === "error" || hydration.detail?.status === "unavailable") {
        return "error";
    }
    return "required";
}

function runsAreCompatible(
    call: ChatDisplayMessage,
    result: ChatDisplayMessage
): boolean {
    if (
        call.providerRunId !== undefined &&
        result.providerRunId !== undefined &&
        call.providerRunId !== result.providerRunId
    ) {
        return false;
    }
    return (
        call.runId === undefined ||
        result.runId === undefined ||
        call.runId === result.runId
    );
}

function mergeAttachments(
    current: readonly ChatMessageAttachment[],
    incoming: readonly ChatMessageAttachment[]
): readonly ChatMessageAttachment[] {
    const identities = new Set(
        current.map(
            (attachment) =>
                attachment.downloadUrl ??
                attachment.previewUrl ??
                `${attachment.mediaType}:${attachment.name}:${attachment.sizeBytes}`
        )
    );
    return [
        ...current,
        ...incoming.filter((attachment) => {
            const identity =
                attachment.downloadUrl ??
                attachment.previewUrl ??
                `${attachment.mediaType}:${attachment.name}:${attachment.sizeBytes}`;
            if (identities.has(identity)) return false;
            identities.add(identity);
            return true;
        }),
    ];
}

/**
 * Folds canonical tool-role result rows into the preceding assistant call.
 * This deliberately runs after all retained pages are flattened, so a call and
 * result split across a pagination boundary still render as one disclosure.
 * @param messages Flattened retained history in display order.
 * @returns History with exact call/result pairs coalesced into assistant rows.
 */
function foldHistoryToolResults(
    messages: readonly ChatDisplayMessage[]
): readonly ChatDisplayMessage[] {
    const folded: ChatDisplayMessage[] = [];
    for (const message of messages) {
        if (message.role !== "control") {
            folded.push(message);
            continue;
        }
        const remainingParts: ChatMessagePart[] = [];
        const matchedAssistantIndexes = new Set<number>();
        const currentTurnStart =
            folded.findLastIndex((candidate) => candidate.role === "user") + 1;
        for (const part of message.parts) {
            if (part.kind !== "tool" || part.status === "running") {
                remainingParts.push(part);
                continue;
            }
            const assistantIndex = folded.findLastIndex(
                (candidate, candidateIndex) =>
                    candidate.role === "assistant" &&
                    runsAreCompatible(candidate, message) &&
                    candidate.parts.some(
                        (candidatePart) =>
                            candidatePart.kind === "tool" &&
                            (part.callIdSource !== "synthetic" ||
                                (message.providerRunId !== undefined &&
                                    candidate.providerRunId === message.providerRunId) ||
                                candidateIndex >= currentTurnStart) &&
                            chatToolResultMatchesCall(candidatePart, part)
                    )
            );
            if (assistantIndex === -1) {
                remainingParts.push(part);
                continue;
            }
            const assistant = folded[assistantIndex];
            if (assistant === undefined) {
                remainingParts.push(part);
                continue;
            }
            const assistantToolIndex = assistant.parts.findIndex(
                (candidatePart) =>
                    candidatePart.kind === "tool" &&
                    chatToolResultMatchesCall(candidatePart, part)
            );
            if (assistantToolIndex === -1) {
                remainingParts.push(part);
                continue;
            }
            folded[assistantIndex] = {
                ...assistant,
                parts: assistant.parts.map((candidatePart, candidatePartIndex) =>
                    candidatePartIndex === assistantToolIndex &&
                    candidatePart.kind === "tool"
                        ? mergeChatToolPart(candidatePart, part)
                        : candidatePart
                ),
            };
            matchedAssistantIndexes.add(assistantIndex);
        }
        const attachmentTarget = [...matchedAssistantIndexes].at(-1);
        if (attachmentTarget !== undefined && message.attachments.length > 0) {
            const assistant = folded[attachmentTarget];
            if (assistant !== undefined) {
                folded[attachmentTarget] = {
                    ...assistant,
                    attachments: mergeAttachments(
                        assistant.attachments,
                        message.attachments
                    ),
                };
            }
        }
        if (
            remainingParts.length > 0 ||
            (matchedAssistantIndexes.size === 0 && message.attachments.length > 0) ||
            message.hydration !== undefined
        ) {
            folded.push({
                ...message,
                attachments:
                    matchedAssistantIndexes.size === 0 ? message.attachments : [],
                parts: remainingParts,
            });
        }
    }
    return folded;
}

/**
 * Flattens newest-page-first query data into one chronological transcript.
 * @param data Cursor-paginated provider history.
 * @param sessionKey Exact selected provider session.
 * @param hydration Optional one-row hydration state.
 * @returns Chronological display messages.
 */
export function projectChatHistory(
    data: InfiniteData<ChatHistoryOutput> | undefined,
    sessionKey: string,
    hydration: ChatHydrationProjection = {}
): readonly ChatDisplayMessage[] {
    if (data === undefined) return [];
    const authoritativeSessionId = data.pages[0]?.sessionId;
    const seenMessageIds = new Set<string>();
    const authoritativePages = data.pages
        .filter((page) => page.sessionId === authoritativeSessionId)
        .map((page) => ({
            ...page,
            messages: page.messages.filter((message) => {
                if (seenMessageIds.has(message.id)) return false;
                seenMessageIds.add(message.id);
                return true;
            }),
        }));
    const contractMessages = authoritativePages
        .toReversed()
        .flatMap((page) => page.messages);
    const projectedMessages = contractMessages.map((message, index) => {
        const hydrated =
            hydration.messageId === message.id && hydration.detail?.status === "available"
                ? hydration.detail.message
                : message;
        const projected = projectChatContractMessage(hydrated, sessionKey, index + 1);
        if (hydrated.content.kind !== "hydration-required") return projected;
        if (hydration.messageId !== message.id) return projected;
        return {
            ...projected,
            hydration: hydrationState(hydration),
        };
    });
    return foldHistoryToolResults(projectedMessages);
}

/**
 * Combines canonical history and ephemeral runtime rows without duplicate identities.
 * @param history Canonical provider transcript.
 * @param runtime Ephemeral optimistic and active-run rows.
 * @param hiddenMessageIds Browser-local hidden identities.
 * @returns One chronological visible transcript.
 */
export function mergeChatMessages(
    history: readonly ChatDisplayMessage[],
    runtime: readonly ChatDisplayMessage[],
    hiddenMessageIds: ReadonlySet<string>
): readonly ChatDisplayMessage[] {
    const canonicalIds = new Set(history.map(({ id }) => id));
    const canonical = history.filter((message) => !hiddenMessageIds.has(message.id));
    const ephemeral = runtime
        .filter(
            (message) =>
                !canonicalIds.has(message.id) && !hiddenMessageIds.has(message.id)
        )
        .toSorted(
            (left, right) =>
                (left.timestampMs ?? Number.MAX_SAFE_INTEGER) -
                    (right.timestampMs ?? Number.MAX_SAFE_INTEGER) ||
                left.sequence - right.sequence ||
                left.id.localeCompare(right.id)
        );
    return [...canonical, ...ephemeral];
}
