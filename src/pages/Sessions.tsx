import { useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import { WifiOff } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { sessionsCollection } from "../collections/sessions";
import {
    LiveFeedRow,
    SESSION_TYPES,
    SessionsTable,
} from "../components/features/sessions";
import { Alert } from "../components/ui/Alert";
import { Card } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { FilterButtonGroup } from "../components/ui/FilterButtonGroup";
import { Select } from "../components/ui/Select";
import { type FeedItem, useLiveFeed } from "../hooks";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { useSessionActions } from "../hooks/useSessionActions";
import { AUTO_REFRESH_MS } from "../lib/queryClient";
import { type Session } from "../types/session";
import { formatDate } from "../utils/format";
import { sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

const FEED_BOTTOM_THRESHOLD_PX = 32;
const MAX_STICKY_LIVE_FEED_ITEMS = 500;

/** Represents one rendered row in the virtualized live feed. */
export type FeedRow =
    | { kind: "separator"; key: string; label: string }
    | { kind: "message"; key: string; item: FeedItem };

/** Represents the virtualizer row geometry used for scroll anchoring. */
export interface FeedVirtualItem {
    end: number;
    index: number;
    start: number;
}

/** Represents the visible feed row and intra-row offset to restore after inserts. */
export interface FeedViewportAnchor {
    key: string;
    offset: number;
}

/** Captures the first visible message row so unpinned readers keep their place. */
export function getFeedViewportAnchor(
    container: HTMLDivElement | null,
    rows: FeedRow[],
    virtualItems: FeedVirtualItem[]
): FeedViewportAnchor | null {
    if (!container) {
        return null;
    }

    for (const virtualItem of virtualItems) {
        const row = rows[virtualItem.index];

        if (row?.kind === "message" && virtualItem.end >= container.scrollTop) {
            return {
                key: row.key,
                offset: Math.max(container.scrollTop - virtualItem.start, 0),
            };
        }
    }

    return null;
}

/** Finds a feed row index by stable row key. */
export function findFeedRowIndex(rows: FeedRow[], key: string): number {
    for (const [index, row] of rows.entries()) {
        if (row.key === key) {
            return index;
        }
    }

    return -1;
}

/** Trims retained feed items to the configured sticky history limit. */
export function trimLiveFeedItems(items: FeedItem[]): FeedItem[] {
    return items.length > MAX_STICKY_LIVE_FEED_ITEMS
        ? items.slice(-MAX_STICKY_LIVE_FEED_ITEMS)
        : items;
}

/** Restores the captured intra-row scroll offset after virtualizer alignment. */
export function restoreFeedViewportOffset(
    container: HTMLDivElement | null,
    anchor: FeedViewportAnchor
): number | null {
    if (!container) {
        return null;
    }

    container.scrollTop += anchor.offset;
    return container.scrollTop;
}

/** Renders the sessions UI. */
export function Sessions() {
    const { isConnected, error } = useOpenClawSocket();
    const sessionActions = useSessionActions();
    const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [typeFilter, setTypeFilter] = useState<string>("ALL");
    const [feedRoleFilter, setFeedRoleFilter] = useState<string>("ALL");
    const [feedSessionFilter, setFeedSessionFilter] = useState<string>("ALL");
    const [feedTypeFilter, setFeedTypeFilter] = useState<string>("ALL");
    const [liveFeed, setLiveFeed] = useState<FeedItem[]>([]);
    const [isFeedAtBottom, setIsFeedAtBottom] = useState(true);
    const liveFeedContainerReference = useRef<HTMLDivElement | null>(null);
    const shouldStickFeedToBottomReference = useRef(true);
    const lastKnownFeedScrollTopReference = useRef(0);
    const previousFeedRowsLengthReference = useRef(0);
    const previousFeedFilterKeyReference = useRef("ALL:ALL:ALL");
    const feedRowsReference = useRef<FeedRow[]>([]);
    const feedVirtualItemsReference = useRef<FeedVirtualItem[]>([]);
    const pendingFeedAnchorReference = useRef<FeedViewportAnchor | null>(null);

    const { data: sessions = [] } = useLiveQuery((q) =>
        q.from({ session: sessionsCollection })
    );

    const sessionRows = Array.isArray(sessions) ? sessions : [];
    const sortedSessions = sortSessionsByTypeAndActivity(sessionRows);
    const filteredSessions =
        typeFilter === "ALL"
            ? sortedSessions
            : sortedSessions.filter((s) => (s.type || "").toUpperCase() === typeFilter);

    const { data: latestFeedItems = [] } = useLiveFeed(
        sortedSessions,
        isConnected ? AUTO_REFRESH_MS : false
    );

    const filteredFeed = liveFeed.filter((item) => {
        if (feedRoleFilter !== "ALL" && item.role !== feedRoleFilter) return false;
        if (feedSessionFilter !== "ALL" && item.sessionKey !== feedSessionFilter)
            return false;
        if (feedTypeFilter !== "ALL" && item.sessionType !== feedTypeFilter) return false;
        return true;
    });

    const feedRows: FeedRow[] = [];

    let previousBucket = "";

    for (const item of filteredFeed) {
        const bucket = new Date(item.timestamp).toISOString().slice(0, 16);

        if (bucket !== previousBucket) {
            feedRows.push({
                kind: "separator",
                key: `sep-${bucket}`,
                label: formatDate(new Date(item.timestamp)),
            });
            previousBucket = bucket;
        }

        feedRows.push({ kind: "message", key: item.id, item });
    }

    const feedVirtualizer = useVirtualizer({
        count: feedRows.length,
        getItemKey: (index) => feedRows[index]?.key ?? `row-${index}`,
        getScrollElement: () => liveFeedContainerReference.current,
        estimateSize: (index) => (feedRows[index]?.kind === "separator" ? 28 : 112),
        measureElement: (element) => element.getBoundingClientRect().height,
        overscan: 8,
        useAnimationFrameWithResizeObserver: true,
    });

    const feedVirtualItems = feedVirtualizer.getVirtualItems();
    feedRowsReference.current = feedRows;
    feedVirtualItemsReference.current = feedVirtualItems;
    const firstFeedVirtualItem = feedVirtualItems[0];
    const lastFeedVirtualItem = feedVirtualItems.at(-1);
    const feedPaddingTop = firstFeedVirtualItem?.start ?? 0;
    const feedPaddingBottom = lastFeedVirtualItem
        ? Math.max(feedVirtualizer.getTotalSize() - lastFeedVirtualItem.end, 0)
        : 0;

    /** Returns whether the live-feed viewport is already pinned near the bottom. */
    const checkFeedIsAtBottom = () => {
        const container = liveFeedContainerReference.current;

        if (!container) {
            return true;
        }

        return (
            container.scrollHeight - container.scrollTop - container.clientHeight <=
            FEED_BOTTOM_THRESHOLD_PX
        );
    };

    /** Scrolls the virtualized live feed to the newest rendered row. */
    const scrollFeedToBottom = () => {
        const container = liveFeedContainerReference.current;
        if (!container || feedRows.length === 0) {
            return;
        }

        shouldStickFeedToBottomReference.current = true;
        setIsFeedAtBottom(true);
        feedVirtualizer.scrollToIndex(feedRows.length - 1, { align: "end" });
        lastKnownFeedScrollTopReference.current = container.scrollTop;
    };

    /** Tracks user scrolling so new feed rows only auto-stick when appropriate. */
    const handleFeedScroll = () => {
        const container = liveFeedContainerReference.current;
        if (container) {
            lastKnownFeedScrollTopReference.current = container.scrollTop;
        }

        const atBottom = checkFeedIsAtBottom();
        shouldStickFeedToBottomReference.current = atBottom;
        setIsFeedAtBottom((previous) => (previous === atBottom ? previous : atBottom));
    };

    useEffect(() => {
        if (latestFeedItems.length === 0) return;

        if (!shouldStickFeedToBottomReference.current) {
            pendingFeedAnchorReference.current = getFeedViewportAnchor(
                liveFeedContainerReference.current,
                feedRowsReference.current,
                feedVirtualItemsReference.current
            );
        }

        setLiveFeed((prev) => {
            const seen = new Set(prev.map((item) => item.id));
            const next = [...prev];
            let hasNewItems = false;

            for (const item of latestFeedItems) {
                if (!seen.has(item.id)) {
                    next.push(item);
                    seen.add(item.id);
                    hasNewItems = true;
                }
            }

            if (!hasNewItems) {
                pendingFeedAnchorReference.current = null;
                return prev;
            }

            const sorted = next.sort((a, b) => a.timestamp - b.timestamp);
            return trimLiveFeedItems(sorted);
        });
    }, [latestFeedItems]);

    useLayoutEffect(() => {
        const filterKey = `${feedRoleFilter}:${feedSessionFilter}:${feedTypeFilter}`;
        const filterChanged = previousFeedFilterKeyReference.current !== filterKey;
        const rowsWereAdded = feedRows.length > previousFeedRowsLengthReference.current;

        previousFeedFilterKeyReference.current = filterKey;
        previousFeedRowsLengthReference.current = feedRows.length;

        if (feedRows.length === 0) {
            return;
        }

        if (filterChanged) {
            shouldStickFeedToBottomReference.current = true;
            scrollFeedToBottom();
            return;
        }

        if (!rowsWereAdded) {
            return;
        }

        if (shouldStickFeedToBottomReference.current) {
            scrollFeedToBottom();

            const scrollFrame = requestAnimationFrame(scrollFeedToBottom);

            return () => cancelAnimationFrame(scrollFrame);
        }

        const anchor = pendingFeedAnchorReference.current;
        pendingFeedAnchorReference.current = null;

        if (anchor) {
            const anchorIndex = findFeedRowIndex(feedRows, anchor.key);

            if (anchorIndex !== -1) {
                feedVirtualizer.scrollToIndex(anchorIndex, { align: "start" });

                const scrollFrame = requestAnimationFrame(() => {
                    const restoredScrollTop = restoreFeedViewportOffset(
                        liveFeedContainerReference.current,
                        anchor
                    );
                    if (restoredScrollTop !== null) {
                        lastKnownFeedScrollTopReference.current = restoredScrollTop;
                    }
                });

                return () => cancelAnimationFrame(scrollFrame);
            }
        }

        return;
    }, [
        feedRows.length,
        feedVirtualizer,
        feedRoleFilter,
        feedSessionFilter,
        feedTypeFilter,
        scrollFeedToBottom,
    ]);

    /** Counts retained feed items for one normalized role filter. */
    const roleCount = (role: string) =>
        liveFeed.filter((item) => item.role === role).length;

    const feedRoleOptions = [
        { value: "ALL", label: `All roles (${liveFeed.length})` },
        { value: "assistant", label: `assistant (${roleCount("assistant")})` },
        { value: "user", label: `user (${roleCount("user")})` },
        { value: "system", label: `system (${roleCount("system")})` },
        { value: "tool", label: `tool (${roleCount("tool")})` },
        { value: "tool_result", label: `tool_result (${roleCount("tool_result")})` },
    ];

    const feedTypeOptions = [
        { value: "ALL", label: "All types" },
        ...SESSION_TYPES.filter((type) => type !== "ALL").map((type) => ({
            value: type,
            label: type,
        })),
    ];

    const feedSessionOptions = [
        { value: "ALL", label: "All sessions" },
        ...sortedSessions.slice(0, 20).map((session) => ({
            value: session.key,
            label: session.displayLabel || session.displayName || session.key,
        })),
    ];

    /** Deletes the selected session after confirmation and reports failures inline. */
    const handleDeleteConfirm = async () => {
        if (!deleteTarget || !deleteTarget.key || sessionActions.isDeleting) return;

        const target = deleteTarget;
        setDeleteError(null);
        setDeleteTarget(null);

        try {
            await sessionActions.remove(target.key);
        } catch (error_) {
            console.error("Failed to delete session:", error_);
            setDeleteError(
                error_ instanceof Error ? error_.message : "Failed to delete session"
            );
        }
    };

    const filterOptions = SESSION_TYPES.map((type) => ({ value: type, label: type }));

    return (
        <div className="p-3 sm:p-4 lg:p-6">
            <Card className="mb-4 bg-transparent p-0">
                <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 className="text-primary-300 text-sm font-semibold tracking-wide uppercase">
                        Live Feed (cross-session)
                    </h2>
                </div>

                <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Select
                        value={feedRoleFilter}
                        onChange={setFeedRoleFilter}
                        options={feedRoleOptions}
                        width="w-full"
                    />
                    <Select
                        value={feedTypeFilter}
                        onChange={setFeedTypeFilter}
                        options={feedTypeOptions}
                        width="w-full"
                    />
                    <Select
                        value={feedSessionFilter}
                        onChange={setFeedSessionFilter}
                        options={feedSessionOptions}
                        width="w-full"
                    />
                </div>

                {filteredFeed.length === 0 ? (
                    <div className="border-primary-700 flex min-h-24 items-center justify-center rounded-lg border border-dashed px-4 py-6">
                        <p className="text-primary-400 text-sm">No live messages yet.</p>
                    </div>
                ) : (
                    <div
                        ref={liveFeedContainerReference}
                        onScroll={handleFeedScroll}
                        className="h-[32rem] max-h-[60vh] overflow-y-auto pr-1 sm:h-96 sm:max-h-none"
                        style={{ overflowAnchor: "none" }}
                    >
                        {!isFeedAtBottom && feedRows.length > 0 ? (
                            <button
                                type="button"
                                onClick={scrollFeedToBottom}
                                className="bg-accent-500 hover:bg-accent-600 sticky top-2 z-10 float-right mr-2 mb-2 rounded-full px-3 py-1 text-xs text-white shadow-lg"
                            >
                                ↓ Follow
                            </button>
                        ) : null}

                        <div className="w-full">
                            {feedPaddingTop > 0 ? (
                                <div style={{ height: feedPaddingTop }} />
                            ) : null}
                            {feedVirtualItems.map((virtualItem) => {
                                const row = feedRows[virtualItem.index];

                                if (!row) return null;

                                return (
                                    <div
                                        key={row.key}
                                        ref={feedVirtualizer.measureElement}
                                        data-index={virtualItem.index}
                                        className="w-full"
                                    >
                                        {row.kind === "separator" ? (
                                            <div className="border-primary-700 text-primary-500 my-1 border-t pt-1 text-center text-[11px] tracking-wide uppercase">
                                                {row.label}
                                            </div>
                                        ) : (
                                            <div className="mb-2">
                                                <LiveFeedRow item={row.item} />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            {feedPaddingBottom > 0 ? (
                                <div style={{ height: feedPaddingBottom }} />
                            ) : null}
                        </div>
                    </div>
                )}
            </Card>

            <div className="mb-4 overflow-x-auto pb-1">
                <FilterButtonGroup
                    options={filterOptions}
                    value={typeFilter}
                    onChange={setTypeFilter}
                />
            </div>

            {error && <Alert variant="error">{error}</Alert>}
            {deleteError && <Alert variant="error">{deleteError}</Alert>}

            {!isConnected && !error && (
                <div className="py-8 text-center">
                    <WifiOff className="text-primary-400 mx-auto mb-4 h-12 w-12" />
                    <p className="text-primary-300">Connecting to OpenClaw...</p>
                </div>
            )}

            {isConnected && (
                <SessionsTable
                    sessions={filteredSessions}
                    onCompact={(sessionKey: string) => sessionActions.compact(sessionKey)}
                    onReset={(sessionKey: string) => sessionActions.reset(sessionKey)}
                    onDelete={setDeleteTarget}
                />
            )}

            <ConfirmModal
                isOpen={!!deleteTarget}
                title="Delete session"
                message={
                    deleteTarget
                        ? `Are you sure you want to delete ${deleteTarget.displayLabel || deleteTarget.key}?`
                        : "Are you sure you want to delete this session?"
                }
                confirmLabel="Delete"
                confirmLoadingLabel="Deleting..."
                loading={sessionActions.isDeleting}
                danger
                onCancel={() => setDeleteTarget(null)}
                onConfirm={() => {
                    void handleDeleteConfirm();
                }}
            />
        </div>
    );
}
