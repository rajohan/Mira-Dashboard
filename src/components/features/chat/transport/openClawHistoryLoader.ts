import type { ChatHistoryMessage } from "../chatTypes";
import { asRecord, stringValue } from "./openClawAdapterValues";
import { OpenClawChatAdapter } from "./openClawChatAdapter";
import { appendOpenClawHistory } from "./openClawHistoryAdapter";
import type { RawOpenClawHistoryMessage } from "./openClawHistoryNormalizer";

export interface OpenClawHistoryPageRequest extends Record<string, unknown> {
    limit: number;
    offset: number;
    sessionKey: string;
}

type RequestHistoryPage = (request: OpenClawHistoryPageRequest) => Promise<unknown>;

interface OpenClawHistoryPage {
    hasMore: boolean;
    messages: RawOpenClawHistoryMessage[];
    nextOffset?: number;
    requestedOffset: number;
    sessionId?: string;
    totalMessages?: number;
}

interface OpenClawHistoryCacheEntry {
    limit: number;
    messages: ChatHistoryMessage[];
    sessionId?: string;
    throughSequence: number;
}

const MAX_CACHED_HISTORY_ENTRIES = 2;

function nonNegativeInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

function historyMetadata(
    message: RawOpenClawHistoryMessage
): Record<string, unknown> | undefined {
    return asRecord(message.__openclaw);
}

function historyMessageId(message: RawOpenClawHistoryMessage): string | undefined {
    return stringValue(historyMetadata(message)?.id);
}

function historySequence(message: RawOpenClawHistoryMessage): number | undefined {
    return nonNegativeInteger(historyMetadata(message)?.seq);
}

function hasCompleteHistorySequenceMetadata(
    messages: readonly RawOpenClawHistoryMessage[]
): boolean {
    return messages.every((message) => historySequence(message) !== undefined);
}

function parseHistoryPage(raw: unknown, requestedOffset: number): OpenClawHistoryPage {
    const result = asRecord(raw);
    const messages = Array.isArray(result?.messages)
        ? result.messages.filter(
              (message): message is RawOpenClawHistoryMessage =>
                  asRecord(message) !== undefined
          )
        : [];
    return {
        hasMore: result?.hasMore === true,
        messages,
        nextOffset: nonNegativeInteger(result?.nextOffset),
        requestedOffset,
        sessionId: stringValue(result?.sessionId),
        totalMessages: nonNegativeInteger(result?.totalMessages),
    };
}

function isSameHistorySession(
    cachedSessionId: string | undefined,
    pageSessionId: string | undefined
): boolean {
    return !cachedSessionId || !pageSessionId || cachedSessionId === pageSessionId;
}

function hasPageReachedSequence(page: OpenClawHistoryPage, sequence: number): boolean {
    if (!page.hasMore) {
        return true;
    }
    return (
        page.totalMessages !== undefined &&
        page.nextOffset !== undefined &&
        page.totalMessages - page.nextOffset <= sequence
    );
}

function appendUniquePageMessages(
    page: OpenClawHistoryPage,
    seenIds: Set<string>,
    messages: RawOpenClawHistoryMessage[]
): void {
    for (const message of page.messages) {
        const id = historyMessageId(message);
        if (!id || !seenIds.has(id)) {
            if (id) {
                seenIds.add(id);
            }
            messages.push(message);
        }
    }
}

function orderedUniqueMessages(
    pages: OpenClawHistoryPage[]
): RawOpenClawHistoryMessage[] {
    const seenIds = new Set<string>();
    const messages: RawOpenClawHistoryMessage[] = [];
    for (const page of pages.toReversed()) {
        appendUniquePageMessages(page, seenIds, messages);
    }
    return messages;
}

/** Loads the complete Gateway transcript once, then incrementally extends it. */
export class OpenClawHistoryLoader {
    readonly #adapter: OpenClawChatAdapter;
    readonly #cache = new Map<string, OpenClawHistoryCacheEntry>();
    readonly #pending = new Map<string, Promise<ChatHistoryMessage[]>>();
    readonly #requestPage: RequestHistoryPage;

    constructor(adapter: OpenClawChatAdapter, requestPage: RequestHistoryPage) {
        this.#adapter = adapter;
        this.#requestPage = requestPage;
    }

    #cached(cacheKey: string): OpenClawHistoryCacheEntry | undefined {
        const cached = this.#cache.get(cacheKey);
        if (cached) {
            this.#cache.delete(cacheKey);
            this.#cache.set(cacheKey, cached);
        }
        return cached;
    }

    #remember(cacheKey: string, entry: OpenClawHistoryCacheEntry): void {
        this.#cache.delete(cacheKey);
        this.#cache.set(cacheKey, entry);
        while (this.#cache.size > MAX_CACHED_HISTORY_ENTRIES) {
            const oldestKey = this.#cache.keys().next().value;
            if (!oldestKey) {
                break;
            }
            this.#cache.delete(oldestKey);
        }
    }

    async #page(
        sessionKey: string,
        limit: number,
        offset: number
    ): Promise<OpenClawHistoryPage> {
        return parseHistoryPage(
            await this.#requestPage({ limit, offset, sessionKey }),
            offset
        );
    }

    async #pagesUntil(
        sessionKey: string,
        limit: number,
        first: OpenClawHistoryPage,
        throughSequence?: number
    ): Promise<OpenClawHistoryPage[]> {
        const pages = [first];
        const visitedOffsets = new Set([first.requestedOffset]);
        let page = first;
        while (
            page.hasMore &&
            (throughSequence === undefined ||
                !hasPageReachedSequence(page, throughSequence))
        ) {
            const nextOffset = page.nextOffset;
            if (
                nextOffset === undefined ||
                nextOffset <= page.requestedOffset ||
                visitedOffsets.has(nextOffset)
            ) {
                throw new Error("OpenClaw returned an invalid chat history page offset");
            }
            visitedOffsets.add(nextOffset);
            const nextPage = await this.#page(sessionKey, limit, nextOffset);
            if (!isSameHistorySession(first.sessionId, nextPage.sessionId)) {
                throw new Error(
                    "OpenClaw chat session changed while history was loading"
                );
            }
            pages.push(nextPage);
            page = nextPage;
        }
        return pages;
    }

    async #loadFresh(
        cacheKey: string,
        sessionKey: string,
        limit: number,
        first: OpenClawHistoryPage,
        shouldCache = true
    ): Promise<ChatHistoryMessage[]> {
        const pages = await this.#pagesUntil(sessionKey, limit, first);
        const throughSequence = first.totalMessages;
        const orderedMessages = orderedUniqueMessages(pages);
        const rawMessages = orderedMessages.filter((message) => {
            const sequence = historySequence(message);
            return (
                throughSequence === undefined ||
                sequence === undefined ||
                sequence <= throughSequence
            );
        });
        const messages = this.#adapter.history(rawMessages);
        if (
            !shouldCache ||
            throughSequence === undefined ||
            !hasCompleteHistorySequenceMetadata(orderedMessages)
        ) {
            this.#cache.delete(cacheKey);
        } else {
            this.#remember(cacheKey, {
                limit,
                messages,
                sessionId: first.sessionId,
                throughSequence,
            });
        }
        return messages;
    }

    async #load(
        cacheKey: string,
        sessionKey: string,
        limit: number
    ): Promise<ChatHistoryMessage[]> {
        const first = await this.#page(sessionKey, limit, 0);
        const cached = this.#cached(cacheKey);
        const totalMessages = first.totalMessages;
        const canReuse = Boolean(
            cached &&
            cached.limit === limit &&
            totalMessages !== undefined &&
            totalMessages >= cached.throughSequence &&
            isSameHistorySession(cached.sessionId, first.sessionId)
        );
        if (!canReuse || !cached || totalMessages === undefined) {
            return this.#loadFresh(cacheKey, sessionKey, limit, first);
        }
        if (!hasCompleteHistorySequenceMetadata(first.messages)) {
            return this.#loadFresh(cacheKey, sessionKey, limit, first, false);
        }
        if (totalMessages === cached.throughSequence) {
            return cached.messages;
        }

        const pages = await this.#pagesUntil(
            sessionKey,
            limit,
            first,
            cached.throughSequence
        );
        const orderedMessages = orderedUniqueMessages(pages);
        if (!hasCompleteHistorySequenceMetadata(orderedMessages)) {
            return this.#loadFresh(cacheKey, sessionKey, limit, first, false);
        }
        const appendedRawMessages = orderedMessages.filter((message) => {
            const sequence = historySequence(message);
            return (
                sequence !== undefined &&
                sequence > cached.throughSequence &&
                sequence <= totalMessages
            );
        });
        const messages =
            appendedRawMessages.length === 0
                ? cached.messages
                : appendOpenClawHistory(cached.messages, appendedRawMessages);
        this.#remember(cacheKey, {
            limit,
            messages,
            sessionId: first.sessionId || cached.sessionId,
            throughSequence: totalMessages,
        });
        return messages;
    }

    async history(sessionKey: string, limit: number): Promise<ChatHistoryMessage[]> {
        const normalizedSessionKey = sessionKey.trim().toLowerCase();
        const cacheKey = `${normalizedSessionKey}:${limit}`;
        const pending = this.#pending.get(cacheKey);
        if (pending) {
            return pending;
        }
        const request = this.#load(cacheKey, sessionKey, limit);
        this.#pending.set(cacheKey, request);
        try {
            return await request;
        } finally {
            this.#pending.delete(cacheKey);
        }
    }
}
