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
    ChevronDown,
    Database,
    MoreVertical,
    RefreshCw,
    RotateCcw,
    Square,
    Trash2,
    Wifi,
    WifiOff,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import {
    DeleteConfirmDialog,
    SessionDetails,
    formatSessionType,
    getTypeSortOrder,
    getTypeBadgeColor,
    SESSION_TYPES,
} from "../components/features/sessions";
import {
    formatDuration,
    formatTokens,
    getTokenPercent,
    getTokenColor,
    getTokenBarColor,
} from "../utils/format";
import { type Session } from "../hooks/useOpenClaw";
import { useOpenClaw } from "../hooks/useOpenClaw";
import { useAuthStore } from "../stores/authStore";

const columnHelper = createColumnHelper<Session>();

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

    const sortedSessions = !sessions ? [] : [...sessions].sort((a, b) => {
        const typeOrder = getTypeSortOrder(a.type) - getTypeSortOrder(b.type);
        if (typeOrder !== 0) return typeOrder;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    const filteredSessions = typeFilter === "ALL"
        ? sortedSessions
        : sortedSessions.filter((s) => (s.type || "").toUpperCase() === typeFilter);

    const columns = [
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
    ];

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
                                                            header.column.columnDef.header,
                                                            header.getContext()
                                                        )}
                                                        {header.column.getCanSort() && (
                                                            <span className="text-slate-500">
                                                                {header.column.getIsSorted() ===
                                                                "asc" ? (
                                                                    <ChevronDown className="h-3 w-3" />
                                                                ) : header.column.getIsSorted() ===
                                                                  "desc" ? (
                                                                    <ChevronDown className="h-3 w-3 rotate-180" />
                                                                ) : null}
                                                            </span>
                                                        )}
                                                    </div>
                                                </th>
                                            ))}
                                        </tr>
                                    ))}
                                </thead>
                                <tbody>
                                    {table.getRowModel().rows.map((row) => (
                                        <tr
                                            key={row.id}
                                            className="cursor-pointer border-b border-slate-700/50 hover:bg-slate-700/30"
                                            onClick={() => setSelectedSession(row.original)}
                                        >
                                            {row.getVisibleCells().map((cell) => (
                                                <td key={cell.id} className="px-4 py-3">
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
                        <Card className="py-8 text-center">
                            <p className="text-slate-400">No sessions found</p>
                        </Card>
                    )}
                </>
            )}

            <DeleteConfirmDialog
                session={deleteTarget}
                onConfirm={handleDeleteConfirm}
                onCancel={() => setDeleteTarget(null)}
                isLoading={isDeleting}
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