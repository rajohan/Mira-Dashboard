import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { WifiOff } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

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
import { apiFetch } from "../hooks";
import { AUTO_REFRESH_MS } from "../lib/queryClient";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { useSessionActions } from "../hooks/useSessionActions";
import { type Session } from "../types/session";
import { formatOsloTime } from "../utils/format";
import { sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

interface SessionHistoryResponse {
    messages: Array<{ role: string; content: string; timestamp?: string }>;
}

interface FeedItem {
    id: string;
    sessionKey: string;
    sessionLabel: string;
    sessionType: string;
    role: string;
    content: string;
    timestamp: number;
}

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

const FeedRow = memo(function FeedRow({ item }: { item: FeedItem }) {
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

    const sessionByKey = useMemo(
        () => new Map(sortedSessions.map((s) => [s.key, s] as const)),
        [sortedSessions]
    );

    const feedSessionCandidates = useMemo(() => sortedSessions.slice(0, 8), [sortedSessions]);

    const { data: feedItems = [] } = useQuery({
        queryKey: [
            "live-feed",
            feedSessionCandidates.map((s) => s.key).join("|"),
            feedSessionCandidates.map((s) => s.updatedAt || 0).join("|"),
        ],
        enabled: isConnected && feedSessionCandidates.length > 0,
        refetchInterval: AUTO_REFRESH_MS,
        staleTime: 2_000,
        queryFn: async () => {
            const historyBySession = await Promise.all(
                feedSessionCandidates.map(async (session) => {
                    const history = await apiFetch<SessionHistoryResponse>(
                        `/sessions/${encodeURIComponent(session.key)}/history?limit=8&offset=0`
                    );

                    return history.messages.map((message, index) => {
                        const fallbackTimestamp = session.updatedAt || Date.now();
                        const parsedTimestamp = message.timestamp
                            ? new Date(message.timestamp).getTime()
                            : fallbackTimestamp;

                        return {
                            id: `${session.key}-${index}-${parsedTimestamp}`,
                            sessionKey: session.key,
                            sessionLabel:
                                session.displayLabel || session.displayName || session.key,
                            sessionType: (session.type || "unknown").toUpperCase(),
                            role: (message.role || "unknown").toLowerCase(),
                            content: (message.content || "").trim(),
                            timestamp: Number.isFinite(parsedTimestamp)
                                ? parsedTimestamp
                                : fallbackTimestamp,
                        } as FeedItem;
                    });
                })
            );

            return historyBySession
                .flat()
                .filter((item) => item.content.length > 0)
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 60);
        },
    });

    useEffect(() => {
        if (!feedItems.length) return;

        setLiveFeed((prev) => {
            const seen = new Set(prev.map((item) => item.id));
            const next = [...prev];

            for (const item of feedItems) {
                if (!seen.has(item.id)) {
                    next.unshift(item);
                    seen.add(item.id);
                }
            }

            return next.sort((a, b) => b.timestamp - a.timestamp).slice(0, 120);
        });
    }, [feedItems]);

    const filteredFeed = useMemo(() => {
        return liveFeed.filter((item) => {
            if (feedRoleFilter !== "ALL" && item.role !== feedRoleFilter) return false;
            if (feedSessionFilter !== "ALL" && item.sessionKey !== feedSessionFilter) return false;
            if (feedTypeFilter !== "ALL" && item.sessionType !== feedTypeFilter) return false;
            return true;
        });
    }, [liveFeed, feedRoleFilter, feedSessionFilter, feedTypeFilter]);

    const feedSessionOptions = useMemo(
        () =>
            sortedSessions.slice(0, 20).map((session) => ({
                value: session.key,
                label: session.displayLabel || session.displayName || session.key,
            })),
        [sortedSessions]
    );

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

    const handleStop = (sessionKey: string) => sessionActions.stop(sessionKey);
    const handleCompact = (sessionKey: string) => sessionActions.compact(sessionKey);
    const handleReset = (sessionKey: string) => sessionActions.reset(sessionKey);

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

                <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-3">
                    <select
                        value={feedRoleFilter}
                        onChange={(e) => setFeedRoleFilter(e.target.value)}
                        className="rounded-lg border border-primary-700 bg-primary-900 px-3 py-2 text-sm text-primary-100"
                    >
                        <option value="ALL">All roles</option>
                        <option value="assistant">assistant</option>
                        <option value="user">user</option>
                        <option value="system">system</option>
                    </select>
                    <select
                        value={feedTypeFilter}
                        onChange={(e) => setFeedTypeFilter(e.target.value)}
                        className="rounded-lg border border-primary-700 bg-primary-900 px-3 py-2 text-sm text-primary-100"
                    >
                        <option value="ALL">All types</option>
                        {SESSION_TYPES.filter((t) => t !== "ALL").map((type) => (
                            <option key={type} value={type}>
                                {type}
                            </option>
                        ))}
                    </select>
                    <select
                        value={feedSessionFilter}
                        onChange={(e) => setFeedSessionFilter(e.target.value)}
                        className="rounded-lg border border-primary-700 bg-primary-900 px-3 py-2 text-sm text-primary-100"
                    >
                        <option value="ALL">All sessions</option>
                        {feedSessionOptions.map((session) => (
                            <option key={session.value} value={session.value}>
                                {session.label}
                            </option>
                        ))}
                    </select>
                </div>

                {filteredFeed.length === 0 ? (
                    <p className="text-sm text-primary-400">No live messages yet.</p>
                ) : (
                    <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
                        {filteredFeed.map((item) => (
                            <FeedRow
                                key={item.id}
                                item={{
                                    ...item,
                                    sessionType:
                                        (sessionByKey.get(item.sessionKey)?.type || item.sessionType).toUpperCase(),
                                }}
                            />
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
                    onStop={handleStop}
                    onCompact={handleCompact}
                    onReset={handleReset}
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
                        handleStop(selectedSession.key);
                        setSelectedSession(null);
                    }
                }}
                onCompact={() => {
                    if (selectedSession) {
                        handleCompact(selectedSession.key);
                        setSelectedSession(null);
                    }
                }}
                onReset={() => {
                    if (selectedSession) {
                        handleReset(selectedSession.key);
                        setSelectedSession(null);
                    }
                }}
            />
        </div>
    );
}
