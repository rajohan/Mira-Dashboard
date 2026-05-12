import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { ChevronDown, Trash2 } from "lucide-react";
import { useState } from "react";

import type { DockerVolume } from "../../../hooks/useDocker";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";

const columnHelper = createColumnHelper<DockerVolume>();

/** Performs truncate mIDdle. */
function truncateMiddle(value: string, maxLength = 48): string {
    if (value.length <= maxLength) {
        return value;
    }

    const startLength = Math.floor((maxLength - 3) / 2);
    const endLength = maxLength - 3 - startLength;
    return `${value.slice(0, startLength)}...${value.slice(-endLength)}`;
}

/** Provides props for docker volumes table. */
interface DockerVolumesTableProps {
    volumes: DockerVolume[];
    onDelete: (volumeName: string) => void;
    onPruneUnused: () => void;
    isPruning?: boolean;
}

/** Renders the docker volumes table UI. */
export function DockerVolumesTable({
    volumes,
    onDelete,
    onPruneUnused,
    isPruning = false,
}: DockerVolumesTableProps) {
    const [sorting, setSorting] = useState<SortingState>([]);

    const columns = [
        columnHelper.accessor("name", {
            header: "Volume",
            cell: (info) => {
                const volume = info.row.original;
                return (
                    <div className="min-w-0">
                        <div
                            className="text-primary-50 font-medium break-all"
                            title={volume.name}
                        >
                            {truncateMiddle(volume.name, 40)}
                        </div>
                        <div
                            className="text-primary-400 text-xs break-all"
                            title={volume.mountpoint}
                        >
                            {volume.driver} · {truncateMiddle(volume.mountpoint, 54)}
                        </div>
                    </div>
                );
            },
        }),
        columnHelper.accessor((row) => (row.usedBy.length > 0 ? 1 : 0), {
            id: "usage",
            header: "Status",
            cell: (info) => {
                const volume = info.row.original;
                return (
                    <div className="text-primary-300 text-xs">
                        {volume.usedBy.length > 0 ? "Used" : "Unused"}
                    </div>
                );
            },
        }),
        columnHelper.display({
            id: "actions",
            header: "Actions",
            cell: (info) => {
                const volume = info.row.original;
                return (
                    <Button
                        size="sm"
                        variant="danger"
                        title="Delete"
                        aria-label="Delete"
                        disabled={volume.usedBy.length > 0}
                        onClick={(event) => {
                            event.stopPropagation();
                            onDelete(volume.name);
                        }}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                );
            },
        }),
    ];

    const table = useReactTable({
        data: volumes,
        columns,
        state: { sorting },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
    });

    const unusedCount = volumes.filter((volume) => volume.usedBy.length === 0).length;

    if (volumes.length === 0) {
        return (
            <Card className="overflow-hidden">
                <div className="border-primary-700 border-b px-3 py-3 text-lg font-semibold sm:px-4">
                    Volumes
                </div>
                <EmptyState message="No volumes found." />
            </Card>
        );
    }

    return (
        <Card className="overflow-hidden">
            <div className="border-primary-700 flex flex-col gap-3 border-b px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                <div className="text-lg font-semibold">Volumes</div>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={onPruneUnused}
                    disabled={isPruning}
                    className="w-full sm:w-auto"
                >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {isPruning ? "Removing unused..." : `Remove unused (${unusedCount})`}
                </Button>
            </div>

            <div className="space-y-3 p-3 md:hidden">
                {table.getRowModel().rows.map((row) => {
                    const volume = row.original;
                    return (
                        <Card key={row.id} className="p-3">
                            <div
                                className="text-primary-50 font-medium break-all"
                                title={volume.name}
                            >
                                {truncateMiddle(volume.name, 52)}
                            </div>
                            <div
                                className="text-primary-400 mt-1 text-xs break-all"
                                title={volume.mountpoint}
                            >
                                {volume.driver} · {truncateMiddle(volume.mountpoint, 72)}
                            </div>
                            <div className="text-primary-300 mt-3 grid grid-cols-2 gap-2 text-xs">
                                <div>
                                    <div className="text-primary-500">Status</div>
                                    {volume.usedBy.length > 0 ? "Used" : "Unused"}
                                </div>
                                <div>
                                    <div className="text-primary-500">Scope</div>
                                    {volume.scope || "—"}
                                </div>
                            </div>
                            {volume.usedBy.length > 0 ? (
                                <div className="text-primary-400 mt-2 text-xs break-words">
                                    Used by: {volume.usedBy.join(", ")}
                                </div>
                            ) : null}
                            <Button
                                size="sm"
                                variant="danger"
                                disabled={volume.usedBy.length > 0}
                                onClick={() => onDelete(volume.name)}
                                className="mt-3 w-full"
                            >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                            </Button>
                        </Card>
                    );
                })}
            </div>

            <div className="hidden max-h-[420px] overflow-auto md:block">
                <table className="min-w-[560px] text-sm lg:min-w-full">
                    <thead className="bg-primary-900/95 text-primary-300 sticky top-0 z-10 text-left backdrop-blur">
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr key={headerGroup.id}>
                                {headerGroup.headers.map((header) => (
                                    <th
                                        key={header.id}
                                        className={
                                            "px-4 py-3 align-top " +
                                            (header.column.getCanSort()
                                                ? "hover:text-primary-100 cursor-pointer select-none"
                                                : "")
                                        }
                                        onClick={header.column.getToggleSortingHandler()}
                                    >
                                        <div className="flex items-center gap-1">
                                            {flexRender(
                                                header.column.columnDef.header,
                                                header.getContext()
                                            )}
                                            {header.column.getCanSort() ? (
                                                <span className="text-primary-500">
                                                    {header.column.getIsSorted() ===
                                                    "asc" ? (
                                                        <ChevronDown className="h-3 w-3" />
                                                    ) : header.column.getIsSorted() ===
                                                      "desc" ? (
                                                        <ChevronDown className="h-3 w-3 rotate-180" />
                                                    ) : null}
                                                </span>
                                            ) : null}
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
                                className="border-primary-700/50 hover:bg-primary-700/30 border-b align-top"
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
