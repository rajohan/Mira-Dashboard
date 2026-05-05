import { useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import { WifiOff } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { sessionsCollection } from "../collections/sessions";
import {
    LiveFeedRow,
    SESSION_TYPES,
    SessionDetails,
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

export function Sessions() {
    const { isConnected, error } = useOpenClawSocket();
    const sessionActions = useSessionActions();
    const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
    const [selectedSession, setSelectedSession] = useState<Session | null>(null);
    const [typeFilter, setTypeFilter] = useState<string>("ALL");
    const [feedRoleFilter, setFeedRoleFilter] = useState<string>("ALL");
    const [feedSessionFilter, setFeedSessionFilter] = useState<string>("ALL");
    const [feedTypeFilter, setFeedTypeFilter] = useState<string>("ALL");
    const [liveFeed, setLiveFeed] = useState<FeedItem[]>([]);
    const liveFeedContainerReference = useRef<HTMLDivElement | null>(null);
    const shouldStickFeedToBottomReference = useRef(true);

    const { data: sessions = [] } = useLiveQuery((q) =>
        q.from({ session: sessionsCollection })
    );

    const sortedSessions = sortSessionsByTypeAndActivity(sessions || []);
    const filteredSessions =
        typeFilter === "ALL"
            ? sortedSessions
            : sortedSessions.filter((s) => (s.type || "").toUpperCase() === typeFilter);

    const { data: latestFeedItems = [] } = useLiveFeed(
        sortedSessions,
        isConnected ? AUTO_REFRESH_MS : false
    );

    useEffect(() => {
        if (latestFeedItems.length === 0) return;

        setLiveFeed((prev) => {
            const seen = new Set(prev.map((item) => item.id));
            const next = [...prev];

            for (const item of latestFeedItems) {
                if (!seen.has(item.id)) {
                    next.push(item);
                    seen.add(item.id);
                }
            }

            return next.sort((a, b) => a.timestamp - b.timestamp).slice(-500);
        });
    }, [latestFeedItems]);

    const filteredFeed = liveFeed.filter((item) => {
        if (feedRoleFilter !== "ALL" && item.role !== feedRoleFilter) return false;
        if (feedSessionFilter !== "ALL" && item.sessionKey !== feedSessionFilter)
            return false;
        if (feedTypeFilter !== "ALL" && item.sessionType !== feedTypeFilter) return false;
        return true;
    });

    const feedRows: Array<
        | { kind: "separator"; key: string; label: string }
        | { kind: "message"; key: string; item: FeedItem }
    > = [];

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
        estimateSize: (index) => (feedRows[index]?.kind === "separator" ? 28 : 88),
        measureElement: (element) => element.getBoundingClientRect().height,
        overscan: 8,
    });

    const feedVirtualItems = feedVirtualizer.getVirtualItems();
    const firstFeedVirtualItem = feedVirtualItems[0];
    const lastFeedVirtualItem = feedVirtualItems.at(-1);
    const feedPaddingTop = firstFeedVirtualItem?.start ?? 0;
    const feedPaddingBottom = lastFeedVirtualItem
        ? Math.max(feedVirtualizer.getTotalSize() - lastFeedVirtualItem.end, 0)
        : 0;

    const checkFeedIsAtBottom = () => {
        const container = liveFeedContainerReference.current;

        if (!container) {
            return true;
        }

        return (
            container.scrollHeight - container.scrollTop - container.clientHeight < 120
        );
    };

    const scrollFeedToBottom = () => {
        const container = liveFeedContainerReference.current;
        if (!container || feedRows.length === 0) {
            return;
        }

        feedVirtualizer.scrollToIndex(feedRows.length - 1, { align: "end" });
        container.scrollTo({ top: container.scrollHeight });
    };

    const handleFeedScroll = () => {
        shouldStickFeedToBottomReference.current = checkFeedIsAtBottom();
    };

    useLayoutEffect(() => {
        feedVirtualizer.measure();
    }, [feedRows.length, feedVirtualizer]);

    useLayoutEffect(() => {
        if (feedRows.length === 0 || !shouldStickFeedToBottomReference.current) {
            return;
        }

        scrollFeedToBottom();

        const firstFrame = requestAnimationFrame(() => {
            feedVirtualizer.measure();
            scrollFeedToBottom();
        });
        const delayedScroll = window.setTimeout(() => {
            feedVirtualizer.measure();
            scrollFeedToBottom();
        }, 100);

        return () => {
            cancelAnimationFrame(firstFrame);
            window.clearTimeout(delayedScroll);
        };
    }, [
        feedRows.length,
        feedVirtualizer,
        feedRoleFilter,
        feedSessionFilter,
        feedTypeFilter,
    ]);

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

    const handleDeleteConfirm = async () => {
        if (!deleteTarget || !deleteTarget.key) return;
        try {
            await sessionActions.remove(deleteTarget.key);
            setDeleteTarget(null);
        } catch (error_) {
            console.error("Failed to delete session:", error_);
        }
    };

    const filterOptions = SESSION_TYPES.map((type) => ({ value: type, label: type }));

    return (
        <div className="p-6">
            <Card className="mb-4">
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                        Live Feed (cross-session)
                    </h2>
                    <span className="text-xs text-primary-400">Auto-refresh: 5s</span>
                </div>

                <div className="mb-3 flex flex-wrap gap-2">
                    <Select
                        value={feedRoleFilter}
                        onChange={setFeedRoleFilter}
                        options={feedRoleOptions}
                        width="min-w-[150px]"
                    />
                    <Select
                        value={feedTypeFilter}
                        onChange={setFeedTypeFilter}
                        options={feedTypeOptions}
                        width="min-w-[150px]"
                    />
                    <Select
                        value={feedSessionFilter}
                        onChange={setFeedSessionFilter}
                        options={feedSessionOptions}
                        width="min-w-[280px]"
                    />
                </div>

                {filteredFeed.length === 0 ? (
                    <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-primary-700 bg-primary-900/30 px-4 py-6">
                        <p className="text-sm text-primary-400">No live messages yet.</p>
                    </div>
                ) : (
                    <div
                        ref={liveFeedContainerReference}
                        onScroll={handleFeedScroll}
                        className="h-96 overflow-y-auto pr-1"
                    >
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
                                            <div className="my-1 border-t border-primary-700 pt-1 text-center text-[11px] uppercase tracking-wide text-primary-500">
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

            <div className="mb-4">
                <FilterButtonGroup
                    options={filterOptions}
                    value={typeFilter}
                    onChange={setTypeFilter}
                />
            </div>

            {error && <Alert variant="error">{error}</Alert>}

            {!isConnected && !error && (
                <div className="py-8 text-center">
                    <WifiOff className="mx-auto mb-4 h-12 w-12 text-primary-400" />
                    <p className="text-primary-300">Connecting to OpenClaw...</p>
                </div>
            )}

            {isConnected && (
                <SessionsTable
                    sessions={filteredSessions}
                    onSelectSession={setSelectedSession}
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
                confirmLabel={sessionActions.isDeleting ? "Deleting..." : "Delete"}
                danger
                onCancel={() => setDeleteTarget(null)}
                onConfirm={() => {
                    void handleDeleteConfirm();
                }}
            />

            <SessionDetails
                session={selectedSession}
                onClose={() => setSelectedSession(null)}
                onDelete={() => {
                    if (selectedSession) {
                        setDeleteTarget(selectedSession);
                        setSelectedSession(null);
                    }
                }}
                onCompact={() => {
                    if (selectedSession) {
                        sessionActions.compact(selectedSession.key);
                        setSelectedSession(null);
                    }
                }}
                onReset={() => {
                    if (selectedSession) {
                        sessionActions.reset(selectedSession.key);
                        setSelectedSession(null);
                    }
                }}
            />
        </div>
    );
}
