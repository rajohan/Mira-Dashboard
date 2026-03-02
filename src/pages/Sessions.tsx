import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from "@tanstack/react-table";
import {
    AlertTriangle,
    ArrowDown,
    ArrowUp,
    ChevronDown,
    Clock,
    Cpu,
    Database,
    Hash,
    MessageSquare,
    MoreVertical,
    RefreshCw,
    RotateCcw,
    Square,
    Trash2,
    Wifi,
    WifiOff,
    X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";
import { type Session, useOpenClaw } from "../hooks/useOpenClaw";
import { useAuthStore } from "../stores/authStore";

function formatDuration(updatedAt: number | null | undefined): string {
    if (!updatedAt) return "Unknown";
    const now = Date.now();
    const diffMs = now - updatedAt;
    const diffMins = Math.floor(diffMs / 60_000);
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
        case "MAIN": {
            return "bg-blue-500/20 text-blue-400 border-blue-500/30";
        }
        case "HOOK": {
            return "bg-green-500/20 text-green-400 border-green-500/30";
        }
        case "CRON": {
            return "bg-purple-500/20 text-purple-400 border-purple-500/30";
        }
        case "SUBAGENT": {
            return "bg-orange-500/20 text-orange-400 border-orange-500/30";
        }
        default: {
            return "bg-slate-500/20 text-slate-400 border-slate-500/30";
        }
    }
}

function formatSessionType(session: Session): string {
    const type = (session.type || "unknown").toUpperCase();
    if (type === "SUBAGENT" && session.agentType) return session.agentType.toUpperCase();
    return type;
}

const SESSION_TYPES = ["ALL", "MAIN", "SUBAGENT", "HOOK", "CRON"] as const;

const columnHelper = createColumnHelper<Session>();

interface DeleteConfirmDialogProps {
    session: Session | null;
    onConfirm: () => void;
    onCancel: () => void;
    isLoading: boolean;
}

function DeleteConfirmDialog({
    session,
    onConfirm,
    onCancel,
    isLoading,
}: DeleteConfirmDialogProps) {
    const displayName =
        session?.displayLabel || session?.label || session?.displayName || session?.id;
    const isMain = (session?.type || "").toUpperCase() === "MAIN";

    return (
        <Modal
            isOpen={!!session}
            onClose={onCancel}
            title="Delete Session?"
            size="md"
            closeOnOverlayClick={false}
        >
            <div className="flex items-start gap-3">
                <div className="rounded-lg bg-red-500/20 p-2">
                    <AlertTriangle className="h-6 w-6 text-red-400" />
                </div>
                <div className="flex-1">
                    <p className="mb-2 text-sm text-slate-300">
                        Are you sure you want to delete this session?
                        <span className="mt-1 block text-xs text-slate-400">
                            {displayName}
                        </span>
                    </p>
                    {isMain && (
                        <p className="mb-4 text-xs text-yellow-400">
                            This is a MAIN session. Deleting it will terminate the primary
                            conversation.
                        </p>
                    )}
                    <div className="flex justify-end gap-2">
                        <Button
                            variant="secondary"
                            onClick={onCancel}
                            disabled={isLoading}
                        >
                            Cancel
                        </Button>
                        <Button variant="danger" onClick={onConfirm} disabled={isLoading}>
                            {isLoading ? "Deleting..." : "Delete Session"}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

interface SessionDetailsProps {
    session: Session | null;
    onClose: () => void;
    onDelete: () => void;
    onStop: () => void;
    onCompact: () => void;
    onReset: () => void;
}

function SessionDetails({
    session,
    onClose,
    onDelete,
    onStop,
    onCompact,
    onReset,
}: SessionDetailsProps) {
    const [history, setHistory] = useState<
        Array<{ role: string; content: string; timestamp?: string }>
    >([]);
    const [loading, setLoading] = useState(true);
    const [visibleCount, setVisibleCount] = useState(50);
    const [totalCount, setTotalCount] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const fetchHistory = async () => {
        if (!session) return;
        setLoading(true);
        setError(null);
        setVisibleCount(50);
        try {
            const res = await fetch(
                "/api/sessions/" + encodeURIComponent(session.key) + "/history"
            );
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || "Failed to fetch history");
            }
            const data = await res.json();
            setHistory(data.messages || []);
            setTotalCount(data.total || data.messages?.length || 0);
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (session) {
            fetchHistory();
        }
    }, [session]);

    if (!session) return null;

    const displayName =
        session.displayLabel || session.label || session.displayName || session.id;
    const sessionModel = session.model || "Unknown";
    const sessionTokens = session.tokenCount || 0;
    const sessionMaxTokens = session.maxTokens || 200_000;
    const tokenPercent = getTokenPercent(sessionTokens, sessionMaxTokens);

    return (
        <Modal isOpen={!!session} onClose={onClose} size="3xl">
            <div className="flex flex-col" style={{ maxHeight: "85vh" }}>
                {/* Header */}
                <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-700 pb-4">
                    <div className="flex min-w-0 items-center gap-3">
                        <span
                            className={
                                "flex-shrink-0 rounded border px-2 py-0.5 text-xs font-medium " +
                                getTypeBadgeColor(session.type)
                            }
                        >
                            {formatSessionType(session)}
                        </span>
                        <h2 className="truncate text-lg font-semibold text-slate-100">
                            {displayName}
                        </h2>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                        <Menu>
                            {({ open }) => (
                                <>
                                    <MenuButton
                                        as={Button}
                                        variant="ghost"
                                        size="sm"
                                        className={
                                            "flex items-center gap-1 border-0 text-slate-300 outline-none " +
                                            (open ? "bg-slate-700" : "")
                                        }
                                    >
                                        <MoreVertical className="h-4 w-4" />
                                        <ChevronDown
                                            className={
                                                "h-3 w-3 transition-transform " +
                                                (open ? "rotate-180" : "")
                                            }
                                        />
                                    </MenuButton>
                                    <MenuItems
                                        anchor="bottom end"
                                        className="z-50 mt-1 min-w-[140px] rounded border border-slate-700 bg-slate-800 shadow-lg outline-none focus:outline-none"
                                    >
                                        <MenuItem>
                                            <button
                                                onClick={onStop}
                                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-700 focus:outline-none"
                                            >
                                                <Square className="h-4 w-4 text-slate-400" />{" "}
                                                Stop
                                            </button>
                                        </MenuItem>
                                        <MenuItem>
                                            <button
                                                onClick={onCompact}
                                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-700 focus:outline-none"
                                            >
                                                <Database className="h-4 w-4 text-slate-400" />{" "}
                                                Compact
                                            </button>
                                        </MenuItem>
                                        <MenuItem>
                                            <button
                                                onClick={onReset}
                                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-700 focus:outline-none"
                                            >
                                                <RotateCcw className="h-4 w-4 text-slate-400" />{" "}
                                                Reset
                                            </button>
                                        </MenuItem>
                                        <div className="border-t border-slate-700" />
                                        <MenuItem>
                                            <button
                                                onClick={onDelete}
                                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-400 hover:bg-slate-700 focus:outline-none"
                                            >
                                                <Trash2 className="h-4 w-4" /> Delete
                                            </button>
                                        </MenuItem>
                                    </MenuItems>
                                </>
                            )}
                        </Menu>
                        <Button variant="ghost" size="sm" onClick={onClose}>
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                </div>

                {/* Stats */}
                <div className="grid flex-shrink-0 grid-cols-3 border-b border-slate-700 bg-slate-800/30 py-4">
                    <div className="flex items-center gap-3">
                        <div className="rounded-lg bg-slate-700/50 p-2">
                            <Cpu className="h-4 w-4 text-slate-400" />
                        </div>
                        <div>
                            <span className="block text-xs text-slate-400">Model</span>
                            <p className="max-w-[150px] truncate text-sm font-medium text-slate-200">
                                {sessionModel}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center justify-center gap-3">
                        <div className="rounded-lg bg-slate-700/50 p-2">
                            <Hash className="h-4 w-4 text-slate-400" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <span className="block text-xs text-slate-400">Tokens</span>
                            <div className="flex items-center gap-2">
                                <p
                                    className={
                                        "text-sm font-medium " +
                                        getTokenColor(tokenPercent)
                                    }
                                >
                                    {formatTokens(sessionTokens, sessionMaxTokens)}
                                </p>
                                <div className="h-1.5 max-w-[100px] flex-1 rounded-full bg-slate-700">
                                    <div
                                        className={
                                            "h-full rounded-full transition-all " +
                                            getTokenBarColor(tokenPercent)
                                        }
                                        style={{ width: tokenPercent + "%" }}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center justify-end gap-3">
                        <div className="rounded-lg bg-slate-700/50 p-2">
                            <Clock className="h-4 w-4 text-slate-400" />
                        </div>
                        <div>
                            <span className="block text-xs text-slate-400">
                                Last Active
                            </span>
                            <p className="text-sm font-medium text-slate-200">
                                {formatDuration(session.updatedAt)}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Message History */}
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-700 py-3">
                        <h3 className="flex items-center gap-2 text-sm font-medium text-slate-300">
                            <MessageSquare className="h-4 w-4" /> Message History
                        </h3>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={fetchHistory}
                            disabled={loading}
                        >
                            <RefreshCw
                                className={"h-4 w-4 " + (loading ? "animate-spin" : "")}
                            />
                        </Button>
                    </div>
                    <div className="flex-1 overflow-auto py-4">
                        {loading ? (
                            <div className="flex items-center justify-center py-8">
                                <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
                                <span className="ml-2 text-slate-400">
                                    Loading history...
                                </span>
                            </div>
                        ) : error ? (
                            <div className="py-8 text-center">
                                <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-yellow-400" />
                                <p className="text-slate-400">{error}</p>
                            </div>
                        ) : history.length === 0 ? (
                            <div className="py-8 text-center">
                                <MessageSquare className="mx-auto mb-2 h-8 w-8 text-slate-500" />
                                <p className="text-slate-400">
                                    No message history available
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {[...history]
                                    .slice()
                                    .reverse()
                                    .slice(0, visibleCount)
                                    .map(
                                        (
                                            msg: {
                                                role: string;
                                                content: string;
                                                timestamp?: string;
                                            },
                                            i: number
                                        ) => (
                                            <div
                                                key={i}
                                                className={
                                                    "rounded-lg p-3 " +
                                                    (msg.role === "user"
                                                        ? "border border-blue-500/20 bg-blue-500/10"
                                                        : "border border-slate-600/50 bg-slate-700/50")
                                                }
                                            >
                                                <div className="mb-1 flex items-center justify-between">
                                                    <span
                                                        className={
                                                            "text-xs font-medium uppercase " +
                                                            (msg.role === "user"
                                                                ? "text-blue-400"
                                                                : "text-green-400")
                                                        }
                                                    >
                                                        {msg.role}
                                                    </span>
                                                    {msg.timestamp && (
                                                        <span className="text-xs text-slate-500">
                                                            {new Date(
                                                                msg.timestamp
                                                            ).toLocaleString("no-NO", {
                                                                day: "2-digit",
                                                                month: "2-digit",
                                                                year: "numeric",
                                                                hour: "2-digit",
                                                                minute: "2-digit",
                                                            })}
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="whitespace-pre-wrap break-words text-sm text-slate-200">
                                                    {msg.content?.slice(0, 500)}
                                                    {msg.content?.length > 500 && "..."}
                                                </p>
                                            </div>
                                        )
                                    )}
                                {history.length > visibleCount && (
                                    <div className="text-center">
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => setVisibleCount((c) => c + 50)}
                                        >
                                            Load more ({visibleCount} of {history.length}{" "}
                                            messages)
                                        </Button>
                                    </div>
                                )}
                                {totalCount > history.length && (
                                    <p className="mt-2 text-center text-xs text-slate-500">
                                        {totalCount - history.length} older messages on
                                        server
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </Modal>
    );
}

export function Sessions() {
    const { token } = useAuthStore();
    const { isConnected, error, connect, sessions, fetchSessions, deleteSession } =
        useOpenClaw(token);
    const hasConnected = useRef(false);
    const [isLoading, setIsLoading] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [selectedSession, setSelectedSession] = useState<Session | null>(null);
    const [sorting, setSorting] = useState<SortingState>([]);
    const [typeFilter, setTypeFilter] = useState<string>("ALL");

    useEffect(() => {
        if (token && !hasConnected.current) {
            hasConnected.current = true;
            connect();
        }
    }, [token, connect]);

    useEffect(() => {
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

    const handleDeleteConfirm = async () => {
        if (!deleteTarget || !deleteTarget.key) return;
        setIsDeleting(true);
        try {
            await deleteSession(deleteTarget.key);
            setDeleteTarget(null);
        } catch (error_) {
            console.error("Failed to delete session:", error_);
        } finally {
            setIsDeleting(false);
        }
    };

    const handleStop = async (sessionKey: string) => {
        try {
            await fetch("/api/sessions/" + encodeURIComponent(sessionKey) + "/action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "stop" }),
            });
        } catch (error_) {
            console.error("Failed to stop session:", error_);
        }
    };

    const handleCompact = async (sessionKey: string) => {
        try {
            await fetch("/api/sessions/" + encodeURIComponent(sessionKey) + "/action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "compact" }),
            });
        } catch (error_) {
            console.error("Failed to compact session:", error_);
        }
    };

    const handleReset = async (sessionKey: string) => {
        try {
            await fetch("/api/sessions/" + encodeURIComponent(sessionKey) + "/action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "reset" }),
            });
        } catch (error_) {
            console.error("Failed to reset session:", error_);
        }
    };

    const getTypeSortOrder = (type: string | null | undefined): number => {
        const t = (type || "unknown").toUpperCase();
        switch (t) {
            case "MAIN": {
                return 0;
            }
            case "SUBAGENT": {
                return 1;
            }
            case "HOOK": {
                return 2;
            }
            case "CRON": {
                return 3;
            }
            default: {
                return 4;
            }
        }
    };

    const sortedSessions = useMemo(() => {
        if (!sessions) return [];
        return [...sessions].sort((a, b) => {
            const typeOrder = getTypeSortOrder(a.type) - getTypeSortOrder(b.type);
            if (typeOrder !== 0) return typeOrder;
            return (b.updatedAt || 0) - (a.updatedAt || 0);
        });
    }, [sessions]);

    const filteredSessions = useMemo(() => {
        if (typeFilter === "ALL") return sortedSessions;
        return sortedSessions.filter((s) => (s.type || "").toUpperCase() === typeFilter);
    }, [sortedSessions, typeFilter]);

    const columns = useMemo(
        () => [
            columnHelper.accessor("type", {
                header: "Type",
                cell: (info) => (
                    <span
                        className={
                            "rounded border px-2 py-0.5 text-xs font-medium " +
                            getTypeBadgeColor(info.getValue())
                        }
                    >
                        {formatSessionType(info.row.original)}
                    </span>
                ),
                sortingFn: (a, b) => {
                    const orderA = getTypeSortOrder(a.original.type);
                    const orderB = getTypeSortOrder(b.original.type);
                    return orderA - orderB;
                },
            }),
            columnHelper.accessor(
                (row) => row.displayLabel || row.label || row.displayName || row.id,
                {
                    id: "name",
                    header: "Name",
                    cell: (info) => (
                        <span className="block max-w-xs truncate text-sm text-slate-200">
                            {info.getValue()?.slice(0, 40) || "unknown"}
                        </span>
                    ),
                }
            ),
            columnHelper.accessor("model", {
                header: "Model",
                cell: (info) => (
                    <span className="text-sm text-slate-300">
                        {info.getValue() || "Unknown"}
                    </span>
                ),
            }),
            columnHelper.accessor("tokenCount", {
                header: "Tokens",
                cell: (info) => {
                    const current = info.getValue() || 0;
                    const max = info.row.original.maxTokens || 200_000;
                    const percent = getTokenPercent(current, max);
                    return (
                        <div className="flex items-center gap-2">
                            <span className={"text-sm " + getTokenColor(percent)}>
                                {formatTokens(current, max)}
                            </span>
                            <div className="h-1 w-16 rounded-full bg-slate-700">
                                <div
                                    className={
                                        "h-full rounded-full " + getTokenBarColor(percent)
                                    }
                                    style={{ width: percent + "%" }}
                                />
                            </div>
                        </div>
                    );
                },
            }),
            columnHelper.accessor("updatedAt", {
                header: "Last Active",
                cell: (info) => (
                    <span className="text-sm text-slate-400">
                        {formatDuration(info.getValue())}
                    </span>
                ),
            }),
            columnHelper.display({
                id: "actions",
                header: "",
                cell: ({ row }) => (
                    <div
                        className="flex justify-end"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <Menu>
                            {({ open }) => (
                                <>
                                    <MenuButton
                                        as={Button}
                                        variant="ghost"
                                        size="sm"
                                        className={
                                            "flex items-center gap-1 border-0 text-slate-300 outline-none " +
                                            (open ? "bg-slate-700" : "")
                                        }
                                    >
                                        <MoreVertical className="h-4 w-4" />
                                        <ChevronDown
                                            className={
                                                "h-3 w-3 transition-transform " +
                                                (open ? "rotate-180" : "")
                                            }
                                        />
                                    </MenuButton>
                                    <MenuItems
                                        anchor="bottom end"
                                        className="z-50 mt-1 min-w-[120px] rounded border border-slate-700 bg-slate-800 shadow-lg outline-none focus:outline-none"
                                    >
                                        <MenuItem>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleStop(row.original.key);
                                                }}
                                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-700 focus:outline-none"
                                            >
                                                <Square className="h-4 w-4 text-slate-400" />{" "}
                                                Stop
                                            </button>
                                        </MenuItem>
                                        <MenuItem>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleCompact(row.original.key);
                                                }}
                                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-700 focus:outline-none"
                                            >
                                                <Database className="h-4 w-4 text-slate-400" />{" "}
                                                Compact
                                            </button>
                                        </MenuItem>
                                        <MenuItem>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleReset(row.original.key);
                                                }}
                                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-700 focus:outline-none"
                                            >
                                                <RotateCcw className="h-4 w-4 text-slate-400" />{" "}
                                                Reset
                                            </button>
                                        </MenuItem>
                                        <div className="border-t border-slate-700" />
                                        <MenuItem>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setDeleteTarget(row.original);
                                                }}
                                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-400 hover:bg-slate-700 focus:outline-none"
                                            >
                                                <Trash2 className="h-4 w-4" /> Delete
                                            </button>
                                        </MenuItem>
                                    </MenuItems>
                                </>
                            )}
                        </Menu>
                    </div>
                ),
            }),
        ],
        []
    );

    const table = useReactTable({
        data: filteredSessions,
        columns,
        state: { sorting },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
    });

    return (
        <div className="p-6">
            <div className="mb-6 flex items-center justify-between">
                <h1 className="text-2xl font-bold">Sessions</h1>
                <div className="flex items-center gap-4">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleRefresh}
                        disabled={!isConnected || isLoading}
                    >
                        <RefreshCw
                            className={
                                "mr-2 h-4 w-4 " + (isLoading ? "animate-spin" : "")
                            }
                        />
                        Refresh
                    </Button>
                    <div className="flex items-center gap-2">
                        {isConnected ? (
                            <span className="flex items-center gap-1 text-sm text-green-400">
                                <Wifi size={16} /> Connected
                            </span>
                        ) : (
                            <span className="flex items-center gap-1 text-sm text-red-400">
                                <WifiOff size={16} /> Disconnected
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Type filter buttons */}
            <div className="mb-4 flex gap-2">
                {SESSION_TYPES.map((type) => (
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
                <div className="mb-4 rounded-lg border border-red-500 bg-red-500/20 p-3 text-red-400">
                    {error}
                </div>
            )}

            {!isConnected && !error && (
                <Card className="py-8 text-center">
                    <WifiOff className="mx-auto mb-4 h-12 w-12 text-slate-400" />
                    <p className="text-slate-300">Connecting to OpenClaw...</p>
                </Card>
            )}

            {isConnected && (
                <>
                    {filteredSessions.length > 0 ? (
                        <Card>
                            <table className="w-full">
                                <thead className="bg-slate-800/50">
                                    {table.getHeaderGroups().map((headerGroup) => (
                                        <tr key={headerGroup.id}>
                                            {headerGroup.headers.map((header) => (
                                                <th
                                                    key={header.id}
                                                    className={
                                                        "px-4 py-3 text-xs font-medium uppercase text-slate-400 " +
                                                        (header.column.getCanSort()
                                                            ? "cursor-pointer select-none hover:text-slate-200"
                                                            : "") +
                                                        (header.id === "actions"
                                                            ? " text-right"
                                                            : " text-left")
                                                    }
                                                    onClick={header.column.getToggleSortingHandler()}
                                                >
                                                    <div className="flex items-center gap-1">
                                                        {flexRender(
                                                            header.column.columnDef
                                                                .header,
                                                            header.getContext()
                                                        )}
                                                        {{
                                                            asc: (
                                                                <ArrowUp className="h-3 w-3" />
                                                            ),
                                                            desc: (
                                                                <ArrowDown className="h-3 w-3" />
                                                            ),
                                                        }[
                                                            header.column.getIsSorted() as string
                                                        ] || null}
                                                    </div>
                                                </th>
                                            ))}
                                        </tr>
                                    ))}
                                </thead>
                                <tbody className="divide-y divide-slate-700">
                                    {table.getRowModel().rows.map((row) => (
                                        <tr
                                            key={row.id}
                                            className="cursor-pointer transition-colors hover:bg-slate-700/50"
                                            onClick={() =>
                                                setSelectedSession(row.original)
                                            }
                                        >
                                            {row.getVisibleCells().map((cell) => (
                                                <td
                                                    key={cell.id}
                                                    className={
                                                        "px-4 py-3 " +
                                                        (cell.column.id === "actions"
                                                            ? ""
                                                            : "")
                                                    }
                                                >
                                                    {flexRender(
                                                        cell.column.columnDef.cell,
                                                        cell.getContext()
                                                    )}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </Card>
                    ) : (
                        <Card className="py-12 text-center">
                            <div className="mb-4 text-4xl">?</div>
                            <p className="mb-1 text-lg text-slate-300">
                                No Active Sessions
                            </p>
                            <p className="text-sm text-slate-400">
                                There are no active OpenClaw sessions at the moment.
                            </p>
                        </Card>
                    )}
                </>
            )}

            <SessionDetails
                session={selectedSession}
                onClose={() => setSelectedSession(null)}
                onDelete={() => {
                    setDeleteTarget(selectedSession);
                    setSelectedSession(null);
                }}
                onStop={() => {
                    if (selectedSession) handleStop(selectedSession.key);
                }}
                onCompact={() => {
                    if (selectedSession) handleCompact(selectedSession.key);
                }}
                onReset={() => {
                    if (selectedSession) handleReset(selectedSession.key);
                }}
            />

            <DeleteConfirmDialog
                session={deleteTarget}
                onConfirm={handleDeleteConfirm}
                onCancel={() => setDeleteTarget(null)}
                isLoading={isDeleting}
            />
        </div>
    );
}
