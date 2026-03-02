import { useEffect, useState, useRef } from "react";
import { useOpenClaw, type Session } from "../hooks/useOpenClaw";
import { useAuthStore } from "../stores/authStore";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import {
    Wifi,
    WifiOff,
    RefreshCw,
    Trash2,
    AlertTriangle,
    X,
    Play,
    Pause,
    MessageSquare,
    Clock,
    Cpu,
    Hash,
} from "lucide-react";

function formatDuration(updatedAt: number | null | undefined): string {
    if (!updatedAt) return "Unknown";
    const now = Date.now();
    const diffMs = now - updatedAt;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return diffDays + "d " + (diffHours % 24) + "h ago";
    if (diffHours > 0) return diffHours + "h " + (diffMins % 60) + "m ago";
    if (diffMins < 1) return "Just now";
    return diffMins + "m ago";
}

function formatTokens(current: number, max: number): string {
    return (current / 1000).toFixed(1) + "k / " + (max / 1000).toFixed(0) + "k";
}

function getTokenPercent(current: number, max: number): number {
    return Math.min(Math.round((current / max) * 100), 100);
}

function getTokenColor(percent: number): string {
    if (percent < 50) return "text-green-400";
    if (percent < 75) return "text-yellow-400";
    if (percent < 90) return "text-orange-400";
    return "text-red-400";
}

function getTokenBarColor(percent: number): string {
    if (percent < 50) return "bg-green-500";
    if (percent < 75) return "bg-yellow-500";
    if (percent < 90) return "bg-orange-500";
    return "bg-red-500";
}

function getTypeBadgeColor(type: string | null | undefined): string {
    const t = (type || "unknown").toUpperCase();
    switch (t) {
        case "MAIN": return "bg-blue-500/20 text-blue-400 border-blue-500/30";
        case "HOOK": return "bg-green-500/20 text-green-400 border-green-500/30";
        case "CRON": return "bg-purple-500/20 text-purple-400 border-purple-500/30";
        case "SUBAGENT": return "bg-orange-500/20 text-orange-400 border-orange-500/30";
        default: return "bg-slate-500/20 text-slate-400 border-slate-500/30";
    }
}

function formatSessionType(session: Session): string {
    const type = (session.type || "unknown").toUpperCase();
    if (type === "SUBAGENT" && session.agentType) return session.agentType.toUpperCase();
    return type;
}

function getTypeSortOrder(type: string | null | undefined): number {
    const t = (type || "unknown").toUpperCase();
    switch (t) {
        case "MAIN": return 0;
        case "SUBAGENT": return 1;
        case "HOOK": return 2;
        case "CRON": return 3;
        default: return 4;
    }
}

interface DeleteConfirmDialogProps {
    session: Session;
    onConfirm: () => void;
    onCancel: () => void;
    isLoading: boolean;
}

function DeleteConfirmDialog({ session, onConfirm, onCancel, isLoading }: DeleteConfirmDialogProps) {
    const displayName = session.displayLabel || session.label || session.displayName || session.id;
    const isMain = (session.type || "").toUpperCase() === "MAIN";
    
    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <Card className="max-w-md w-full mx-4 p-6">
                <div className="flex items-start gap-3">
                    <div className="p-2 bg-red-500/20 rounded-lg">
                        <AlertTriangle className="w-6 h-6 text-red-400" />
                    </div>
                    <div className="flex-1">
                        <h2 className="text-lg font-semibold text-slate-100 mb-2">Delete Session?</h2>
                        <p className="text-slate-300 text-sm mb-2">
                            Are you sure you want to delete this session?
                            <span className="block mt-1 text-slate-400 text-xs">{displayName}</span>
                        </p>
                        {isMain && (
                            <p className="text-yellow-400 text-xs mb-4">
                                This is a MAIN session. Deleting it will terminate the primary conversation.
                            </p>
                        )}
                        <div className="flex gap-2 justify-end">
                            <Button variant="secondary" onClick={onCancel} disabled={isLoading}>Cancel</Button>
                            <Button variant="danger" onClick={onConfirm} disabled={isLoading}>
                                {isLoading ? "Deleting..." : "Delete Session"}
                            </Button>
                        </div>
                    </div>
                </div>
            </Card>
        </div>
    );
}

interface SessionDetailsProps {
    session: Session;
    onClose: () => void;
    onDelete: () => void;
    onPause: () => void;
    onResume: () => void;
}

function SessionDetails({ session, onClose, onDelete, onPause, onResume }: SessionDetailsProps) {
    const [history, setHistory] = useState<Array<{ role: string; content: string; timestamp?: string }>>([]);
    const [loading, setLoading] = useState(true);
    const [visibleCount, setVisibleCount] = useState(50);
    const [totalCount, setTotalCount] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const fetchHistory = async () => {
        setLoading(true);
        setError(null);
        setVisibleCount(50);
        try {
            const res = await fetch("/api/sessions/" + encodeURIComponent(session.key) + "/history");
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || "Failed to fetch history");
            }
            const data = await res.json();
            setHistory(data.messages || []);
            setTotalCount(data.total || data.messages?.length || 0);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    };

    const isMain = (session.type || "").toUpperCase() === "MAIN";

    useEffect(() => {
        fetchHistory();
    }, [session.key]);

    const displayName = session.displayLabel || session.label || session.displayName || session.id;
    const sessionModel = session.model || "Unknown";
    const sessionTokens = session.tokenCount || 0;
    const sessionMaxTokens = session.maxTokens || 200000;
    const tokenPercent = getTokenPercent(sessionTokens, sessionMaxTokens);

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
            <Card className="max-w-3xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-slate-700 flex-shrink-0">
                    <div className="flex items-center gap-3 min-w-0">
                        <span className={"px-2 py-0.5 text-xs font-medium rounded border flex-shrink-0 " + getTypeBadgeColor(session.type)}>
                            {formatSessionType(session)}
                        </span>
                        <h2 className="text-lg font-semibold text-slate-100 truncate">{displayName}</h2>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                        {!isMain && (
                            <>
                                <Button variant="secondary" size="sm" onClick={onResume}>
                                    <Play className="w-4 h-4 mr-1" /> Resume
                                </Button>
                                <Button variant="secondary" size="sm" onClick={onPause}>
                                    <Pause className="w-4 h-4 mr-1" /> Pause
                                </Button>
                            </>
                        )}
                        <Button variant="ghost" size="sm" onClick={onDelete} className="text-red-400 hover:text-red-300">
                            <Trash2 className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={onClose}>
                            <X className="w-4 h-4" />
                        </Button>
                    </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 p-4 border-b border-slate-700 bg-slate-800/30 flex-shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-slate-700/50 rounded-lg">
                            <Cpu className="w-4 h-4 text-slate-400" />
                        </div>
                        <div>
                            <span className="text-xs text-slate-400 block">Model</span>
                            <p className="text-sm text-slate-200 font-medium truncate max-w-[150px]">{sessionModel}</p>
                        </div>
                    </div>
                    <div className="flex items-center justify-center gap-3">
                        <div className="p-2 bg-slate-700/50 rounded-lg">
                            <Hash className="w-4 h-4 text-slate-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <span className="text-xs text-slate-400 block">Tokens</span>
                            <div className="flex items-center gap-2">
                                <p className={"text-sm font-medium " + getTokenColor(tokenPercent)}>
                                    {formatTokens(sessionTokens, sessionMaxTokens)}
                                </p>
                                <div className="flex-1 h-1.5 bg-slate-700 rounded-full max-w-[100px]">
                                    <div className={"h-full rounded-full transition-all " + getTokenBarColor(tokenPercent)} style={{ width: tokenPercent + "%" }} />
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-3 justify-end">
                        <div className="p-2 bg-slate-700/50 rounded-lg">
                            <Clock className="w-4 h-4 text-slate-400" />
                        </div>
                        <div>
                            <span className="text-xs text-slate-400 block">Last Active</span>
                            <p className="text-sm text-slate-200 font-medium">{formatDuration(session.updatedAt)}</p>
                        </div>
                    </div>
                </div>

                {/* Message History */}
                <div className="flex-1 overflow-hidden flex flex-col min-h-0">
                    <div className="px-4 py-3 border-b border-slate-700 flex-shrink-0 flex items-center justify-between">
                        <h3 className="text-sm font-medium text-slate-300 flex items-center gap-2">
                            <MessageSquare className="w-4 h-4" /> Message History
                        </h3>
                        <Button variant="ghost" size="sm" onClick={fetchHistory} disabled={loading}>
                            <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
                        </Button>
                    </div>
                    <div className="flex-1 overflow-auto p-4">
                        {loading ? (
                            <div className="flex items-center justify-center py-8">
                                <RefreshCw className="w-5 h-5 animate-spin text-slate-400" />
                                <span className="ml-2 text-slate-400">Loading history...</span>
                            </div>
                        ) : error ? (
                            <div className="text-center py-8">
                                <AlertTriangle className="w-8 h-8 mx-auto text-yellow-400 mb-2" />
                                <p className="text-slate-400">{error}</p>
                            </div>
                        ) : history.length === 0 ? (
                            <div className="text-center py-8">
                                <MessageSquare className="w-8 h-8 mx-auto text-slate-500 mb-2" />
                                <p className="text-slate-400">No message history available</p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {[...history].reverse().slice(0, visibleCount).map((msg, i) => (
                                    <div 
                                        key={i} 
                                        className={"p-3 rounded-lg " + (msg.role === "user" ? "bg-blue-500/10 border border-blue-500/20" : "bg-slate-700/50 border border-slate-600/50")}
                                    >
                                        <div className="flex items-center justify-between mb-1">
                                            <span className={"text-xs font-medium uppercase " + (msg.role === "user" ? "text-blue-400" : "text-green-400")}>
                                                {msg.role}
                                            </span>
                                            {msg.timestamp && (
                                                <span className="text-xs text-slate-500">
                                                    {new Date(msg.timestamp).toLocaleString("no-NO", { 
                                                        day: "2-digit", 
                                                        month: "2-digit", year: "numeric",
                                                        hour: "2-digit", 
                                                        minute: "2-digit" 
                                                    })}
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-sm text-slate-200 whitespace-pre-wrap break-words">
                                            {msg.content?.slice(0, 500)}
                                            {msg.content?.length > 500 && "..."}
                                        </p>
                                    </div>
                                ))}
                                {history.length > visibleCount && (
                                    <div className="text-center">
                                        <Button variant="secondary" size="sm" onClick={() => setVisibleCount(c => c + 50)}>
                                            Load more ({visibleCount} of {history.length} messages)
                                        </Button>
                                    </div>
                                )}
                                {totalCount > history.length && (
                                    <p className="text-center text-slate-500 text-xs mt-2">
                                        {totalCount - history.length} older messages on server
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </Card>
        </div>
    );
}

const SESSION_TYPES = ["ALL", "MAIN", "SUBAGENT", "HOOK", "CRON"];

export function Sessions() {
    const { token } = useAuthStore();
    const { isConnected, error, connect, sessions, fetchSessions, deleteSession } = useOpenClaw(token);
    const hasConnected = useRef(false);
    const [isLoading, setIsLoading] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [selectedSession, setSelectedSession] = useState<Session | null>(null);
    const [typeFilter, setTypeFilter] = useState<string>("ALL");

    useEffect(() => {
        // Call fetchHistory defined above
        if (token && !hasConnected.current) {
            hasConnected.current = true;
            connect();
        }
    }, [token, connect]);

    useEffect(() => {
        // Call fetchHistory defined above
        if (isConnected) handleRefresh();
    }, [isConnected]);

    const handleRefresh = async () => {
        setIsLoading(true);
        try {
            await fetchSessions();
        } finally {
            setTimeout(() => setIsLoading(false), 300);
        }
    };

    const handleDeleteClick = (e: React.MouseEvent, session: Session) => {
        e.stopPropagation();
        setDeleteTarget(session);
        setSelectedSession(null);
    };

    const handleDeleteConfirm = async () => {
        if (!deleteTarget || !deleteTarget.key) return;
        setIsDeleting(true);
        try {
            await deleteSession(deleteTarget.key);
            setDeleteTarget(null);
        } catch (e) {
            console.error("Failed to delete session:", e);
        } finally {
            setIsDeleting(false);
        }
    };

    const handlePause = async (sessionKey: string) => {
        try {
            await fetch("/api/sessions/" + encodeURIComponent(sessionKey) + "/action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "pause" })
            });
        } catch (e) {
            console.error("Failed to pause session:", e);
        }
    };

    const handleResume = async (sessionKey: string) => {
        try {
            await fetch("/api/sessions/" + encodeURIComponent(sessionKey) + "/action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "resume" })
            });
        } catch (e) {
            console.error("Failed to resume session:", e);
        }
    };

    const sortedSessions = sessions ? [...sessions].sort((a, b) => {
        const typeOrder = getTypeSortOrder(a.type) - getTypeSortOrder(b.type);
        if (typeOrder !== 0) return typeOrder;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    }) : [];

    const filteredSessions = typeFilter === "ALL" 
        ? sortedSessions 
        : sortedSessions.filter(s => (s.type || "").toUpperCase() === typeFilter);

    return (
        <div className="p-6">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-2xl font-bold">Sessions</h1>
                <div className="flex items-center gap-4">
                    <Button variant="secondary" size="sm" onClick={handleRefresh} disabled={!isConnected || isLoading}>
                        <RefreshCw className={"w-4 h-4 mr-2 " + (isLoading ? "animate-spin" : "")} />
                        Refresh
                    </Button>
                    <div className="flex items-center gap-2">
                        {isConnected ? (
                            <span className="flex items-center gap-1 text-green-400 text-sm">
                                <Wifi size={16} /> Connected
                            </span>
                        ) : (
                            <span className="flex items-center gap-1 text-red-400 text-sm">
                                <WifiOff size={16} /> Disconnected
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Type filter buttons */}
            <div className="flex gap-2 mb-4">
                {SESSION_TYPES.map(type => (
                    <Button
                        key={type}
                        variant={typeFilter === type ? "primary" : "secondary"}
                        size="sm"
                        onClick={() => setTypeFilter(type)}
                    >
                        {type}
                    </Button>
                ))}
            </div>

            {error && (
                <div className="bg-red-500/20 border border-red-500 text-red-400 p-3 rounded-lg mb-4">{error}</div>
            )}

            {!isConnected && !error && (
                <Card className="text-center py-8">
                    <WifiOff className="w-12 h-12 mx-auto text-slate-400 mb-4" />
                    <p className="text-slate-300">Connecting to OpenClaw...</p>
                </Card>
            )}

            {isConnected && (
                <>
                    {filteredSessions.length > 0 ? (
                        <Card className="overflow-hidden">
                            <table className="w-full">
                                <thead className="bg-slate-800/50">
                                    <tr>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase">Type</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase">Name</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase">Model</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase">Tokens</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase">Last Active</th>
                                        <th className="px-4 py-3 text-right text-xs font-medium text-slate-400 uppercase">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-700">
                                    {filteredSessions.map((session, index) => {
                                        const tokenPercent = getTokenPercent(session.tokenCount || 0, session.maxTokens || 200000);
                                        return (
                                            <tr 
                                                key={session.id || session.key || index} 
                                                className="hover:bg-slate-800/50 cursor-pointer"
                                                onClick={() => setSelectedSession(session)}
                                            >
                                                <td className="px-4 py-3">
                                                    <span className={"px-2 py-0.5 text-xs font-medium rounded border " + getTypeBadgeColor(session.type)}>
                                                        {formatSessionType(session)}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3 text-sm text-slate-200 truncate max-w-xs">
                                                    {session.displayLabel || session.label || session.displayName || (session.id || "unknown").slice(0, 12)}
                                                </td>
                                                <td className="px-4 py-3 text-sm text-slate-300">{session.model || "Unknown"}</td>
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center gap-2">
                                                        <span className={"text-sm " + getTokenColor(tokenPercent)}>
                                                            {formatTokens(session.tokenCount || 0, session.maxTokens || 200000)}
                                                        </span>
                                                        <div className="w-16 h-1 bg-slate-700 rounded-full">
                                                            <div className={"h-full rounded-full " + getTokenBarColor(tokenPercent)} style={{ width: tokenPercent + "%" }} />
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 text-sm text-slate-400">{formatDuration(session.updatedAt)}</td>
                                                <td className="px-4 py-3 text-right">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={(e) => handleDeleteClick(e, session)}
                                                        className="text-red-400 hover:text-red-300"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </Button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </Card>
                    ) : (
                        <Card className="text-center py-12">
                            <div className="text-4xl mb-4">?</div>
                            <p className="text-slate-300 text-lg mb-1">No Active Sessions</p>
                            <p className="text-slate-400 text-sm">There are no active OpenClaw sessions at the moment.</p>
                        </Card>
                    )}
                </>
            )}

            {selectedSession && (
                <SessionDetails
                    session={selectedSession}
                    onClose={() => setSelectedSession(null)}
                    onDelete={() => {
                        setDeleteTarget(selectedSession);
                        setSelectedSession(null);
                    }}
                    onPause={() => handlePause(selectedSession.key)}
                    onResume={() => handleResume(selectedSession.key)}
                />
            )}

            {deleteTarget && (
                <DeleteConfirmDialog
                    session={deleteTarget}
                    onConfirm={handleDeleteConfirm}
                    onCancel={() => setDeleteTarget(null)}
                    isLoading={isDeleting}
                />
            )}
        </div>
    );
}
