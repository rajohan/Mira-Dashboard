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
    MessageSquare,

    AlertTriangle,
} from "lucide-react";

function formatDuration(createdAt: string): string {
    const start = new Date(createdAt).getTime();
    const now = Date.now();
    const diffMs = now - start;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
        return `${diffDays}d ${diffHours % 24}h`;
    }
    if (diffHours > 0) {
        return `${diffHours}h ${diffMins % 60}m`;
    }
    return `${diffMins}m`;
}

function getTypeBadgeColor(type: string): string {
    switch (type.toUpperCase()) {
        case "MAIN":
            return "bg-blue-500/20 text-blue-400 border-blue-500/30";
        case "HOOK":
            return "bg-green-500/20 text-green-400 border-green-500/30";
        case "CRON":
            return "bg-purple-500/20 text-purple-400 border-purple-500/30";
        case "SUBAGENT":
            return "bg-orange-500/20 text-orange-400 border-orange-500/30";
        default:
            return "bg-primary-600/20 text-primary-300 border-primary-500/30";
    }
}

interface KillConfirmDialogProps {
    session: Session;
    onConfirm: () => void;
    onCancel: () => void;
    isLoading: boolean;
}

function KillConfirmDialog({ session, onConfirm, onCancel, isLoading }: KillConfirmDialogProps) {
    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <Card variant="bordered" className="max-w-md w-full mx-4">
                <div className="flex items-start gap-3">
                    <div className="p-2 bg-red-500/20 rounded-lg">
                        <AlertTriangle className="w-6 h-6 text-red-400" />
                    </div>
                    <div className="flex-1">
                        <CardTitle className="mb-2">Kill Session?</CardTitle>
                        <p className="text-primary-300 text-sm mb-4">
                            Are you sure you want to kill session{" "}
                            <span className="font-mono text-primary-100">
                                {session.id.slice(0, 12)}...
                            </span>
                            ? This action cannot be undone.
                        </p>
                        <div className="flex gap-2 justify-end">
                            <Button variant="secondary" onClick={onCancel} disabled={isLoading}>
                                Cancel
                            </Button>
                            <Button variant="danger" onClick={onConfirm} disabled={isLoading}>
                                {isLoading ? "Killing..." : "Kill Session"}
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
    const { isConnected, error, connect, sessions, fetchSessions, killSession } = useOpenClaw(token);
    const hasConnected = useRef(false);
    const [isLoading, setIsLoading] = useState(false);
    const [killTarget, setKillTarget] = useState<Session | null>(null);
    const [isKilling, setIsKilling] = useState(false);

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

    const handleKillClick = (session: Session) => {
        setKillTarget(session);
    };

    const handleKillConfirm = async () => {
        if (!killTarget) return;
        setIsKilling(true);
        try {
            await killSession(killTarget.id);
            setKillTarget(null);
        } catch (e) {
            console.error("Failed to kill session:", e);
        } finally {
            setIsKilling(false);
        }
    };

    const handleKillCancel = () => {
        setKillTarget(null);
    };

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
                        <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
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
                    <WifiOff className="w-12 h-12 mx-auto text-primary-400 mb-4" />
                    <p className="text-primary-300">Connecting to OpenClaw...</p>
                </Card>
            )}

            {isConnected && (
                <>
                    {sessions && sessions.length > 0 ? (
                        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                            {sessions.map((session) => (
                                <Card key={session.id} variant="bordered">
                                    <div className="flex items-start justify-between mb-3">
                                        <div className="flex items-center gap-2">
                                            <span
                                                className={`px-2 py-0.5 text-xs font-medium rounded border ${getTypeBadgeColor(
                                                    session.type
                                                )}`}
                                            >
                                                {session.type.toUpperCase()}
                                            </span>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => handleKillClick(session)}
                                            className="text-red-400 hover:text-red-300 hover:bg-red-500/10 p-1"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </div>

                                    <div className="space-y-2">
                                        <div className="flex items-center gap-2 text-sm">
                                            <span className="text-primary-400 font-mono text-xs truncate max-w-[200px]">
                                                {session.id}
                                            </span>
                                        </div>

                                        <div className="flex items-center gap-4 text-sm">
                                            <div className="flex items-center gap-1 text-primary-300">
                                                <Cpu className="w-4 h-4 text-primary-400" />
                                                <span className="truncate max-w-[120px]">
                                                    {session.model || "Unknown"}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-1 text-primary-300">
                                                <MessageSquare className="w-4 h-4 text-primary-400" />
                                                <span>
                                                    {(session.tokenCount ?? 0).toLocaleString()} tokens
                                                </span>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-1 text-xs text-primary-400">
                                            <Clock className="w-3 h-3" />
                                            <span>
                                                {session.createdAt
                                                    ? formatDuration(session.createdAt)
                                                    : "Unknown"}
                                            </span>
                                            {session.agentName && (
                                                <>
                                                    <span className="mx-1">•</span>
                                                    <span className="truncate max-w-[100px]">
                                                        {session.agentName}
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </Card>
                            ))}
                        </div>
                    ) : (
                        <Card className="text-center py-12">
                            <MessageSquare className="w-12 h-12 mx-auto text-primary-400 mb-4" />
                            <p className="text-primary-300 text-lg mb-1">No Active Sessions</p>
                            <p className="text-primary-400 text-sm">
                                There are no active OpenClaw sessions at the moment.
                            </p>
                        </Card>
                    )}
                </>
            )}

            {killTarget && (
                <KillConfirmDialog
                    session={killTarget}
                    onConfirm={handleKillConfirm}
                    onCancel={handleKillCancel}
                    isLoading={isKilling}
                />
            )}
        </div>
    );
}
