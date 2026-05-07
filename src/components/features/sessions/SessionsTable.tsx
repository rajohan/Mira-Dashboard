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

interface SessionsTableProps {
    sessions: Session[];
    onSelectSession: (session: Session) => void;
    onCompact: (key: string) => void;
    onReset: (key: string) => void;
    onDelete: (session: Session) => void;
}

export function SessionsTable({
    sessions,
    onSelectSession,
    onCompact,
    onReset,
    onDelete,
}: SessionsTableProps) {
    const [sorting, setSorting] = useState<SortingState>([]);

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
                    <span className="block max-w-xs truncate text-sm text-primary-200">
                        {info.getValue()?.slice(0, 40) || "unknown"}
                    </span>
                ),
            }
        ),
        columnHelper.accessor("model", {
            header: "Model",
            cell: (info) => (
                <span className="text-sm text-primary-300">
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
                        <span className="text-sm text-primary-300">
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
                <span className="text-sm text-primary-400">
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
        data: sessions,
        columns,
        state: { sorting },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
    });

    if (sessions.length === 0) {
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
                            role="button"
                            tabIndex={0}
                            className="cursor-pointer rounded-lg border border-primary-700 bg-primary-900/60 p-3 transition hover:border-primary-600 hover:bg-primary-800/80"
                            onClick={() => onSelectSession(session)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    onSelectSession(session);
                                }
                            }}
                        >
                            <div className="mb-2 flex items-start justify-between gap-3">
                                <div className="min-w-0 space-y-1">
                                    <Badge variant={getSessionTypeVariant(session.type)}>
                                        {formatSessionType(session)}
                                    </Badge>
                                    <div className="line-clamp-2 break-words text-sm font-medium text-primary-100">
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

                            <div className="space-y-2 text-xs text-primary-400">
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
                                            "px-4 py-3 text-xs font-medium uppercase text-primary-400 " +
                                            (header.column.getCanSort()
                                                ? "cursor-pointer select-none hover:text-primary-200"
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
                            <tr
                                key={row.id}
                                className="cursor-pointer border-b border-primary-700/50 hover:bg-primary-700/30"
                                onClick={() => onSelectSession(row.original)}
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
            </div>
        </Card>
    );
}
