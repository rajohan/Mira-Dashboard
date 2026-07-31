import {
    parseCanonicalChatHistoryPage,
    type CanonicalChatHistoryPage,
    type CanonicalChatHistoryRow,
} from "../../../../../../contracts/chatCanonicalHistory";
import type { ChatHistoryMessage } from "../chatTypes";
import { OpenClawChatAdapter } from "./openClawChatAdapter";
import { appendOpenClawHistory } from "./openClawHistoryAdapter";

export interface OpenClawHistoryPageRequest extends Record<string, unknown> {
    limit: number;
    offset: number;
    sessionKey: string;
}

type RequestHistoryPage = (request: OpenClawHistoryPageRequest) => Promise<unknown>;

type OpenClawHistoryPage = CanonicalChatHistoryPage;

interface OpenClawHistoryCacheEntry {
    limit: number;
    messages: ChatHistoryMessage[];
    rows: CanonicalChatHistoryRow[];
    sessionId?: string;
    throughSequence: number;
}

const MAX_CACHED_HISTORY_ENTRIES = 2;

function historyMessageId(row: CanonicalChatHistoryRow): string {
    return row.id;
}

function historySequence(row: CanonicalChatHistoryRow): number | undefined {
    return row.sequence;
}

function hasSequenceFingerprintIdentity(row: CanonicalChatHistoryRow): boolean {
    const sequence = historySequence(row);
    if (sequence === undefined) {
        return false;
    }
    const rowPrefix = `openclaw-history:${encodeURIComponent(row.sessionKey)}:`;
    const sourcePrefix = encodeURIComponent(`sequence:${sequence}:fingerprint:`);
    return row.id.startsWith(`${rowPrefix}${sourcePrefix}`);
}

function hasIncrementalHistorySequenceMetadata(
    rows: readonly CanonicalChatHistoryRow[]
): boolean {
    return rows.every((row) => historySequence(row) !== undefined);
}

function parseHistoryPage(raw: unknown, requestedOffset: number): OpenClawHistoryPage {
    const page = parseCanonicalChatHistoryPage(raw, "chat.history");
    if (page.offset !== requestedOffset) {
        throw new Error("OpenClaw returned a mismatched chat history page offset");
    }
    return page;
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

interface MergedCachedHistory {
    appendedRows: CanonicalChatHistoryRow[];
    didRewriteCachedRows: boolean;
    rows: CanonicalChatHistoryRow[];
}

function mergeCachedHistoryRows(
    cached: OpenClawHistoryCacheEntry,
    freshRows: CanonicalChatHistoryRow[],
    throughSequence: number
): MergedCachedHistory {
    const freshRowOrder = new Map(
        freshRows.map((row, index) => [historyMessageId(row), index])
    );
    const refreshedSequences = new Set(
        freshRows.flatMap((row) => {
            const sequence = historySequence(row);
            return sequence === undefined || sequence > throughSequence ? [] : [sequence];
        })
    );
    const cachedById = new Map(
        cached.rows.flatMap((row) => {
            const sequence = historySequence(row);
            return sequence === undefined || sequence > throughSequence
                ? []
                : ([[historyMessageId(row), row]] as const);
        })
    );
    const sequenceFingerprintIds = new Map<number, Set<string>>();
    for (const [id, row] of cachedById) {
        const sequence = historySequence(row);
        if (sequence === undefined || !hasSequenceFingerprintIdentity(row)) {
            continue;
        }
        const ids = sequenceFingerprintIds.get(sequence) ?? new Set<string>();
        ids.add(id);
        sequenceFingerprintIds.set(sequence, ids);
    }
    const appendedRows: CanonicalChatHistoryRow[] = [];
    let didRewriteCachedRows = false;
    const replacedFingerprintSequences = new Set<number>();
    const freshFingerprintRows = new Map<number, CanonicalChatHistoryRow[]>();
    const freshIdsBySequence = new Map<number, Set<string>>();
    for (const row of freshRows) {
        const sequence = historySequence(row);
        if (sequence === undefined || sequence > throughSequence) {
            continue;
        }
        const freshIds = freshIdsBySequence.get(sequence) ?? new Set<string>();
        freshIds.add(historyMessageId(row));
        freshIdsBySequence.set(sequence, freshIds);
        if (!hasSequenceFingerprintIdentity(row)) {
            continue;
        }
        freshFingerprintRows.set(sequence, [
            ...(freshFingerprintRows.get(sequence) ?? []),
            row,
        ]);
    }
    for (const [sequence, cachedIds] of sequenceFingerprintIds) {
        if (!refreshedSequences.has(sequence)) {
            continue;
        }
        const rows = freshFingerprintRows.get(sequence) ?? [];
        const freshIds = new Set(rows.map((row) => historyMessageId(row)));
        const hasSameIds =
            cachedIds.size === freshIds.size &&
            [...freshIds].every((id) => cachedIds.has(id));
        if (sequence > cached.throughSequence || hasSameIds) {
            continue;
        }
        for (const staleId of cachedIds) {
            cachedById.delete(staleId);
        }
        for (const row of rows) {
            cachedById.set(historyMessageId(row), row);
        }
        didRewriteCachedRows = true;
        replacedFingerprintSequences.add(sequence);
    }
    for (const [id, row] of cachedById) {
        const sequence = historySequence(row);
        if (
            sequence === undefined ||
            !refreshedSequences.has(sequence) ||
            hasSequenceFingerprintIdentity(row) ||
            freshIdsBySequence.get(sequence)?.has(id)
        ) {
            continue;
        }
        cachedById.delete(id);
        didRewriteCachedRows = true;
    }
    for (const row of freshRows) {
        const sequence = historySequence(row);
        if (sequence === undefined || sequence > throughSequence) {
            continue;
        }
        if (
            replacedFingerprintSequences.has(sequence) &&
            hasSequenceFingerprintIdentity(row)
        ) {
            continue;
        }
        const id = historyMessageId(row);
        const previous = cachedById.get(id);
        if (!previous) {
            if (sequence > cached.throughSequence) {
                appendedRows.push(row);
            } else {
                didRewriteCachedRows = true;
            }
        } else if (JSON.stringify(previous) !== JSON.stringify(row)) {
            didRewriteCachedRows = true;
        }
        cachedById.set(id, row);
    }
    return {
        appendedRows,
        didRewriteCachedRows,
        rows: cachedById
            .values()
            .toArray()
            .toSorted((left, right) => {
                const leftSequence = historySequence(left) ?? 0;
                const rightSequence = historySequence(right) ?? 0;
                const sequenceOrder = leftSequence - rightSequence;
                if (sequenceOrder !== 0 || !refreshedSequences.has(leftSequence)) {
                    return sequenceOrder;
                }
                return (
                    (freshRowOrder.get(historyMessageId(left)) ??
                        Number.MAX_SAFE_INTEGER) -
                    (freshRowOrder.get(historyMessageId(right)) ??
                        Number.MAX_SAFE_INTEGER)
                );
            }),
    };
}

/** Loads the complete Gateway transcript once, then incrementally extends it. */
export class OpenClawHistoryLoader {
    readonly #adapter: OpenClawChatAdapter;
    readonly #cache = new Map<string, OpenClawHistoryCacheEntry>();
    readonly #pending = new Map<string, Promise<ChatHistoryMessage[]>>();
    readonly #requestPage: RequestHistoryPage;
    #generation = 0;

    constructor(adapter: OpenClawChatAdapter, requestPage: RequestHistoryPage) {
        this.#adapter = adapter;
        this.#requestPage = requestPage;
    }

    reset(): void {
        this.#generation += 1;
        this.#cache.clear();
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
        const orderedRows = orderedUniqueMessages(pages);
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
            this.#cache.delete(cacheKey);
        } else {
            this.#remember(cacheKey, {
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
        const cached = this.#cached(cacheKey);
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
        const orderedRows = await this.#completeCachedBoundaryRows(
            sessionKey,
            limit,
            pages,
            cached
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
        this.#remember(cacheKey, {
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
