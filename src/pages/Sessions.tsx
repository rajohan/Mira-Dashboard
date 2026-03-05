import { useLiveQuery } from "@tanstack/react-db";
import { WifiOff } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { sessionsCollection } from "../collections/sessions";
import {
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
import { formatOsloTime } from "../utils/format";
import { sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

function roleBadgeColor(role: string) {
    switch (role.toLowerCase()) {
        case "user":
            return "text-blue-300 border-blue-500/30 bg-blue-500/10";
        case "assistant":
            return "text-emerald-300 border-emerald-500/30 bg-emerald-500/10";
        case "system":
            return "text-amber-300 border-amber-500/30 bg-amber-500/10";
        default:
            return "text-primary-300 border-primary-600 bg-primary-800/40";
    }
}

const FeedRow = memo(function FeedRow({
    item,
}: {
    item: {
        id: string;
        sessionLabel: string;
        sessionType: string;
        role: string;
        content: string;
        timestamp: number;
    };
}) {
    return (
        <div className="rounded-lg border border-primary-700 bg-primary-800/40 p-3">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-primary-300">{item.sessionLabel}</span>
                <span className="text-primary-500">{formatOsloTime(new Date(item.timestamp))}</span>
            </div>
            <div className="mb-2 flex items-center gap-2">
                <span
                    className={`inline-flex rounded border px-2 py-0.5 text-[11px] font-medium ${roleBadgeColor(item.role)}`}
                >
                    {item.role}
                </span>
                <span className="inline-flex rounded border border-primary-700 px-2 py-0.5 text-[11px] text-primary-300">
                    {item.sessionType || "unknown"}
                </span>
            </div>
            <p className="line-clamp-3 text-sm text-primary-100">{item.content}</p>
        </div>
    );
});

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

    const feedRoleOptions = [
        { value: "ALL", label: "All roles" },
        { value: "assistant", label: "assistant" },
        { value: "user", label: "user" },
        { value: "system", label: "system" },
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
                    <p className="text-sm text-primary-400">No live messages yet.</p>
                ) : (
                    <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
                        {filteredFeed.map((item) => (
                            <FeedRow key={item.id} item={item} />
                        ))}
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
