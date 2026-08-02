import {
    canonicalChatContentFingerprint,
    summarizeCanonicalChatValueForFingerprint,
} from "../../../../../../contracts/chat/canonicalContentIdentity";
import type { CanonicalChatHistoryRow } from "../../../../../../contracts/chat/canonicalHistory";
import { stableCanonicalChatStringify } from "../../../../../../contracts/chat/canonicalUtilities";
import type { ChatHistoryMessage } from "../chatTypes";

const MAX_CACHED_HISTORY_ENTRIES = 2;
const MAX_CACHED_FULL_MESSAGE_ENTRIES = 128;

export interface OpenClawHistoryCacheEntry {
    limit: number;
    messages: ChatHistoryMessage[];
    rows: CanonicalChatHistoryRow[];
    sessionId?: string;
    throughSequence: number;
}

export function fullMessagePreviewCacheKey(
    preview: CanonicalChatHistoryRow,
    messageId: string
): string {
    const previewFingerprint = canonicalChatContentFingerprint(
        stableCanonicalChatStringify({
            id: preview.id,
            message: summarizeCanonicalChatValueForFingerprint(preview.message),
            provider: preview.provider,
            sequence: preview.sequence,
        })
    );
    return `${preview.sessionKey.toLowerCase()}:${messageId}:${previewFingerprint}`;
}

export function historyMessageId(row: CanonicalChatHistoryRow): string {
    return row.id;
}

export function historySequence(row: CanonicalChatHistoryRow): number | undefined {
    return row.sequence;
}

function hasSequenceFingerprintIdentity(row: CanonicalChatHistoryRow): boolean {
    const sequence = historySequence(row);
    if (sequence === undefined) return false;
    const rowPrefix = `openclaw-history:${encodeURIComponent(row.sessionKey)}:`;
    const sourcePrefix = encodeURIComponent(`sequence:${sequence}:fingerprint:`);
    return row.id.startsWith(`${rowPrefix}${sourcePrefix}`);
}

export function hasIncrementalHistorySequenceMetadata(
    rows: readonly CanonicalChatHistoryRow[]
): boolean {
    return rows.every((row) => historySequence(row) !== undefined);
}

export interface MergedCachedHistory {
    appendedRows: CanonicalChatHistoryRow[];
    didRewriteCachedRows: boolean;
    rows: CanonicalChatHistoryRow[];
}

export function mergeCachedHistoryRows(
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
        if (sequence === undefined || !hasSequenceFingerprintIdentity(row)) continue;
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
        if (sequence === undefined || sequence > throughSequence) continue;
        const freshIds = freshIdsBySequence.get(sequence) ?? new Set<string>();
        freshIds.add(historyMessageId(row));
        freshIdsBySequence.set(sequence, freshIds);
        if (!hasSequenceFingerprintIdentity(row)) continue;
        freshFingerprintRows.set(sequence, [
            ...(freshFingerprintRows.get(sequence) ?? []),
            row,
        ]);
    }
    for (const [sequence, cachedIds] of sequenceFingerprintIds) {
        if (!refreshedSequences.has(sequence)) continue;
        const rows = freshFingerprintRows.get(sequence) ?? [];
        const freshIds = new Set(rows.map((row) => historyMessageId(row)));
        const hasSameIds =
            cachedIds.size === freshIds.size &&
            [...freshIds].every((id) => cachedIds.has(id));
        if (sequence > cached.throughSequence || hasSameIds) continue;
        for (const staleId of cachedIds) cachedById.delete(staleId);
        for (const row of rows) cachedById.set(historyMessageId(row), row);
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
        if (sequence === undefined || sequence > throughSequence) continue;
        if (
            replacedFingerprintSequences.has(sequence) &&
            hasSequenceFingerprintIdentity(row)
        ) {
            continue;
        }
        const id = historyMessageId(row);
        const previous = cachedById.get(id);
        if (!previous) {
            if (sequence > cached.throughSequence) appendedRows.push(row);
            else didRewriteCachedRows = true;
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

export class OpenClawHistoryCache {
    readonly #fullMessages = new Map<
        string,
        Promise<CanonicalChatHistoryRow | undefined>
    >();
    readonly #history = new Map<string, OpenClawHistoryCacheEntry>();

    reset(): void {
        this.#history.clear();
        this.#fullMessages.clear();
    }

    history(cacheKey: string): OpenClawHistoryCacheEntry | undefined {
        const cached = this.#history.get(cacheKey);
        if (cached) {
            this.#history.delete(cacheKey);
            this.#history.set(cacheKey, cached);
        }
        return cached;
    }

    rememberHistory(cacheKey: string, entry: OpenClawHistoryCacheEntry): void {
        this.#history.delete(cacheKey);
        this.#history.set(cacheKey, entry);
        trimOldest(this.#history, MAX_CACHED_HISTORY_ENTRIES);
    }

    deleteHistory(cacheKey: string): void {
        this.#history.delete(cacheKey);
    }

    fullMessage(
        cacheKey: string
    ): Promise<CanonicalChatHistoryRow | undefined> | undefined {
        const cached = this.#fullMessages.get(cacheKey);
        if (cached) {
            this.#fullMessages.delete(cacheKey);
            this.#fullMessages.set(cacheKey, cached);
        }
        return cached;
    }

    rememberFullMessage(
        cacheKey: string,
        request: Promise<CanonicalChatHistoryRow | undefined>
    ): void {
        this.#fullMessages.delete(cacheKey);
        this.#fullMessages.set(cacheKey, request);
        trimOldest(this.#fullMessages, MAX_CACHED_FULL_MESSAGE_ENTRIES);
    }

    deleteFullMessage(cacheKey: string): void {
        this.#fullMessages.delete(cacheKey);
    }
}

function trimOldest<Value>(entries: Map<string, Value>, maximumSize: number): void {
    while (entries.size > maximumSize) {
        const oldestKey = entries.keys().next().value;
        if (!oldestKey) break;
        entries.delete(oldestKey);
    }
}
