import type { QueryKey } from "@tanstack/react-query";

export const liveHistoryArchiveQueryRoot = ["live-history-archive"] as const;

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
