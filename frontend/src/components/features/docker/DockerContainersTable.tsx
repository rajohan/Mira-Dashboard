import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { FileText, RotateCcw, SquareTerminal } from "lucide-react";
import { useState } from "react";

import type { DockerContainer } from "../../../../../contracts/docker/inventory";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { SortIndicator } from "../../ui/SortIndicator";
import {
    dockerContainerHealthRank,
    dockerContainerHealthVariant,
    dockerContainerStateRank,
    dockerContainerStateVariant,
    formatDockerMemoryUsed,
    parseDockerMemoryUsedMiB,
    parseDockerPercent,
} from "./dockerFormatters";

const columnHelper = createColumnHelper<DockerContainer>();

/** Provides props for Docker containers table. */
interface DockerContainersTableProperties {
    containers: DockerContainer[];
    isReadOnly?: boolean;
    onDetails: (containerId: string) => void;
    onLogs: (containerId: string) => void;
    onConsole: (containerId: string) => void;
    onRestart: (containerId: string) => void;
    onRestartStack: () => void;
}

/**
 * Renders the Docker containers table UI.
 * @returns Rendered the Docker containers table UI.
 */
export function DockerContainersTable({
    containers,
    isReadOnly = false,
    onDetails,
    onLogs,
    onConsole,
    onRestart,
    onRestartStack,
}: DockerContainersTableProperties) {
    const [sorting, setSorting] = useState<SortingState>([]);

    const columns = [
        columnHelper.accessor("name", {
            header: "Container",
            cell: (info) => {
                const container = info.row.original;
                return (
                    <div className="min-w-0">
                        <div className="font-medium wrap-break-word text-primary-50">
                            {container.name}
                        </div>
                        <div className="text-xs break-all text-primary-400">
                            {container.image}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-primary-500">
                            {container.service ? (
                                <span>service: {container.service}</span>
                            ) : undefined}
                            {container.project ? (
                                <span>project: {container.project}</span>
                            ) : undefined}
                        </div>
                    </div>
                );
            },
        }),
        columnHelper.accessor(
            (row) => `${dockerContainerStateRank(row.state)}|${row.status}`,
            {
                id: "state",
                header: "State",
                cell: (info) => {
                    const container = info.row.original;
                    return (
                        <div>
                            <Badge variant={dockerContainerStateVariant(container.state)}>
                                {container.state}
                            </Badge>
                            <div className="mt-1 text-xs text-primary-400">
                                {container.status}
                            </div>
                        </div>
                    );
                },
                sortingFn: (a, b) => {
                    const stateDiff =
                        dockerContainerStateRank(a.original.state) -
                        dockerContainerStateRank(b.original.state);
                    if (stateDiff !== 0) {
                        return stateDiff;
                    }
                    return a.original.status.localeCompare(b.original.status);
                },
            }
        ),
        columnHelper.accessor((row) => row.health, {
            id: "health",
            header: "Health",
            cell: (info) => {
                const container = info.row.original;
                return (
                    <div>
                        <Badge variant={dockerContainerHealthVariant(container)}>
                            {container.health}
                        </Badge>
                        <div className="mt-1 text-xs text-primary-400">
                            restarts: {container.restartCount}
                        </div>
                    </div>
                );
            },
            sortingFn: (a, b) =>
                dockerContainerHealthRank(a.original.health) -
                dockerContainerHealthRank(b.original.health),
        }),
        columnHelper.accessor((row) => parseDockerPercent(row.stats?.cpu), {
            id: "cpu",
            header: "CPU",
            cell: (info) => {
                const container = info.row.original;
                return (
                    <div className="text-xs text-primary-300">
                        {container.stats?.cpu || "-"}
                    </div>
                );
            },
        }),
        columnHelper.accessor((row) => parseDockerMemoryUsedMiB(row.stats?.memory), {
            id: "memory",
            header: "Memory",
            cell: (info) => {
                const container = info.row.original;
                return (
                    <div className="text-xs text-primary-300">
                        {formatDockerMemoryUsed(container.stats?.memory)}
                    </div>
                );
            },
        }),
        columnHelper.display({
            id: "ports",
            header: "Ports",
            cell: (info) => {
                const container = info.row.original;
                return (
                    <div className="text-xs wrap-break-word text-primary-300">
                        {container.ports.length > 0 ? container.ports.join(", ") : "—"}
                    </div>
                );
            },
        }),
        columnHelper.display({
            id: "actions",
            header: "Actions",
            cell: (info) => {
                const container = info.row.original;
                return (
                    <div className="flex flex-nowrap items-center gap-2">
                        <Button
                            size="sm"
                            variant="secondary"
                            title={`Show logs for ${container.name}`}
                            aria-label={`Show logs for ${container.name}`}
                            disabled={isReadOnly}
                            onClick={(event) => {
                                event.stopPropagation();
                                onLogs(container.id);
                            }}
                        >
                            <FileText className="size-4" />
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            title={`Open console for ${container.name}`}
                            aria-label={`Open console for ${container.name}`}
                            disabled={isReadOnly}
                            onClick={(event) => {
                                event.stopPropagation();
                                onConsole(container.id);
                            }}
                        >
                            <SquareTerminal className="size-4" />
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            title={`Restart ${container.name}`}
                            aria-label={`Restart ${container.name}`}
                            disabled={isReadOnly}
                            onClick={(event) => {
                                event.stopPropagation();
                                onRestart(container.id);
                            }}
                        >
                            <RotateCcw className="size-4" />
                        </Button>
                    </div>
                );
            },
        }),
    ];

    const table = useReactTable({
        data: containers,
        columns,
        state: { sorting },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
    });

    return containers.length === 0 ? (
        <Card className="overflow-hidden">
            <div className="border-b border-primary-700 p-3 text-lg font-semibold sm:px-4">
                Containers
            </div>
            <EmptyState message="No containers found." />
        </Card>
    ) : (
        <Card className="overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-primary-700 p-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                <div className="text-lg font-semibold">Containers</div>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={onRestartStack}
                    disabled={isReadOnly}
                    className="w-full sm:w-auto"
                >
                    <RotateCcw className="size-4" />
                    Restart stack
                </Button>
            </div>

            <div className="space-y-3 p-3 md:hidden">
                {table.getRowModel().rows.map((row) => {
                    const container = row.original;
                    return (
                        <div
                            key={row.id}
                            className="relative w-full rounded-lg border border-primary-700 bg-primary-900/40 p-3 text-left"
                        >
                            <button
                                type="button"
                                aria-label={`Open details for ${container.name}`}
                                disabled={isReadOnly}
                                className="absolute inset-0 rounded-lg hover:bg-primary-800/50 focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-none"
                                onClick={() => onDetails(container.id)}
                            />
                            <div className="pointer-events-none relative">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="font-medium wrap-break-word text-primary-50">
                                            {container.name}
                                        </div>
                                        <div className="mt-1 text-xs break-all text-primary-400">
                                            {container.image}
                                        </div>
                                    </div>
                                    <Badge
                                        variant={dockerContainerStateVariant(
                                            container.state
                                        )}
                                    >
                                        {container.state}
                                    </Badge>
                                </div>
                                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-primary-300">
                                    <div>
                                        <div className="text-primary-500">Health</div>
                                        <Badge
                                            variant={dockerContainerHealthVariant(
                                                container
                                            )}
                                        >
                                            {container.health}
                                        </Badge>
                                    </div>
                                    <div>
                                        <div className="text-primary-500">Memory</div>
                                        {formatDockerMemoryUsed(container.stats?.memory)}
                                    </div>
                                    <div>
                                        <div className="text-primary-500">CPU</div>
                                        {container.stats?.cpu || "-"}
                                    </div>
                                    <div>
                                        <div className="text-primary-500">Restarts</div>
                                        {container.restartCount}
                                    </div>
                                </div>
                                {container.ports.length > 0 ? (
                                    <div className="mt-3 text-xs wrap-break-word text-primary-400">
                                        Ports: {container.ports.join(", ")}
                                    </div>
                                ) : undefined}
                                <div className="pointer-events-auto mt-3 grid grid-cols-3 gap-2">
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        aria-label={`Show logs for ${container.name}`}
                                        disabled={isReadOnly}
                                        onClick={() => onLogs(container.id)}
                                    >
                                        <FileText className="size-4" />
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        aria-label={`Open console for ${container.name}`}
                                        disabled={isReadOnly}
                                        onClick={() => onConsole(container.id)}
                                    >
                                        <SquareTerminal className="size-4" />
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        aria-label={`Restart ${container.name}`}
                                        disabled={isReadOnly}
                                        onClick={() => onRestart(container.id)}
                                    >
                                        <RotateCcw className="size-4" />
                                    </Button>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="hidden max-h-130 overflow-auto md:block">
                <table className="min-w-225 text-sm lg:min-w-full">
                    <thead className="sticky top-0 z-10 bg-primary-900/95 text-left text-primary-300 backdrop-blur">
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr key={headerGroup.id}>
                                {headerGroup.headers.map((header) => (
                                    <th key={header.id} className="px-4 py-3 align-top">
                                        {header.column.getCanSort() ? (
                                            <button
                                                type="button"
                                                className="flex items-center gap-1 select-none hover:text-primary-100"
                                                onClick={header.column.getToggleSortingHandler()}
                                            >
                                                {flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext()
                                                )}
                                                <span className="text-primary-500">
                                                    <SortIndicator
                                                        direction={header.column.getIsSorted()}
                                                    />
                                                </span>
                                            </button>
                                        ) : (
                                            <div className="flex items-center gap-1">
                                                {flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext()
                                                )}
                                            </div>
                                        )}
                                    </th>
                                ))}
                            </tr>
                        ))}
                    </thead>
                    <tbody>
                        {table.getRowModel().rows.map((row) => (
                            <tr
                                key={row.id}
                                className={
                                    "border-b border-primary-700/50 hover:bg-primary-700/30 " +
                                    (isReadOnly ? "" : "cursor-pointer")
                                }
                                onClick={
                                    isReadOnly
                                        ? undefined
                                        : () => onDetails(row.original.id)
                                }
                            >
                                {row.getVisibleCells().map((cell) => (
                                    <td key={cell.id} className="px-4 py-3 align-top">
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
