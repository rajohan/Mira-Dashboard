import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";

import type { DockerImage } from "../../../hooks/useDocker";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";

const columnHelper = createColumnHelper<DockerImage>();

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "0 B";
    }

    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

interface DockerImagesTableProps {
    images: DockerImage[];
    onDelete: (imageId: string, label: string) => void;
    onPruneUnused: () => void;
    isPruning?: boolean;
}

export function DockerImagesTable({ images, onDelete, onPruneUnused, isPruning = false }: DockerImagesTableProps) {
    const [sorting, setSorting] = useState<SortingState>([]);

    const columns = useMemo(
        () => [
            columnHelper.accessor("repository", {
                header: "Image",
                cell: (info) => {
                    const image = info.row.original;
                    return (
                        <div>
                            <div className="font-medium text-primary-50">{image.repository}</div>
                            <div className="text-xs text-primary-400">tag: {image.tag || "<none>"}</div>
                        </div>
                    );
                },
            }),
            columnHelper.accessor("size", {
                header: "Size",
                cell: (info) => <span className="text-primary-300">{formatBytes(info.getValue())}</span>,
            }),
            columnHelper.accessor((row) => row.inUseBy.length, {
                id: "usage",
                header: "Used by",
                cell: (info) => {
                    const image = info.row.original;
                    return (
                        <div className="text-xs text-primary-300">
                            {image.inUseBy.length > 0 ? image.inUseBy.join(", ") : "Unused"}
                        </div>
                    );
                },
            }),
            columnHelper.display({
                id: "actions",
                header: "Actions",
                cell: (info) => {
                    const image = info.row.original;
                    return (
                        <Button
                            size="sm"
                            variant="danger"
                            disabled={image.inUseBy.length > 0}
                            onClick={(event) => {
                                event.stopPropagation();
                                onDelete(image.id, `${image.repository}:${image.tag || "<none>"}`);
                            }}
                        >
                            Delete
                        </Button>
                    );
                },
            }),
        ],
        [onDelete]
    );

    const table = useReactTable({
        data: images,
        columns,
        state: { sorting },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
    });

    const unusedCount = images.filter((image) => image.inUseBy.length === 0).length;

    if (images.length === 0) {
        return (
            <Card className="overflow-hidden">
                <div className="border-b border-primary-700 px-4 py-3 text-lg font-semibold">Images</div>
                <EmptyState message="No images found." />
            </Card>
        );
    }

    return (
        <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-primary-700 px-4 py-3">
                <div className="text-lg font-semibold">Images</div>
                <Button size="sm" variant="secondary" onClick={onPruneUnused} disabled={isPruning}>
                    {isPruning ? "Removing unused..." : `Remove unused (${unusedCount})`}
                </Button>
            </div>
            <div className="border-b border-primary-700/50 bg-primary-900/95 backdrop-blur">
                <table className="min-w-full text-sm">
                    <thead className="text-left text-primary-300">
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
                </table>
            </div>
            <div className="max-h-[420px] overflow-y-auto overflow-x-auto">
                <table className="min-w-full text-sm">
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
