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
import { projectChatContractMessage } from "./chatContractAdapter.ts";
import type { ChatDisplayMessage, ChatSessionOption } from "./chatTypes.ts";

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
    return contractMessages.map((message, index) => {
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
