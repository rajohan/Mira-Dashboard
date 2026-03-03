import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { ChevronDown, RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
    DeleteConfirmDialog,
    formatSessionType,
    getTypeSortOrder,
    SESSION_TYPES,
    SessionActionsDropdown,
    SessionDetails,
} from "../components/features/sessions";
import { Alert } from "../components/ui/Alert";
import { Badge, getSessionTypeVariant } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ConnectionStatus } from "../components/ui/ConnectionStatus";
import { FilterButtonGroup } from "../components/ui/FilterButtonGroup";
import { PageHeader } from "../components/ui/PageHeader";
import { ProgressBar } from "../components/ui/ProgressBar";
import { type Session } from "../hooks/useOpenClaw";
import { useOpenClaw } from "../hooks/useOpenClaw";
import { useDeleteSession, useSessionAction } from "../hooks/useSessions";
import { useAuthStore } from "../stores/authStore";
import { formatDuration, formatTokens, getTokenPercent } from "../utils/format";

const columnHelper = createColumnHelper<Session>();

export function Sessions() {
    const { token } = useAuthStore();
    const { isConnected, error, connect, sessions, fetchSessions } = useOpenClaw(token);
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
    }, [token, connect]);

    useEffect(() => {
        if (isConnected) {
            fetchSessions().catch(console.error);
        }
    }, [isConnected, fetchSessions]);

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
            sessions
                ? [...sessions].sort((a, b) => {
                      const typeOrder =
                          getTypeSortOrder(a.type) - getTypeSortOrder(b.type);
                      if (typeOrder !== 0) return typeOrder;
                      return (b.updatedAt || 0) - (a.updatedAt || 0);
                  })
                : [],
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
                <Badge variant={getSessionTypeVariant(info.getValue())}>
                    {formatSessionType(info.row.original)}
                </Badge>
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
                        <span className="text-sm text-slate-300">
                            {formatTokens(current, max)}
                        </span>
                        <ProgressBar percent={percent} size="sm" className="w-16" />
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

    const filterOptions = SESSION_TYPES.map((type) => ({
        value: type,
        label: type,
    }));

    return (
        <div className="p-6">
            <PageHeader
                title="Sessions"
                actions={
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
                }
                status={<ConnectionStatus isConnected={isConnected} />}
            />

            {/* Type filter buttons */}
            <div className="mb-4">
                <FilterButtonGroup
                    options={filterOptions}
                    value={typeFilter}
                    onChange={setTypeFilter}
                />
            </div>

            {error && <Alert variant="error">{error}</Alert>}

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
