import { useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bell, BellRing, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { sessionsCollection } from "../collections/sessions";
import {
    LiveFeedRow,
    SESSION_TYPES,
    SessionDetails,
    SessionsTable,
} from "../components/features/sessions";
import { Alert } from "../components/ui/Alert";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { ConnectionStatus } from "../components/ui/ConnectionStatus";
import { FilterButtonGroup } from "../components/ui/FilterButtonGroup";
import { PageHeader } from "../components/ui/PageHeader";
import { RefreshButton } from "../components/ui/RefreshButton";
import { Select } from "../components/ui/Select";
import { hasQuotaStatus, type FeedItem, useLiveFeed, useQuotas } from "../hooks";
import { AUTO_REFRESH_MS } from "../lib/queryClient";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { useSessionActions } from "../hooks/useSessionActions";
import { type Session } from "../types/session";
import { formatDate } from "../utils/format";
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
    const [isNotificationOpen, setIsNotificationOpen] = useState(false);
    const [readNotificationIds, setReadNotificationIds] = useState<string[]>([]);
    const liveFeedContainerReference = useRef<HTMLDivElement | null>(null);
    const notificationsInitializedReference = useRef(false);

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
    const { data: quotas } = useQuotas(isConnected ? AUTO_REFRESH_MS : false);

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

            return next.sort((a, b) => b.timestamp - a.timestamp).slice(0, 500);
        });
    }, [latestFeedItems]);

    const filteredFeed = liveFeed.filter((item) => {
        if (feedRoleFilter !== "ALL" && item.role !== feedRoleFilter) return false;
        if (feedSessionFilter !== "ALL" && item.sessionKey !== feedSessionFilter) return false;
        if (feedTypeFilter !== "ALL" && item.sessionType !== feedTypeFilter) return false;
        return true;
    });

    const notifications: Array<{
        id: string;
        title: string;
        description: string;
        timestamp: number;
        type: "alert" | "info";
    }> = [];

    if (quotas) {
        if (!hasQuotaStatus(quotas.openrouter) && (quotas.openrouter.percentUsed || 0) >= 80) {
            notifications.push({
                id: `quota-openrouter-${quotas.checkedAt}`,
                title: "OpenRouter usage high",
                description: `${quotas.openrouter.percentUsed}% used ($${quotas.openrouter.remaining.toFixed(2)} remaining)`,
                timestamp: quotas.checkedAt,
                type: "alert",
            });
        }

        if (!hasQuotaStatus(quotas.elevenlabs) && (quotas.elevenlabs.percentUsed || 0) >= 80) {
            notifications.push({
                id: `quota-elevenlabs-${quotas.checkedAt}`,
                title: "ElevenLabs usage high",
                description: `${quotas.elevenlabs.percentUsed}% used (${quotas.elevenlabs.remaining.toLocaleString()} chars remaining)`,
                timestamp: quotas.checkedAt,
                type: "alert",
            });
        }

        if (!hasQuotaStatus(quotas.zai)) {
            const highestZai = Math.max(
                quotas.zai.fiveHour.usedPercentage,
                quotas.zai.weekly.usedPercentage
            );
            if (highestZai >= 80) {
                notifications.push({
                    id: `quota-zai-${quotas.checkedAt}`,
                    title: "Z.ai usage high",
                    description: `5h ${quotas.zai.fiveHour.usedPercentage}% · weekly ${quotas.zai.weekly.usedPercentage}%`,
                    timestamp: quotas.checkedAt,
                    type: "alert",
                });
            }
        }

        if (!hasQuotaStatus(quotas.openai) && (quotas.openai.percentUsed || 0) >= 80) {
            notifications.push({
                id: `quota-openai-${quotas.checkedAt}`,
                title: "OpenAI usage high",
                description: `${quotas.openai.percentUsed}% of hard limit used`,
                timestamp: quotas.checkedAt,
                type: "alert",
            });
        }
    }

    for (const item of liveFeed.slice(0, 24)) {
        notifications.push({
            id: `feed-${item.id}`,
            title: `${item.sessionLabel} · ${item.role}`,
            description: item.content,
            timestamp: item.timestamp,
            type: "info",
        });
    }

    notifications.sort((a, b) => b.timestamp - a.timestamp);

    useEffect(() => {
        if (notificationsInitializedReference.current) return;
        if (notifications.length === 0) return;

        setReadNotificationIds(notifications.map((notification) => notification.id));
        notificationsInitializedReference.current = true;
    }, [notifications]);

    const unreadNotificationCount = notifications.filter(
        (notification) => !readNotificationIds.includes(notification.id)
    ).length;

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

    useEffect(() => {
        feedVirtualizer.measure();
    }, [feedRows.length, feedVirtualizer]);

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

    const markAllNotificationsAsRead = () => {
        setReadNotificationIds(notifications.map((notification) => notification.id));
    };

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
                <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                        Notifications
                    </h2>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setIsNotificationOpen((prev) => !prev)}
                            className="relative"
                        >
                            {unreadNotificationCount > 0 ? (
                                <BellRing className="h-4 w-4" />
                            ) : (
                                <Bell className="h-4 w-4" />
                            )}
                            <span className="ml-1">{unreadNotificationCount}</span>
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={markAllNotificationsAsRead}
                            disabled={notifications.length === 0}
                        >
                            Mark all read
                        </Button>
                    </div>
                </div>

                {isNotificationOpen && (
                    <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-primary-700 bg-primary-900/30 p-2">
                        {notifications.length === 0 ? (
                            <p className="text-sm text-primary-400">No notifications yet.</p>
                        ) : (
                            notifications.map((notification) => {
                                const isRead = readNotificationIds.includes(notification.id);
                                return (
                                    <button
                                        key={notification.id}
                                        type="button"
                                        onClick={() => {
                                            if (!isRead) {
                                                setReadNotificationIds((previous) => [
                                                    ...previous,
                                                    notification.id,
                                                ]);
                                            }
                                        }}
                                        className="w-full rounded-lg border border-primary-700 bg-primary-800/40 px-3 py-2 text-left data-[read=false]:border-primary-500/50"
                                        data-read={isRead}
                                    >
                                        <div className="mb-1 flex items-center justify-between gap-2">
                                            <div className="inline-flex items-center gap-2">
                                                <Badge variant={notification.type === "alert" ? "warning" : "info"}>
                                                    {notification.type === "alert" ? "alert" : "feed"}
                                                </Badge>
                                                {!isRead && <Badge variant="success">unread</Badge>}
                                                {isRead && <Badge variant="default">read</Badge>}
                                            </div>
                                            <span className="text-xs text-primary-500">
                                                {formatDate(new Date(notification.timestamp))}
                                            </span>
                                        </div>
                                        <div className="text-sm text-primary-100">{notification.title}</div>
                                        <div className="line-clamp-2 text-xs text-primary-300">
                                            {notification.description}
                                        </div>
                                    </button>
                                );
                            })
                        )}
                    </div>
                )}
            </Card>

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
                                        ref={feedVirtualizer.measureElement}
                                        data-index={virtualItem.index}
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
