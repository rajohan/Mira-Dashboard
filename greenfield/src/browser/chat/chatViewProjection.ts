import type { InfiniteData } from "@tanstack/react-query";

import type {
    ChatHistoryOutput,
    ChatMessageGetOutput,
    ChatModelsListOutput,
} from "../../contracts/chat.ts";
import { normalizeChatProviderUserIdentity } from "../../contracts/chatModel.ts";
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
import { sortChatDisplayMessages } from "./chatMessageOrdering.ts";
import type {
    ChatDisplayMessage,
    ChatMessageAttachment,
    ChatMessagePart,
    ChatSessionOption,
} from "./chatTypes.ts";

function unique(values: readonly (string | undefined)[]): readonly string[] {
    return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function canonicalModel(
    model: string | undefined,
    inventory: readonly string[]
): string | undefined {
    if (model === undefined || model.includes("/")) return model;
    const matches = inventory.filter((candidate) => candidate.endsWith(`/${model}`));
    return matches.length === 1 ? matches[0] : model;
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
    return snapshot.sessions.map((session) => {
        const model = canonicalModel(session.model, globalModels);
        return {
            activeRunCount:
                session.activeRunIds?.length ?? (session.hasActiveRun ? 1 : 0),
            ...(session.contextTokens === undefined
                ? {}
                : { contextTokens: session.contextTokens }),
            displayName: session.displayName,
            ...(session.fastMode === undefined ? {} : { fastMode: session.fastMode }),
            isDefault: session.key === gatewayPrimarySessionKey,
            key: session.key,
            ...(model === undefined ? {} : { model }),
            modelOptions: unique([model, ...globalModels]),
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
        };
    });
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
    const chronologicalMessages = projectedMessages
        .map((message, providerIndex) => ({ message, providerIndex }))
        .toSorted((left, right) => {
            if (
                left.message.timestampMs === undefined ||
                right.message.timestampMs === undefined
            ) {
                return left.providerIndex - right.providerIndex;
            }
            return (
                left.message.timestampMs - right.message.timestampMs ||
                left.providerIndex - right.providerIndex
            );
        })
        .map(({ message }) => message);
    return foldHistoryToolResults(
        placeResetBoundariesBeforeTriggeringUsers(
            projectedMessages,
            chronologicalMessages
        )
    );
}

function chatDisplayMessageText(message: ChatDisplayMessage): string {
    return message.parts
        .flatMap((part) => (part.kind === "text" ? [part.text] : []))
        .join("");
}

function isResetBoundaryMessage(message: ChatDisplayMessage): boolean {
    return (
        message.role === "control" &&
        message.parts.length === 1 &&
        (message.parts[0]?.kind === "control" || message.parts[0]?.kind === "text") &&
        message.parts[0].text === "Reset"
    );
}

function placeResetBoundariesBeforeTriggeringUsers(
    providerOrdered: readonly ChatDisplayMessage[],
    chronological: readonly ChatDisplayMessage[]
): readonly ChatDisplayMessage[] {
    const ordered = [...chronological];
    for (const [providerIndex, reset] of providerOrdered.entries()) {
        if (!isResetBoundaryMessage(reset)) continue;
        const triggeringUser = providerOrdered
            .slice(providerIndex + 1)
            .find(({ role }) => role === "user");
        if (triggeringUser === undefined) continue;
        const resetIndex = ordered.findIndex(({ id }) => id === reset.id);
        if (resetIndex === -1) continue;
        ordered.splice(resetIndex, 1);
        const triggeringUserIndex = ordered.findIndex(
            ({ id }) => id === triggeringUser.id
        );
        if (triggeringUserIndex === -1) continue;
        ordered.splice(triggeringUserIndex, 0, reset);
    }
    return ordered;
}

function externalRuntimeMessage(message: ChatDisplayMessage): boolean {
    return message.providerRunId !== undefined && message.id.startsWith("external:");
}

function toolPartsShareIdentity(
    left: Extract<ChatMessagePart, { kind: "tool" }>,
    right: Extract<ChatMessagePart, { kind: "tool" }>
): boolean {
    if (left.callId === right.callId) return true;
    if (
        chatToolResultMatchesCall(left, right) ||
        chatToolResultMatchesCall(right, left)
    ) {
        return true;
    }
    if (
        left.status === "running" ||
        right.status === "running" ||
        left.callIdSource !== "synthetic" ||
        right.callIdSource !== "synthetic" ||
        left.nameSource === "synthetic" ||
        right.nameSource === "synthetic" ||
        left.name !== right.name
    ) {
        return false;
    }
    const comparableDetails = ["input", "output"] as const;
    let compared = false;
    for (const key of comparableDetails) {
        if (left[key] === undefined || right[key] === undefined) continue;
        compared = true;
        try {
            if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) return false;
        } catch {
            return false;
        }
    }
    return compared;
}

function mergeExternalPartIntoCanonical(
    canonical: ChatDisplayMessage[],
    candidateIndexes: readonly number[],
    externalPart: ChatMessagePart,
    claimedCanonicalToolParts: Set<string>,
    removedCanonicalParts: ReadonlyMap<number, ReadonlySet<number>>
): boolean {
    for (const messageIndex of candidateIndexes) {
        const message = canonical[messageIndex];
        if (message === undefined) continue;
        const partIndex = message.parts.findIndex((part, candidatePartIndex) => {
            if (removedCanonicalParts.get(messageIndex)?.has(candidatePartIndex)) {
                return false;
            }
            if (part.kind !== externalPart.kind) return false;
            if (part.kind === "tool" && externalPart.kind === "tool") {
                return (
                    !claimedCanonicalToolParts.has(
                        `${messageIndex}:${candidatePartIndex}`
                    ) && toolPartsShareIdentity(part, externalPart)
                );
            }
            if (part.kind === "thinking" && externalPart.kind === "thinking") {
                return (
                    (part.sourceKey !== undefined &&
                        part.sourceKey === externalPart.sourceKey) ||
                    part.text.startsWith(externalPart.text) ||
                    externalPart.text.startsWith(part.text)
                );
            }
            if (part.kind === "control" && externalPart.kind === "control") {
                return (
                    part.text === externalPart.text ||
                    (part.activity !== undefined &&
                        part.activity === externalPart.activity)
                );
            }
            return false;
        });
        if (partIndex === -1) continue;
        const previous = message.parts[partIndex];
        if (previous === undefined) return true;
        let merged = externalPart;
        if (previous.kind === "tool" && externalPart.kind === "tool") {
            merged = mergeChatToolPart(previous, externalPart);
        } else if (previous.kind === "thinking" && externalPart.kind === "thinking") {
            merged = {
                ...previous,
                ...externalPart,
                status:
                    previous.status === "complete" || externalPart.status === "complete"
                        ? "complete"
                        : "running",
                text:
                    externalPart.text.length > previous.text.length
                        ? externalPart.text
                        : previous.text,
            };
        } else if (previous.kind === "control" && externalPart.kind === "control") {
            merged = {
                ...previous,
                ...externalPart,
                ...(previous.activity === "complete"
                    ? { activity: "complete" as const }
                    : {}),
            };
        }
        canonical[messageIndex] = {
            ...message,
            parts: message.parts.with(partIndex, merged),
        };
        if (externalPart.kind === "tool") {
            claimedCanonicalToolParts.add(`${messageIndex}:${partIndex}`);
        }
        return true;
    }
    return false;
}

interface ExternalAnchorPlacement {
    readonly afterCanonical: ReadonlyMap<string, readonly string[]>;
    readonly anchoredExternalIds: ReadonlySet<string>;
    readonly beforeCanonical: ReadonlyMap<string, readonly string[]>;
    readonly providerRunIdByCanonicalUser: ReadonlyMap<string, string>;
}

function placeExternalActivityAroundCanonicalUsers(
    canonical: readonly ChatDisplayMessage[],
    runtime: readonly ChatDisplayMessage[]
): ExternalAnchorPlacement {
    const externalGroups = Map.groupBy(
        runtime.filter(
            (message) => message.role === "assistant" && externalRuntimeMessage(message)
        ),
        (message) => message.providerRunId as string
    );
    const beforeCanonical = new Map<string, string[]>();
    const afterCanonical = new Map<string, string[]>();
    const anchoredExternalIds = new Set<string>();
    const claimedCanonicalUsers = new Set<string>();
    const providerRunIdByCanonicalUser = new Map<string, string>();
    for (const [providerRunId, messages] of externalGroups) {
        let chunkStart = 0;
        let previousAnchorId: string | undefined;
        for (const [index, message] of messages.entries()) {
            const exactAnchorId = message.precedingUserMessageIdAnchor;
            const textAnchor = message.precedingUserTextAnchor;
            if (exactAnchorId === undefined && textAnchor === undefined) continue;
            const matchingUsers = canonical.filter(
                (candidate) =>
                    candidate.role === "user" &&
                    !claimedCanonicalUsers.has(candidate.id) &&
                    (exactAnchorId === undefined
                        ? chatDisplayMessageText(candidate) === textAnchor
                        : [candidate.id, candidate.idempotencyKey].some(
                              (identity) =>
                                  identity !== undefined &&
                                  (normalizeChatProviderUserIdentity(identity) ??
                                      identity) ===
                                      (normalizeChatProviderUserIdentity(exactAnchorId) ??
                                          exactAnchorId)
                          ))
            );
            const canonicalUser =
                exactAnchorId === undefined
                    ? (matchingUsers.find(
                          (candidate) => candidate.providerRunId === providerRunId
                      ) ??
                      matchingUsers.find(
                          (candidate) => candidate.providerRunId === undefined
                      ))
                    : matchingUsers[0];
            if (canonicalUser === undefined) continue;
            claimedCanonicalUsers.add(canonicalUser.id);
            providerRunIdByCanonicalUser.set(canonicalUser.id, providerRunId);
            const chunkIds = messages.slice(chunkStart, index).map(({ id }) => id);
            if (previousAnchorId === undefined) {
                beforeCanonical.set(canonicalUser.id, [
                    ...(beforeCanonical.get(canonicalUser.id) ?? []),
                    ...chunkIds,
                ]);
            } else {
                afterCanonical.set(previousAnchorId, [
                    ...(afterCanonical.get(previousAnchorId) ?? []),
                    ...chunkIds,
                ]);
            }
            for (const id of chunkIds) anchoredExternalIds.add(id);
            previousAnchorId = canonicalUser.id;
            chunkStart = index;
        }
        if (previousAnchorId !== undefined) {
            const tailIds = messages.slice(chunkStart).map(({ id }) => id);
            afterCanonical.set(previousAnchorId, [
                ...(afterCanonical.get(previousAnchorId) ?? []),
                ...tailIds,
            ]);
            for (const id of tailIds) anchoredExternalIds.add(id);
        }
    }
    return {
        afterCanonical,
        anchoredExternalIds,
        beforeCanonical,
        providerRunIdByCanonicalUser,
    };
}

function mergeExternalActivityIntoCanonical(
    canonicalMessages: readonly ChatDisplayMessage[],
    runtimeMessages: readonly ChatDisplayMessage[],
    providerRunIdByCanonicalUser: ReadonlyMap<string, string>
): Readonly<{
    canonical: readonly ChatDisplayMessage[];
    runtime: readonly ChatDisplayMessage[];
}> {
    const canonical = canonicalMessages.map((message) => ({
        ...message,
        parts: [...message.parts],
    }));
    const assistantIndexesByRun = new Map<string, number[]>();
    let currentProviderRunId: string | undefined;
    for (const [index, message] of canonical.entries()) {
        if (message.role === "user") {
            currentProviderRunId =
                providerRunIdByCanonicalUser.get(message.id) ?? message.providerRunId;
            continue;
        }
        if (message.role !== "assistant") continue;
        const providerRunId = message.providerRunId ?? currentProviderRunId;
        if (providerRunId === undefined) continue;
        const indexes = assistantIndexesByRun.get(providerRunId) ?? [];
        indexes.push(index);
        assistantIndexesByRun.set(providerRunId, indexes);
    }
    const prefixLengths = new Map<number, number>();
    const claimedCanonicalToolParts = new Set<string>();
    const removedCanonicalParts = new Map<number, Set<number>>();
    const runtime: ChatDisplayMessage[] = [];
    for (const message of runtimeMessages) {
        if (!externalRuntimeMessage(message) || message.providerRunId === undefined) {
            runtime.push(message);
            continue;
        }
        const candidateIndexes = assistantIndexesByRun.get(message.providerRunId);
        if (candidateIndexes === undefined || candidateIndexes.length === 0) {
            runtime.push(message);
            continue;
        }
        const canonicalText = candidateIndexes
            .flatMap((index) =>
                (canonical[index]?.parts ?? []).filter(
                    (_part, partIndex) =>
                        !removedCanonicalParts.get(index)?.has(partIndex)
                )
            )
            .flatMap((part) => (part.kind === "text" ? [part.text] : []))
            .join("");
        const unmatched = message.parts.filter((part) => {
            if (
                part.kind === "text" &&
                part.text !== "" &&
                canonicalText.includes(part.text)
            ) {
                return false;
            }
            return !mergeExternalPartIntoCanonical(
                canonical,
                candidateIndexes,
                part,
                claimedCanonicalToolParts,
                removedCanonicalParts
            );
        });
        if (unmatched.length === 0) continue;
        const targetIndex =
            candidateIndexes.find(
                (index) => (canonical[index]?.sequence ?? Infinity) >= message.sequence
            ) ?? candidateIndexes.at(-1);
        if (targetIndex === undefined) {
            runtime.push({ ...message, parts: unmatched });
            continue;
        }
        const target = canonical[targetIndex];
        if (target === undefined) continue;
        if (message.sequence <= target.sequence) {
            const prefixLength = prefixLengths.get(targetIndex) ?? 0;
            canonical[targetIndex] = {
                ...target,
                parts: target.parts.toSpliced(prefixLength, 0, ...unmatched),
            };
            prefixLengths.set(targetIndex, prefixLength + unmatched.length);
        } else {
            canonical[targetIndex] = {
                ...target,
                parts: [...target.parts, ...unmatched],
            };
        }
    }
    return {
        canonical: canonical.map((message, messageIndex) => ({
            ...message,
            parts: message.parts.filter(
                (_part, partIndex) =>
                    !removedCanonicalParts.get(messageIndex)?.has(partIndex)
            ),
        })),
        runtime,
    };
}

/**
 * Combines canonical history and ephemeral runtime rows without duplicate identities.
 * @param history Canonical provider transcript.
 * @param runtime Ephemeral optimistic and active-run rows.
 * @returns One chronological visible transcript.
 */
export function mergeChatMessages(
    history: readonly ChatDisplayMessage[],
    runtime: readonly ChatDisplayMessage[]
): readonly ChatDisplayMessage[] {
    const canonicalUserIdentities = new Set(
        history.flatMap((message) =>
            message.role === "user"
                ? [message.id, message.idempotencyKey].flatMap((identity) =>
                      identity === undefined
                          ? []
                          : [normalizeChatProviderUserIdentity(identity) ?? identity]
                  )
                : []
        )
    );
    const runtimeAuthoritativeProviderRunIds = new Set(
        runtime.flatMap((message) => {
            if (message.role !== "user" || message.providerRunId === undefined) return [];
            const identity = message.idempotencyKey ?? message.id;
            const normalizedIdentity =
                normalizeChatProviderUserIdentity(identity) ?? identity;
            return canonicalUserIdentities.has(normalizedIdentity)
                ? []
                : [message.providerRunId];
        })
    );
    let canonical = history.filter(
        (message) =>
            message.role !== "assistant" ||
            message.providerRunId === undefined ||
            !runtimeAuthoritativeProviderRunIds.has(message.providerRunId)
    );
    const canonicalIds = new Set(canonical.map(({ id }) => id));
    const canonicalIdempotencyKeys = new Set(
        canonical.flatMap((message) =>
            message.idempotencyKey === undefined
                ? []
                : [
                      normalizeChatProviderUserIdentity(message.idempotencyKey) ??
                          message.idempotencyKey,
                  ]
        )
    );
    const canonicalAssistantProviderRunIds = new Set(
        canonical.flatMap((message) =>
            message.role === "assistant" && message.providerRunId !== undefined
                ? [message.providerRunId]
                : []
        )
    );
    const canonicalClientRunIds = new Set(
        canonical.flatMap((message) =>
            message.clientRunId === undefined ? [] : [message.clientRunId]
        )
    );
    const seenRuntimeUserIdentities = new Set<string>();
    const runtimeCandidates = runtime.filter((message) => {
        const runtimeUserIdentity =
            message.role === "user" && message.idempotencyKey !== undefined
                ? (normalizeChatProviderUserIdentity(message.idempotencyKey) ??
                  message.idempotencyKey)
                : undefined;
        if (
            runtimeUserIdentity !== undefined &&
            (canonicalIds.has(runtimeUserIdentity) ||
                canonicalIdempotencyKeys.has(runtimeUserIdentity) ||
                seenRuntimeUserIdentities.has(runtimeUserIdentity))
        ) {
            return false;
        }
        if (runtimeUserIdentity !== undefined) {
            seenRuntimeUserIdentities.add(runtimeUserIdentity);
        }
        return (
            !canonicalIds.has(message.id) &&
            !(
                message.clientRunId !== undefined &&
                canonicalClientRunIds.has(message.clientRunId)
            ) &&
            !(
                message.role === "user" &&
                runtimeUserIdentity !== undefined &&
                canonicalIdempotencyKeys.has(runtimeUserIdentity)
            ) &&
            !(
                message.role === "assistant" &&
                !externalRuntimeMessage(message) &&
                message.providerRunId !== undefined &&
                canonicalAssistantProviderRunIds.has(message.providerRunId)
            )
        );
    });
    const orderedRuntimeCandidates = sortChatDisplayMessages(runtimeCandidates);
    const anchorPlacement = placeExternalActivityAroundCanonicalUsers(
        canonical,
        orderedRuntimeCandidates
    );
    const mergedActivity = mergeExternalActivityIntoCanonical(
        canonical,
        orderedRuntimeCandidates,
        anchorPlacement.providerRunIdByCanonicalUser
    );
    canonical = [...mergedActivity.canonical];
    const ephemeral = sortChatDisplayMessages(mergedActivity.runtime);
    const ephemeralById = new Map(ephemeral.map((message) => [message.id, message]));
    const placedMessages = (ids: readonly string[] | undefined) =>
        ids?.flatMap((id) => {
            const message = ephemeralById.get(id);
            return message === undefined ? [] : [message];
        }) ?? [];
    const mergedCanonical = canonical.flatMap((message) => [
        ...placedMessages(anchorPlacement.beforeCanonical.get(message.id)),
        message,
        ...placedMessages(anchorPlacement.afterCanonical.get(message.id)),
    ]);
    const unanchored = ephemeral.filter(
        (message) => !anchorPlacement.anchoredExternalIds.has(message.id)
    );
    const ordered = [...mergedCanonical];
    for (const message of unanchored) {
        const occurredAtMs = message.timestampMs;
        if (occurredAtMs === undefined) {
            ordered.push(message);
            continue;
        }
        const insertionIndex = ordered.findIndex(
            (candidate) =>
                candidate.timestampMs !== undefined &&
                candidate.timestampMs > occurredAtMs
        );
        if (insertionIndex === -1) {
            ordered.push(message);
        } else {
            ordered.splice(insertionIndex, 0, message);
        }
    }
    return ordered;
}

type ChatSurfaceKind = ChatMessagePart["kind"];

/**
 * Splits normalized part kinds into independent presentation bubbles.
 * @param messages Provider-neutral transcript messages from the backend projection.
 * @returns Stable single-kind surfaces in the original message order.
 */
export function projectChatMessageSurfaces(
    messages: readonly ChatDisplayMessage[]
): readonly ChatDisplayMessage[] {
    return messages.flatMap((message) => {
        if (message.parts.length < 2) return [message];
        const groups: Array<{ kind: ChatSurfaceKind; parts: ChatMessagePart[] }> = [];
        for (const part of message.parts) {
            const current = groups.at(-1);
            if (current?.kind === part.kind) current.parts.push(part);
            else groups.push({ kind: part.kind, parts: [part] });
        }
        if (groups.length < 2) return [message];
        return groups.map((group, index) => ({
            ...message,
            attachments: index === 0 ? message.attachments : [],
            ...(index === groups.length - 1 ? {} : { hydration: undefined }),
            id: `${message.id}:surface:${index + 1}`,
            parts: group.parts,
            sourceMessageId: message.sourceMessageId ?? message.id,
        }));
    });
}
