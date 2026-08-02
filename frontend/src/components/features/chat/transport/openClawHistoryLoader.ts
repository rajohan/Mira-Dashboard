import {
    parseCanonicalChatHistoryMessageResult,
    parseCanonicalChatHistoryPage,
    type CanonicalChatHistoryPage,
    type CanonicalChatHistoryMessageResult,
    type CanonicalChatHistoryRow,
} from "../../../../../../contracts/chat/canonicalHistory";
import type { ChatHistoryMessage } from "../chatTypes";
import { OpenClawChatAdapter } from "./openClawChatAdapter";
import { appendOpenClawHistory } from "./openClawHistoryAdapter";
import {
    fullMessagePreviewCacheKey,
    hasIncrementalHistorySequenceMetadata,
    historyMessageId,
    OpenClawHistoryCache,
    type OpenClawHistoryCacheEntry,
    historySequence,
    mergeCachedHistoryRows,
} from "./openClawHistoryCache";

export interface OpenClawHistoryPageRequest extends Record<string, unknown> {
    limit: number;
    offset: number;
    sessionKey: string;
}

export interface OpenClawHistoryMessageRequest extends Record<string, unknown> {
    maxChars: number;
    messageId: string;
    sessionKey: string;
}

type RequestHistoryPage = (request: OpenClawHistoryPageRequest) => Promise<unknown>;
type RequestFullMessage = (request: OpenClawHistoryMessageRequest) => Promise<unknown>;

type OpenClawHistoryPage = CanonicalChatHistoryPage;

const MAX_CONCURRENT_FULL_MESSAGE_REQUESTS = 4;
const MAX_FULL_MESSAGE_CHARACTERS = 2_000_000;

function parseHistoryPage(raw: unknown, requestedOffset: number): OpenClawHistoryPage {
    const page = parseCanonicalChatHistoryPage(raw, "chat.history");
    if (page.offset !== requestedOffset) {
        throw new Error("OpenClaw returned a mismatched chat history page offset");
    }
    return page;
}

function parseFullMessage(raw: unknown): CanonicalChatHistoryMessageResult {
    return parseCanonicalChatHistoryMessageResult(raw, "chat.message.get");
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
    rows: CanonicalChatHistoryRow[]
): void {
    for (const row of page.messages) {
        const id = historyMessageId(row);
        if (!seenIds.has(id)) {
            seenIds.add(id);
            rows.push(row);
        }
    }
}

function orderedUniqueMessages(pages: OpenClawHistoryPage[]): CanonicalChatHistoryRow[] {
    const seenIds = new Set<string>();
    const rows: CanonicalChatHistoryRow[] = [];
    for (const page of pages.toReversed()) {
        appendUniquePageMessages(page, seenIds, rows);
    }
    return rows;
}

/** Loads the complete Gateway transcript once, then incrementally extends it. */
export class OpenClawHistoryLoader {
    readonly #adapter: OpenClawChatAdapter;
    readonly #cache = new OpenClawHistoryCache();
    readonly #pending = new Map<string, Promise<ChatHistoryMessage[]>>();
    readonly #requestFullMessage?: RequestFullMessage;
    readonly #requestPage: RequestHistoryPage;
    #generation = 0;

    constructor(
        adapter: OpenClawChatAdapter,
        requestPage: RequestHistoryPage,
        requestFullMessage?: RequestFullMessage
    ) {
        this.#adapter = adapter;
        this.#requestPage = requestPage;
        this.#requestFullMessage = requestFullMessage;
    }

    reset(): void {
        this.#generation += 1;
        this.#cache.reset();
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

    async #fullMessage(
        preview: CanonicalChatHistoryRow
    ): Promise<CanonicalChatHistoryRow | undefined> {
        const messageId = preview.messageId;
        if (!preview.truncated || !messageId || !this.#requestFullMessage) {
            return undefined;
        }
        const cacheKey = fullMessagePreviewCacheKey(preview, messageId);
        const cached = this.#cache.fullMessage(cacheKey);
        if (cached) return cached;

        const request = (async () => {
            try {
                const result = parseFullMessage(
                    await this.#requestFullMessage!({
                        maxChars: MAX_FULL_MESSAGE_CHARACTERS,
                        messageId,
                        sessionKey: preview.sessionKey,
                    })
                );
                if (!result.ok || result.message.id !== preview.id) {
                    return;
                }
                return {
                    ...result.message,
                    sequence: result.message.sequence ?? preview.sequence,
                };
            } catch {
                this.#cache.deleteFullMessage(cacheKey);
                return;
            }
        })();
        this.#cache.rememberFullMessage(cacheKey, request);
        return request;
    }

    async #hydrateRows(
        rows: CanonicalChatHistoryRow[]
    ): Promise<CanonicalChatHistoryRow[]> {
        if (!this.#requestFullMessage) {
            return rows;
        }
        const candidateIndexes = rows.flatMap((row, index) =>
            row.truncated && row.messageId ? [index] : []
        );
        if (candidateIndexes.length === 0) {
            return rows;
        }
        const hydrated = [...rows];
        let cursor = 0;
        const workers = Array.from(
            {
                length: Math.min(
                    MAX_CONCURRENT_FULL_MESSAGE_REQUESTS,
                    candidateIndexes.length
                ),
            },
            async () => {
                while (cursor < candidateIndexes.length) {
                    const index = candidateIndexes[cursor++]!;
                    const preview = rows[index]!;
                    const fullMessage = await this.#fullMessage(preview);
                    if (fullMessage) {
                        hydrated[index] = fullMessage;
                    }
                }
            }
        );
        await Promise.all(workers);
        return hydrated;
    }

    async #pagesUntil(
        sessionKey: string,
        limit: number,
        first: OpenClawHistoryPage,
        throughSequence?: number
    ): Promise<OpenClawHistoryPage[]> {
        const pages = [first];
        const visitedOffsets = new Set([first.offset]);
        let page = first;
        while (
            page.hasMore &&
            (throughSequence === undefined ||
                !hasPageReachedSequence(page, throughSequence))
        ) {
            const nextOffset = page.nextOffset;
            if (
                nextOffset === undefined ||
                nextOffset <= page.offset ||
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

    async #completeCachedBoundaryRows(
        sessionKey: string,
        limit: number,
        pages: OpenClawHistoryPage[],
        cached: OpenClawHistoryCacheEntry
    ): Promise<CanonicalChatHistoryRow[]> {
        const initialRows = orderedUniqueMessages(pages);
        if (!hasIncrementalHistorySequenceMetadata(initialRows)) {
            return initialRows;
        }
        const boundaryRow = initialRows[0];
        if (!boundaryRow) {
            return initialRows;
        }
        const boundarySequence = historySequence(boundaryRow);
        if (boundarySequence === undefined) {
            return initialRows;
        }
        const freshBoundaryIds = new Set(
            initialRows
                .filter((row) => historySequence(row) === boundarySequence)
                .map((row) => historyMessageId(row))
        );
        const hasMissingCachedSibling = cached.rows.some(
            (row) =>
                historySequence(row) === boundarySequence &&
                !freshBoundaryIds.has(historyMessageId(row))
        );
        let page = pages.at(-1);
        if (!hasMissingCachedSibling || !page?.hasMore) {
            return initialRows;
        }

        const extendedPages = [...pages];
        const visitedOffsets = new Set(pages.map((candidate) => candidate.offset));
        while (page.hasMore) {
            const nextOffset = page.nextOffset;
            if (
                nextOffset === undefined ||
                nextOffset <= page.offset ||
                visitedOffsets.has(nextOffset)
            ) {
                throw new Error("OpenClaw returned an invalid chat history page offset");
            }
            visitedOffsets.add(nextOffset);
            const nextPage = await this.#page(sessionKey, limit, nextOffset);
            if (!isSameHistorySession(pages[0]?.sessionId, nextPage.sessionId)) {
                throw new Error(
                    "OpenClaw chat session changed while history was loading"
                );
            }
            extendedPages.push(nextPage);
            page = nextPage;

            if (!hasIncrementalHistorySequenceMetadata(nextPage.messages)) {
                return orderedUniqueMessages(extendedPages);
            }
            if (
                nextPage.messages.some((row) => historySequence(row) !== boundarySequence)
            ) {
                break;
            }
        }

        const initialIds = new Set(initialRows.map((row) => historyMessageId(row)));
        return orderedUniqueMessages(extendedPages).filter(
            (row) =>
                initialIds.has(historyMessageId(row)) ||
                historySequence(row) === boundarySequence
        );
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
        const orderedRows = await this.#hydrateRows(orderedUniqueMessages(pages));
        const rows = orderedRows.filter((row) => {
            const sequence = historySequence(row);
            return (
                throughSequence === undefined ||
                sequence === undefined ||
                sequence <= throughSequence
            );
        });
        const messages = this.#adapter.history(rows);
        if (
            !shouldCache ||
            throughSequence === undefined ||
            !hasIncrementalHistorySequenceMetadata(orderedRows)
        ) {
            this.#cache.deleteHistory(cacheKey);
        } else {
            this.#cache.rememberHistory(cacheKey, {
                limit,
                messages,
                rows,
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
        const cached = this.#cache.history(cacheKey);
        const totalMessages = first.totalMessages;
        const canReuse = Boolean(
            cached &&
            totalMessages !== undefined &&
            cached.limit === limit &&
            totalMessages >= cached.throughSequence &&
            hasIncrementalHistorySequenceMetadata(cached.rows) &&
            isSameHistorySession(cached.sessionId, first.sessionId)
        );
        if (!canReuse || !cached || totalMessages === undefined) {
            return this.#loadFresh(cacheKey, sessionKey, limit, first);
        }
        if (!hasIncrementalHistorySequenceMetadata(first.messages)) {
            return this.#loadFresh(cacheKey, sessionKey, limit, first, false);
        }
        const pages =
            totalMessages === cached.throughSequence
                ? [first]
                : await this.#pagesUntil(
                      sessionKey,
                      limit,
                      first,
                      cached.throughSequence
                  );
        const orderedRows = await this.#hydrateRows(
            await this.#completeCachedBoundaryRows(sessionKey, limit, pages, cached)
        );
        if (!hasIncrementalHistorySequenceMetadata(orderedRows)) {
            return this.#loadFresh(cacheKey, sessionKey, limit, first, false);
        }
        const merged = mergeCachedHistoryRows(cached, orderedRows, totalMessages);
        let messages = appendOpenClawHistory(cached.messages, merged.appendedRows);
        if (merged.didRewriteCachedRows) {
            messages = this.#adapter.history(merged.rows);
        }
        if (!merged.didRewriteCachedRows && merged.appendedRows.length === 0) {
            messages = cached.messages;
        }
        this.#cache.rememberHistory(cacheKey, {
            limit,
            messages,
            rows: merged.rows,
            sessionId: first.sessionId || cached.sessionId,
            throughSequence: totalMessages,
        });
        return messages;
    }

    async history(sessionKey: string, limit: number): Promise<ChatHistoryMessage[]> {
        const normalizedSessionKey = sessionKey.trim().toLowerCase();
        const cacheKey = `${this.#generation}:${normalizedSessionKey}:${limit}`;
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
