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

import type { DockerImage } from "../../../hooks/useDocker";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";

const columnHelper = createColumnHelper<DockerImage>();

/** Handles format bytes. */
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

/** Describes docker images table props. */
interface DockerImagesTableProps {
    images: DockerImage[];
    onDelete: (imageId: string, label: string) => void;
    onPruneUnused: () => void;
    isPruning?: boolean;
}

/** Renders the docker images table UI. */
export function DockerImagesTable({
    images,
    onDelete,
    onPruneUnused,
    isPruning = false,
}: DockerImagesTableProps) {
    const [sorting, setSorting] = useState<SortingState>([]);

    const columns = [
        columnHelper.accessor("repository", {
            header: "Image",
            cell: (info) => {
                const image = info.row.original;
                return (
                    <div className="min-w-0">
                        <div className="text-primary-50 font-medium break-all">
                            {image.repository}
                        </div>
                        <div className="text-primary-400 text-xs break-all">
                            tag: {image.tag || "<none>"}
                        </div>
                    </div>
                );
            },
        }),
        columnHelper.accessor("size", {
            header: "Size",
            cell: (info) => (
                <span className="text-primary-300">{formatBytes(info.getValue())}</span>
            ),
        }),
        columnHelper.accessor((row) => row.inUseBy.length, {
            id: "usage",
            header: "Used by",
            cell: (info) => {
                const image = info.row.original;
                return (
                    <div className="text-primary-300 text-xs break-words">
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
                        title="Delete"
                        aria-label="Delete"
                        disabled={image.inUseBy.length > 0}
                        onClick={(event) => {
                            event.stopPropagation();
                            onDelete(
                                image.id,
                                `${image.repository}:${image.tag || "<none>"}`
                            );
                        }}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                );
            },
        }),
    ];

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
                <div className="border-primary-700 border-b px-3 py-3 text-lg font-semibold sm:px-4">
                    Images
                </div>
                <EmptyState message="No images found." />
            </Card>
        );
    }

    return (
        <Card className="overflow-hidden">
            <div className="border-primary-700 flex flex-col gap-3 border-b px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                <div className="text-lg font-semibold">Images</div>
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
                    const image = row.original;
                    const label = `${image.repository}:${image.tag || "<none>"}`;
                    return (
                        <Card key={row.id} className="p-3">
                            <div className="min-w-0">
                                <div className="text-primary-50 font-medium break-all">
                                    {image.repository}
                                </div>
                                <div className="text-primary-400 mt-1 text-xs break-all">
                                    tag: {image.tag || "<none>"}
                                </div>
                            </div>
                            <div className="text-primary-300 mt-3 grid grid-cols-2 gap-2 text-xs">
                                <div>
                                    <div className="text-primary-500">Size</div>
                                    {formatBytes(image.size)}
                                </div>
                                <div>
                                    <div className="text-primary-500">Used by</div>
                                    {image.inUseBy.length > 0
                                        ? image.inUseBy.length
                                        : "Unused"}
                                </div>
                            </div>
                            {image.inUseBy.length > 0 ? (
                                <div className="text-primary-400 mt-2 text-xs break-words">
                                    {image.inUseBy.join(", ")}
                                </div>
                            ) : null}
                            <Button
                                size="sm"
                                variant="danger"
                                disabled={image.inUseBy.length > 0}
                                onClick={() => onDelete(image.id, label)}
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
                <table className="min-w-[640px] text-sm lg:min-w-full">
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
