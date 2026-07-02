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
import { formatBytes } from "./dockerFormatters";

const columnHelper = createColumnHelper<DockerImage>();

/** Provides props for Docker images table. */
interface DockerImagesTableProperties {
    images: DockerImage[];
    onDelete: (imageId: string, label: string) => void;
    onPruneUnused: () => void;
    isPruning?: boolean;
}

/** Renders the Docker images table UI. */
export function DockerImagesTable({
    images,
    onDelete,
    onPruneUnused,
    isPruning = false,
}: DockerImagesTableProperties) {
    const [sorting, setSorting] = useState<SortingState>([]);

    const columns = [
        columnHelper.accessor("repository", {
            header: "Image",
            cell: (info) => {
                const image = info.row.original;
                return (
                    <div className="min-w-0">
                        <div className="font-medium break-all text-primary-50">
                            {image.repository}
                        </div>
                        <div className="text-xs break-all text-primary-400">
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
                    <div className="text-xs wrap-break-word text-primary-300">
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
                const label = `${image.repository}:${image.tag || "<none>"}`;
                return (
                    <Button
                        size="sm"
                        variant="danger"
                        title={`Delete ${label}`}
                        aria-label={`Delete ${label}`}
                        disabled={image.inUseBy.length > 0}
                        onClick={(event) => {
                            event.stopPropagation();
                            onDelete(image.id, label);
                        }}
                    >
                        <Trash2 className="size-4" />
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

    return images.length === 0 ? (
        <Card className="overflow-hidden">
            <div className="border-b border-primary-700 p-3 text-lg font-semibold sm:px-4">
                Images
            </div>
            <EmptyState message="No images found." />
        </Card>
    ) : (
        <Card className="overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-primary-700 p-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                <div className="text-lg font-semibold">Images</div>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={onPruneUnused}
                    disabled={isPruning}
                    className="w-full sm:w-auto"
                >
                    <Trash2 className="size-4" />
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
                                <div className="font-medium break-all text-primary-50">
                                    {image.repository}
                                </div>
                                <div className="mt-1 text-xs break-all text-primary-400">
                                    tag: {image.tag || "<none>"}
                                </div>
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-primary-300">
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
                                <div className="mt-2 text-xs wrap-break-word text-primary-400">
                                    {image.inUseBy.join(", ")}
                                </div>
                            ) : undefined}
                            <Button
                                size="sm"
                                variant="danger"
                                aria-label={`Delete ${label}`}
                                disabled={image.inUseBy.length > 0}
                                onClick={() => onDelete(image.id, label)}
                                className="mt-3 w-full"
                            >
                                <Trash2 className="size-4" />
                                Delete
                            </Button>
                        </Card>
                    );
                })}
            </div>

            <div className="hidden max-h-105 overflow-auto md:block">
                <table className="min-w-160 text-sm lg:min-w-full">
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
                                            {flexRender(
                                                header.column.columnDef.header,
                                                header.getContext()
                                            )}
                                            {header.column.getCanSort() ? (
                                                <span className="text-primary-500">
                                                    {header.column.getIsSorted() ===
                                                    "asc" ? (
                                                        <ChevronDown className="size-3" />
                                                    ) : header.column.getIsSorted() ===
                                                      "desc" ? (
                                                        <ChevronDown className="size-3 rotate-180" />
                                                    ) : undefined}
                                                </span>
                                            ) : undefined}
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
                                className="border-b border-primary-700/50 align-top hover:bg-primary-700/30"
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
