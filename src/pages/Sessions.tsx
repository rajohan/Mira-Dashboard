import { useEffect, useState, useRef } from "react";
import { useOpenClaw, type Session } from "../hooks/useOpenClaw";
import { useAuthStore } from "../stores/authStore";
import { Card, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import {
    Wifi,
    WifiOff,
    RefreshCw,
    Trash2,
    Clock,
    Cpu,
    Coins,
    AlertTriangle,
} from "lucide-react";

function formatDuration(updatedAt: number | null | undefined): string {
    if (!updatedAt) return "Unknown";
    const now = Date.now();
    const diffMs = now - updatedAt;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
        return diffDays + "d " + (diffHours % 24) + "h ago";
    }
    if (diffHours > 0) {
        return diffHours + "h " + (diffMins % 60) + "m ago";
    }
    if (diffMins < 1) return "Just now";
    return diffMins + "m ago";
}

function formatTokens(current: number, max: number): string {
    const currentK = (current / 1000).toFixed(1);
    const maxK = (max / 1000).toFixed(0);
    return currentK + "k / " + maxK + "k";
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
        case "MAIN":
            return "bg-blue-500/20 text-blue-400 border-blue-500/30";
        case "HOOK":
            return "bg-green-500/20 text-green-400 border-green-500/30";
        case "CRON":
            return "bg-purple-500/20 text-purple-400 border-purple-500/30";
        case "SUBAGENT":
            return "bg-orange-500/20 text-orange-400 border-orange-500/30";
        default:
            return "bg-slate-500/20 text-slate-400 border-slate-500/30";
    }
}

function formatSessionType(session: Session): string {
    const type = (session.type || "unknown").toUpperCase();
    if (type === "SUBAGENT" && session.agentType) {
        return session.agentType.toUpperCase();
    }
    return type;
}

// Sort sessions by type: MAIN first, then SUBAGENT, HOOK, CRON, others
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

function sortSessions(sessions: Session[]): Session[] {
    return [...sessions].sort((a, b) => {
        const typeOrder = getTypeSortOrder(a.type) - getTypeSortOrder(b.type);
        if (typeOrder !== 0) return typeOrder;
        // Secondary sort by updatedAt (newest first)
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
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
            <Card variant="bordered" className="max-w-md w-full mx-4">
                <div className="flex items-start gap-3">
                    <div className="p-2 bg-red-500/20 rounded-lg">
                        <AlertTriangle className="w-6 h-6 text-red-400" />
                    </div>
                    <div className="flex-1">
                        <CardTitle className="mb-2">Delete Session?</CardTitle>
                        <p className="text-slate-300 text-sm mb-2">
                            Are you sure you want to delete this session?
                            <span className="block mt-1 text-slate-400 text-xs">
                                {displayName}
                            </span>
                        </p>
                        {isMain && (
                            <p className="text-yellow-400 text-xs mb-4">
                                ⚠️ This is a MAIN session. Deleting it will terminate the primary conversation.
                            </p>
                        )}
                        <div className="flex gap-2 justify-end">
                            <Button variant="secondary" onClick={onCancel} disabled={isLoading}>
                                Cancel
                            </Button>
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

export function Sessions() {
    const { token } = useAuthStore();
    const { isConnected, error, connect, sessions, fetchSessions, deleteSession } = useOpenClaw(token);
    const hasConnected = useRef(false);
    const [isLoading, setIsLoading] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    useEffect(() => {
        if (token && !hasConnected.current) {
            hasConnected.current = true;
            connect();
        }
    }, [token, connect]);

    useEffect(() => {
        if (isConnected) {
            handleRefresh();
        }
    }, [isConnected]);

    const handleRefresh = async () => {
        setIsLoading(true);
        try {
            await fetchSessions();
        } finally {
            setTimeout(() => setIsLoading(false), 300);
        }
    };

    const handleDeleteClick = (session: Session) => {
        setDeleteTarget(session);
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

    const handleDeleteCancel = () => {
        setDeleteTarget(null);
    };

    const sortedSessions = sessions ? sortSessions(sessions) : [];

    return (
        <div className="p-6">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-2xl font-bold">Sessions</h1>
                <div className="flex items-center gap-4">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleRefresh}
                        disabled={!isConnected || isLoading}
                    >
                        <RefreshCw className={"w-4 h-4 mr-2" + (isLoading ? " animate-spin" : "")} />
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

            {error && (
                <div className="bg-red-500/20 border border-red-500 text-red-400 p-3 rounded-lg mb-4">
                    {error}
                </div>
            )}

            {!isConnected && !error && (
                <Card className="text-center py-8">
                    <WifiOff className="w-12 h-12 mx-auto text-slate-400 mb-4" />
                    <p className="text-slate-300">Connecting to OpenClaw...</p>
                </Card>
            )}

            {isConnected && (
                <>
                    {sortedSessions.length > 0 ? (
                        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                            {sortedSessions.map((session) => {
                                const sessionId = session.id || "unknown-" + Math.random();
                                const sessionType = session.type || "unknown";
                                const sessionModel = session.model || "Unknown";
                                const sessionTokens = session.tokenCount || 0;
                                const sessionMaxTokens = session.maxTokens || 200000;
                                const tokenPercent = getTokenPercent(sessionTokens, sessionMaxTokens);
                                const tokenColor = getTokenColor(tokenPercent);
                                const tokenBarColor = getTokenBarColor(tokenPercent);
                                const sessionChannel = session.channel || "unknown";
                                const sessionLabel = session.displayLabel || session.label || session.displayName || "";
                                
                                return (
                                    <Card key={sessionId} variant="bordered" className="p-4">
                                        {/* Header: Type badge + Channel + Delete */}
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="flex items-center gap-2">
                                                <span className={"px-2 py-0.5 text-xs font-medium rounded border " + getTypeBadgeColor(sessionType)}>
                                                    {formatSessionType(session)}
                                                </span>
                                                {sessionChannel && sessionChannel !== "unknown" && (
                                                    <span className="px-2 py-0.5 text-xs font-medium rounded bg-slate-700 text-slate-300">
                                                        {sessionChannel}
                                                    </span>
                                                )}
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => handleDeleteClick(session)}
                                                className="text-red-400 hover:text-red-300 hover:bg-red-500/10 p-1"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </Button>
                                        </div>

                                        {/* Label */}
                                        {sessionLabel && (
                                            <div className="text-sm text-slate-200 font-medium mb-2 truncate" title={sessionLabel}>
                                                {sessionLabel}
                                            </div>
                                        )}

                                        {/* Session ID */}
                                        <div className="text-xs text-slate-500 font-mono truncate mb-3" title={sessionId}>
                                            {sessionId}
                                        </div>

                                        {/* Model + Tokens row */}
                                        <div className="flex items-center gap-3 mb-3">
                                            <div className="flex items-center gap-1.5 text-sm text-slate-300">
                                                <Cpu className="w-4 h-4 text-slate-400" />
                                                <span className="truncate max-w-[100px]" title={sessionModel}>
                                                    {sessionModel}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                                <Coins className="w-4 h-4 text-slate-400" />
                                                <span className={"text-sm " + tokenColor}>
                                                    {formatTokens(sessionTokens, sessionMaxTokens)}
                                                </span>
                                            </div>
                                        </div>

                                        {/* Token progress bar */}
                                        <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden mb-3">
                                            <div
                                                className={"h-full transition-all duration-300 " + tokenBarColor}
                                                style={{ width: tokenPercent + "%" }}
                                            />
                                        </div>

                                        {/* Timestamp */}
                                        <div className="flex items-center gap-1 text-xs text-slate-400">
                                            <Clock className="w-3 h-3" />
                                            <span>{formatDuration(session.updatedAt)}</span>
                                        </div>
                                    </Card>
                                );
                            })}
                        </div>
                    ) : (
                        <Card className="text-center py-12">
                            <div className="text-4xl mb-4">💬</div>
                            <p className="text-slate-300 text-lg mb-1">No Active Sessions</p>
                            <p className="text-slate-400 text-sm">
                                There are no active OpenClaw sessions at the moment.
                            </p>
                        </Card>
                    )}
                </>
            )}

            {deleteTarget && (
                <DeleteConfirmDialog
                    session={deleteTarget}
                    onConfirm={handleDeleteConfirm}
                    onCancel={handleDeleteCancel}
                    isLoading={isDeleting}
                />
            )}
        </div>
    );
}
