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

import type { DockerContainer } from "../../../../../contracts/docker";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { SortIndicator } from "../../ui/SortIndicator";

const columnHelper = createColumnHelper<DockerContainer>();

/**
 * Parses percent.
 * @param value Value to process.
 * @returns Parsed percent.
 */
function parsePercent(value: string | undefined): number {
    if (!value) {
        return -1;
    }

    const match = value.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : -1;
}

/**
 * Parses memory used mi b.
 * @param value Value to process.
 * @returns Parsed memory used mi b.
 */
function parseMemoryUsedMiB(value: string | undefined): number {
    if (!value) {
        return -1;
    }

    const used = value.split("/", 1)[0]!.trim();
    const match = used.match(/^(\d+(?:\.\d+)?)\s*([KMGTP]i?B|B)$/i);
    if (!match) {
        return -1;
    }

    const amount = Number(match[1]!);
    const unit = match[2]!.toUpperCase();
    const factors: Record<string, number> = {
        B: 1 / (1024 * 1024),
        KIB: 1 / 1024,
        KB: 1 / 1024,
        MIB: 1,
        MB: 1,
        GIB: 1024,
        GB: 1024,
        TIB: 1024 * 1024,
        TB: 1024 * 1024,
        PIB: 1024 * 1024 * 1024,
        PB: 1024 * 1024 * 1024,
    };

    return amount * factors[unit]!;
}

/**
 * Formats memory used mb for display.
 * @param value Value to process.
 * @returns Formatted memory used mb for display.
 */
function formatMemoryUsedMb(value: string | undefined): string {
    const usedMiB = parseMemoryUsedMiB(value);
    if (!Number.isFinite(usedMiB) || usedMiB < 0) {
        return "-";
    }

    const usedMb = usedMiB * 1.048576;
    if (usedMb >= 1024) {
        return `${(usedMb / 1024).toFixed(2)} GB`;
    }

    return `${usedMb.toFixed(0)} MB`;
}

/**
 * Returns health rank.
 * @param health Health value.
 * @returns health rank.
 */
function getHealthRank(health: string): number {
    switch (health) {
        case "healthy": {
            return 0;
        }
        case "starting": {
            return 1;
        }
        case "unknown": {
            return 2;
        }
        case "unhealthy": {
            return 3;
        }
        default: {
            return 4;
        }
    }
}

/**
 * Returns health variant.
 * @returns health variant.
 */
function getHealthVariant(
    container: DockerContainer
): "success" | "warning" | "error" | "default" {
    if (container.health === "healthy") return "success";
    if (container.health === "unhealthy") return "error";
    if (container.state === "running") return "warning";
    return "default";
}

/**
 * Returns state variant.
 * @param state Current state.
 * @returns state variant.
 */
function getStateVariant(state: string): "success" | "warning" | "error" | "default" {
    if (state === "running") return "success";
    if (state === "exited") return "error";
    if (state === "restarting" || state === "created") return "warning";
    return "default";
}

/**
 * Returns state rank.
 * @param state Current state.
 * @returns state rank.
 */
function getStateRank(state: string): number {
    switch (state) {
        case "running": {
            return 0;
        }
        case "restarting": {
            return 1;
        }
        case "created": {
            return 2;
        }
        case "paused": {
            return 3;
        }
        case "exited": {
            return 4;
        }
        case "dead": {
            return 5;
        }
        default: {
            return 6;
        }
    }
}

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
        columnHelper.accessor((row) => `${getStateRank(row.state)}|${row.status}`, {
            id: "state",
            header: "State",
            cell: (info) => {
                const container = info.row.original;
                return (
                    <div>
                        <Badge variant={getStateVariant(container.state)}>
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
                    getStateRank(a.original.state) - getStateRank(b.original.state);
                if (stateDiff !== 0) {
                    return stateDiff;
                }
                return a.original.status.localeCompare(b.original.status);
            },
        }),
        columnHelper.accessor((row) => row.health, {
            id: "health",
            header: "Health",
            cell: (info) => {
                const container = info.row.original;
                return (
                    <div>
                        <Badge variant={getHealthVariant(container)}>
                            {container.health}
                        </Badge>
                        <div className="mt-1 text-xs text-primary-400">
                            restarts: {container.restartCount}
                        </div>
                    </div>
                );
            },
            sortingFn: (a, b) =>
                getHealthRank(a.original.health) - getHealthRank(b.original.health),
        }),
        columnHelper.accessor((row) => parsePercent(row.stats?.cpu), {
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
        columnHelper.accessor((row) => parseMemoryUsedMiB(row.stats?.memory), {
            id: "memory",
            header: "Memory",
            cell: (info) => {
                const container = info.row.original;
                return (
                    <div className="text-xs text-primary-300">
                        {formatMemoryUsedMb(container.stats?.memory)}
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
                                    <Badge variant={getStateVariant(container.state)}>
                                        {container.state}
                                    </Badge>
                                </div>
                                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-primary-300">
                                    <div>
                                        <div className="text-primary-500">Health</div>
                                        <Badge variant={getHealthVariant(container)}>
                                            {container.health}
                                        </Badge>
                                    </div>
                                    <div>
                                        <div className="text-primary-500">Memory</div>
                                        {formatMemoryUsedMb(container.stats?.memory)}
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
