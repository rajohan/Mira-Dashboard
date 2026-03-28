import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

import type { DockerVolume } from "../../../hooks/useDocker";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";

const columnHelper = createColumnHelper<DockerVolume>();

function truncateMiddle(value: string, maxLength = 48): string {
    if (value.length <= maxLength) {
        return value;
    }

    const startLength = Math.floor((maxLength - 3) / 2);
    const endLength = maxLength - 3 - startLength;
    return `${value.slice(0, startLength)}...${value.slice(-endLength)}`;
}

interface DockerVolumesTableProps {
    volumes: DockerVolume[];
    onDelete: (volumeName: string) => void;
    onPruneUnused: () => void;
    isPruning?: boolean;
}

export function DockerVolumesTable({ volumes, onDelete, onPruneUnused, isPruning = false }: DockerVolumesTableProps) {
    const [sorting, setSorting] = useState<SortingState>([]);

    const columns = [
            columnHelper.accessor("name", {
                header: "Volume",
                cell: (info) => {
                    const volume = info.row.original;
                    return (
                        <div>
                            <div className="font-medium text-primary-50" title={volume.name}>
                                {truncateMiddle(volume.name, 40)}
                            </div>
                            <div className="text-xs text-primary-400" title={volume.mountpoint}>
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
                        <div className="text-xs text-primary-300">
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
                            disabled={volume.usedBy.length > 0}
                            onClick={(event) => {
                                event.stopPropagation();
                                onDelete(volume.name);
                            }}
                        >
                            Delete
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
                <div className="border-b border-primary-700 px-4 py-3 text-lg font-semibold">Volumes</div>
                <EmptyState message="No volumes found." />
            </Card>
        );
    }

    return (
        <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-primary-700 px-4 py-3">
                <div className="text-lg font-semibold">Volumes</div>
                <Button size="sm" variant="secondary" onClick={onPruneUnused} disabled={isPruning}>
                    {isPruning ? "Removing unused..." : `Remove unused (${unusedCount})`}
                </Button>
            </div>
            <div className="max-h-[420px] overflow-auto">
                <table className="min-w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-primary-900/95 text-left text-primary-300 backdrop-blur">
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr key={headerGroup.id}>
                                {headerGroup.headers.map((header) => (
                                    <th
                                        key={header.id}
                                        className={
                                            "px-4 py-3 align-top " +
                                            (header.column.getCanSort()
                                                ? "cursor-pointer select-none hover:text-primary-100"
                                                : "")
                                        }
                                        onClick={header.column.getToggleSortingHandler()}
                                    >
                                        <div className="flex items-center gap-1">
                                            {flexRender(header.column.columnDef.header, header.getContext())}
                                            {header.column.getCanSort() ? (
                                                <span className="text-primary-500">
                                                    {header.column.getIsSorted() === "asc" ? (
                                                        <ChevronDown className="h-3 w-3" />
                                                    ) : header.column.getIsSorted() === "desc" ? (
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
                            <tr key={row.id} className="border-b border-primary-700/50 align-top hover:bg-primary-700/30">
                                {row.getVisibleCells().map((cell) => (
                                    <td key={cell.id} className="px-4 py-3">
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
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
