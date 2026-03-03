import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { format } from "date-fns";
import { enUS } from "date-fns/locale";
import {
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
    X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import {
    formatDuration,
    formatTokens,
    getTokenPercent,
    getTokenColor,
    getTokenBarColor,
} from "../../../utils/format";
import { getTypeBadgeColor } from "./sessionUtils";

import type { Session } from "../../../hooks/useOpenClaw";

function formatSessionType(session: Session): string {
    const type = (session.type || "unknown").toUpperCase();
    if (type === "SUBAGENT" && session.agentType) return session.agentType.toUpperCase();
    return type;
}

interface SessionDetailsProps {
    session: Session | null;
    onClose: () => void;
    onDelete: () => void;
    onStop: () => void;
    onCompact: () => void;
    onReset: () => void;
}

export function SessionDetails({
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
                                        "text-sm font-medium " + getTokenColor(tokenPercent)
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
                                                            {format(
                                                                new Date(msg.timestamp),
                                                                "dd.MM.yyyy, HH:mm",
                                                                { locale: enUS }
                                                            )}
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