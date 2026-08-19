import type { QueryKey } from "@tanstack/react-query";
import { useState } from "react";

export const liveHistoryArchiveQueryRoot = ["live-history-archive"] as const;

/**
 * @param row History row with a durable id.
 * @returns The conventional durable id for a history row.
 */
export function liveHistoryRowIdentity(row: { readonly id: string }): string {
    return row.id;
}

/**
 * @param row OpenClaw run projected by the server boundary.
 * @returns A stable OpenClaw run identity with a defensive timestamp fallback.
 */
export function liveHistoryRunIdentity(row: {
    readonly completedAtMs: number;
    readonly runId?: string;
}): string {
    return row.runId ?? String(row.completedAtMs);
}

/** @returns A cache key isolated from live invalidation and polling roots. */
export function liveHistoryArchiveQueryKey(queryKey: QueryKey) {
    return [...liveHistoryArchiveQueryRoot, ...queryKey] as const;
}

/** @returns A live-head cache key that remains under the feature invalidation root. */
export function liveHistoryHeadQueryKey(queryKey: QueryKey) {
    return [...queryKey, "live-head"] as const;
}

/**
 * Places the live head before immutable archive pages and removes overlapping rows.
 * @param liveRows Current first-page rows.
 * @param archiveRows Previously loaded immutable history rows.
 * @param identity Stable row identity selector.
 * @returns Current rows followed by unique archived rows.
 */
export function mergeLiveHistoryRows<T>(
    liveRows: readonly T[],
    archiveRows: readonly T[],
    identity: (row: T) => string
): T[] {
    const seen = new Set<string>();
    return [...liveRows, ...archiveRows].filter((row) => {
        const id = identity(row);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

/**
 * @param identity Stable row identity selector.
 * @returns A mount-scoped merger that retains rows seen in earlier live heads.
 */
export function createLiveHistoryAccumulator<T>(identity: (row: T) => string) {
    let retainedLiveRows = new Map<string, T>();
    return (
        liveRows: readonly T[],
        archiveRows: readonly T[],
        evictedIds: ReadonlySet<string> = new Set()
    ): T[] => {
        const archiveIds = new Set(archiveRows.map((row) => identity(row)));
        const nextRetainedLiveRows = new Map<string, T>();
        for (const row of liveRows) {
            const id = identity(row);
            if (!archiveIds.has(id) && !evictedIds.has(id)) {
                nextRetainedLiveRows.set(id, row);
            }
        }
        for (const [id, row] of retainedLiveRows) {
            if (!archiveIds.has(id) && !evictedIds.has(id)) {
                nextRetainedLiveRows.set(id, row);
            }
        }
        retainedLiveRows = nextRetainedLiveRows;
        return mergeLiveHistoryRows(
            liveRows.filter((row) => !evictedIds.has(identity(row))),
            [...retainedLiveRows.values(), ...archiveRows],
            identity
        );
    };
}

/**
 * @param identity Stable row identity selector.
 * @returns A merger with isolated mount-scoped accumulation per history scope.
 */
export function createScopedLiveHistoryAccumulator<T>(identity: (row: T) => string) {
    const scopes = new Map<string, ReturnType<typeof createLiveHistoryAccumulator<T>>>();
    return (
        scopeKey: string,
        liveRows: readonly T[],
        archiveRows: readonly T[],
        evictedIds?: ReadonlySet<string>
    ) => {
        let accumulate = scopes.get(scopeKey);
        if (accumulate === undefined) {
            accumulate = createLiveHistoryAccumulator(identity);
            scopes.set(scopeKey, accumulate);
        }
        return accumulate(liveRows, archiveRows, evictedIds);
    };
}

/**
 * @param liveRows Current first-page rows.
 * @param archiveRows Previously loaded archive rows.
 * @param identity Stable row identity selector for this history type.
 * @param scopeKey Stable identity for the selected history/filter scope.
 * @param evictedIds Identities confirmed deleted while this history is mounted.
 * @returns Current history plus live rows displaced between polling snapshots.
 */
export function useAccumulatedLiveHistoryRows<T>(
    liveRows: readonly T[],
    archiveRows: readonly T[],
    identity: (row: T) => string,
    scopeKey: string,
    evictedIds?: ReadonlySet<string>
): T[] {
    const [accumulate] = useState(() => createScopedLiveHistoryAccumulator(identity));
    return accumulate(scopeKey, liveRows, archiveRows, evictedIds);
}
