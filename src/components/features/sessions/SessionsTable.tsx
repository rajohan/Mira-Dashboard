import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

import type { Session } from "../../../types/session";
import { formatDuration, formatTokens, getTokenPercent } from "../../../utils/format";
import { formatSessionType, getTypeSortOrder } from "../../../utils/sessionUtils";
import { Badge, getSessionTypeVariant } from "../../ui/Badge";
import { Card } from "../../ui/Card";
import { ProgressBar } from "../../ui/ProgressBar";
import { SessionActionsDropdown } from "./SessionActionsDropdown";

const columnHelper = createColumnHelper<Session>();

/** Provides props for sessions table. */
interface SessionsTableProps {
    sessions: Session[];
    onCompact: (key: string) => void;
    onReset: (key: string) => void;
    onDelete: (session: Session) => void;
}

/** Renders the sessions table UI. */
export function SessionsTable({
    sessions,
    onCompact,
    onReset,
    onDelete,
}: SessionsTableProps) {
    const [sorting, setSorting] = useState<SortingState>([]);
    const tableSessions = Array.isArray(sessions) ? sessions : [];

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
                    <span className="text-primary-200 block max-w-xs truncate text-sm">
                        {info.getValue()?.slice(0, 40) || "unknown"}
                    </span>
                ),
            }
        ),
        columnHelper.accessor("model", {
            header: "Model",
            cell: (info) => (
                <span className="text-primary-300 text-sm">
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
                        <span className="text-primary-300 text-sm">
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
                <span className="text-primary-400 text-sm">
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
                        onCompact={() => onCompact(row.original.key)}
                        onReset={() => onReset(row.original.key)}
                        onDelete={() => onDelete(row.original)}
                    />
                </div>
            ),
        }),
    ];

    const table = useReactTable({
        data: tableSessions,
        columns,
        state: { sorting },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
    });

    if (tableSessions.length === 0) {
        return (
            <Card className="py-8 text-center">
                <p className="text-primary-400">No sessions found</p>
            </Card>
        );
    }

    return (
        <Card>
            <div className="space-y-3 md:hidden">
                {table.getRowModel().rows.map((row) => {
                    const session = row.original;
                    const current = session.tokenCount || 0;
                    const max = session.maxTokens || 200_000;
                    const percent = getTokenPercent(current, max);
                    const name =
                        session.displayLabel ||
                        session.label ||
                        session.displayName ||
                        session.id ||
                        "unknown";

                    return (
                        <div
                            key={row.id}
                            className="border-primary-700 bg-primary-900/60 rounded-lg border p-3"
                        >
                            <div className="mb-2 flex items-start justify-between gap-3">
                                <div className="min-w-0 space-y-1">
                                    <Badge variant={getSessionTypeVariant(session.type)}>
                                        {formatSessionType(session)}
                                    </Badge>
                                    <div className="text-primary-100 line-clamp-2 text-sm font-medium break-words">
                                        {name}
                                    </div>
                                </div>
                                <div
                                    className="shrink-0"
                                    onClick={(event) => event.stopPropagation()}
                                >
                                    <SessionActionsDropdown
                                        onCompact={() => onCompact(session.key)}
                                        onReset={() => onReset(session.key)}
                                        onDelete={() => onDelete(session)}
                                    />
                                </div>
                            </div>

                            <div className="text-primary-400 space-y-2 text-xs">
                                <div className="min-w-0 truncate">
                                    Model: {session.model || "Unknown"}
                                </div>
                                <div>
                                    <div className="mb-1 flex items-center justify-between gap-2">
                                        <span>{formatTokens(current, max)}</span>
                                        <span>{percent}%</span>
                                    </div>
                                    <ProgressBar percent={percent} size="sm" />
                                </div>
                                <div>Last active {formatDuration(session.updatedAt)}</div>
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[760px]">
                    <thead className="bg-primary-800/50">
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr key={headerGroup.id}>
                                {headerGroup.headers.map((header) => (
                                    <th
                                        key={header.id}
                                        className={
                                            "text-primary-400 px-4 py-3 text-xs font-medium uppercase " +
                                            (header.column.getCanSort()
                                                ? "hover:text-primary-200 cursor-pointer select-none"
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
                                                <span className="text-primary-500">
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
                            <tr key={row.id} className="border-primary-700/50 border-b">
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
            </div>
        </Card>
    );
}
