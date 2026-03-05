import { useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import { WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

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
import { ConnectionStatus } from "../components/ui/ConnectionStatus";
import { FilterButtonGroup } from "../components/ui/FilterButtonGroup";
import { PageHeader } from "../components/ui/PageHeader";
import { RefreshButton } from "../components/ui/RefreshButton";
import { Select } from "../components/ui/Select";
import { type FeedItem, useLiveFeed } from "../hooks";
import { AUTO_REFRESH_MS } from "../lib/queryClient";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { useSessionActions } from "../hooks/useSessionActions";
import { type Session } from "../types/session";
import { sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

export function Sessions() {
    const { isConnected, error, request } = useOpenClawSocket();
    const sessionActions = useSessionActions();
    const [isLoading, setIsLoading] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
    const [selectedSession, setSelectedSession] = useState<Session | null>(null);
    const [typeFilter, setTypeFilter] = useState<string>("ALL");
    const [feedRoleFilter, setFeedRoleFilter] = useState<string>("ALL");
    const [feedSessionFilter, setFeedSessionFilter] = useState<string>("ALL");
    const [feedTypeFilter, setFeedTypeFilter] = useState<string>("ALL");
    const [liveFeed, setLiveFeed] = useState<FeedItem[]>([]);
    const liveFeedContainerReference = useRef<HTMLDivElement | null>(null);

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
        if (!latestFeedItems.length) return;

        setLiveFeed((prev) => {
            const seen = new Set(prev.map((item) => item.id));
            const next = [...prev];

            for (const item of latestFeedItems) {
                if (!seen.has(item.id)) {
                    next.unshift(item);
                    seen.add(item.id);
                }
            }

            return next.sort((a, b) => b.timestamp - a.timestamp).slice(0, 120);
        });
    }, [latestFeedItems]);

    const filteredFeed = liveFeed.filter((item) => {
        if (feedRoleFilter !== "ALL" && item.role !== feedRoleFilter) return false;
        if (feedSessionFilter !== "ALL" && item.sessionKey !== feedSessionFilter) return false;
        if (feedTypeFilter !== "ALL" && item.sessionType !== feedTypeFilter) return false;
        return true;
    });

    const feedRows = useMemo(() => {
        const rows: Array<
            | { kind: "separator"; key: string; label: string }
            | { kind: "message"; key: string; item: FeedItem }
        > = [];

        let previousBucket = "";

        for (const item of filteredFeed) {
            const bucket = new Date(item.timestamp).toISOString().slice(0, 16);

            if (bucket !== previousBucket) {
                const label = new Date(item.timestamp).toLocaleString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                    day: "2-digit",
                    month: "short",
                });

                rows.push({ kind: "separator", key: `sep-${bucket}`, label });
                previousBucket = bucket;
            }

            rows.push({ kind: "message", key: item.id, item });
        }

        return rows;
    }, [filteredFeed]);

    const feedVirtualizer = useVirtualizer({
        count: feedRows.length,
        getScrollElement: () => liveFeedContainerReference.current,
        estimateSize: (index) => (feedRows[index]?.kind === "separator" ? 28 : 108),
        overscan: 8,
    });

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

    const handleRefresh = async () => {
        setIsLoading(true);
        try {
            await request("sessions.list", {});
        } finally {
            setTimeout(() => setIsLoading(false), 300);
        }
    };

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
            <PageHeader
                title="Agents"
                actions={
                    <RefreshButton
                        onClick={handleRefresh}
                        isLoading={isLoading}
                        disabled={!isConnected}
                    />
                }
                status={<ConnectionStatus isConnected={isConnected} />}
            />

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
                    <div ref={liveFeedContainerReference} className="max-h-96 overflow-y-auto pr-1">
                        <div
                            className="relative w-full"
                            style={{ height: `${feedVirtualizer.getTotalSize()}px` }}
                        >
                            {feedVirtualizer.getVirtualItems().map((virtualItem) => {
                                const row = feedRows[virtualItem.index];

                                if (!row) return null;

                                return (
                                    <div
                                        key={row.key}
                                        className="absolute left-0 top-0 w-full"
                                        style={{ transform: `translateY(${virtualItem.start}px)` }}
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
                    onStop={(sessionKey: string) => sessionActions.stop(sessionKey)}
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
                onStop={() => {
                    if (selectedSession) {
                        sessionActions.stop(selectedSession.key);
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
