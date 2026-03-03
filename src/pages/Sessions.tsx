import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { ChevronDown, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { useEffect, useRef, useState, useMemo } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import {
    DeleteConfirmDialog,
    SessionDetails,
    SessionActionsDropdown,
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
import { useSessionAction, useDeleteSession } from "../hooks/useSessions";
import { useAuthStore } from "../stores/authStore";

const columnHelper = createColumnHelper<Session>();

export function Sessions() {
    const { token } = useAuthStore();
    const { isConnected, error, connect, sessions, fetchSessions } =
        useOpenClaw(token);
    const sessionAction = useSessionAction();
    const deleteSessionMutation = useDeleteSession();
    const hasConnected = useRef(false);
    const [isLoading, setIsLoading] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
    const [selectedSession, setSelectedSession] = useState<Session | null>(null);
    const [sorting, setSorting] = useState<SortingState>([]);
    const [typeFilter, setTypeFilter] = useState<string>("ALL");

    useEffect(() => {
        if (token && !hasConnected.current) {
            hasConnected.current = true;
            connect();
        }
        // connect is intentionally excluded to prevent reconnection loops
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    useEffect(() => {
        if (isConnected) {
            fetchSessions().catch(console.error);
        }
        // fetchSessions is stable from useOpenClaw hook
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
        try {
            await deleteSessionMutation.mutateAsync(deleteTarget.key);
            setDeleteTarget(null);
        } catch (error_) {
            console.error("Failed to delete session:", error_);
        }
    };

    const handleStop = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "stop" });
    };

    const handleCompact = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "compact" });
    };

    const handleReset = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "reset" });
    };

    const sortedSessions = useMemo(
        () =>
            !sessions
                ? []
                : [...sessions].sort((a, b) => {
                      const typeOrder =
                          getTypeSortOrder(a.type) - getTypeSortOrder(b.type);
                      if (typeOrder !== 0) return typeOrder;
                      return (b.updatedAt || 0) - (a.updatedAt || 0);
                  }),
        [sessions]
    );

    const filteredSessions = useMemo(
        () =>
            typeFilter === "ALL"
                ? sortedSessions
                : sortedSessions.filter(
                      (s) => (s.type || "").toUpperCase() === typeFilter
                  ),
        [sortedSessions, typeFilter]
    );

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
                <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                    <SessionActionsDropdown
                        onStop={() => handleStop(row.original.key)}
                        onCompact={() => handleCompact(row.original.key)}
                        onReset={() => handleReset(row.original.key)}
                        onDelete={() => setDeleteTarget(row.original)}
                    />
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
                                                            header.column.columnDef
                                                                .header,
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
                                            onClick={() =>
                                                setSelectedSession(row.original)
                                            }
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
                isLoading={deleteSessionMutation.isPending}
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
