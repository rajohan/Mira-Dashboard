import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { ChevronDown, FileText, RotateCcw, SquareTerminal } from "lucide-react";
import { useState } from "react";

import type { DockerContainer } from "../../../hooks/useDocker";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";

const columnHelper = createColumnHelper<DockerContainer>();

function parsePercent(value: string | undefined): number {
    if (!value) {
        return -1;
    }

    const match = value.match(/-?[0-9]+(?:\.[0-9]+)?/);
    return match ? Number.parseFloat(match[0]) : -1;
}

function parseMemoryUsedMiB(value: string | undefined): number {
    if (!value) {
        return -1;
    }

    const used = value.split("/")[0]?.trim() || "";
    const match = used.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]i?B|B)$/i);
    if (!match) {
        return -1;
    }

    const amount = Number.parseFloat(match[1] || "0");
    const unit = (match[2] || "B").toUpperCase();
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
    };

    return amount * (factors[unit] || 1);
}

function formatMemoryUsedMb(value: string | undefined): string {
    const usedMiB = parseMemoryUsedMiB(value);
    if (usedMiB < 0) {
        return "-";
    }

    const usedMb = usedMiB * 1.048576;
    if (usedMb >= 1024) {
        return `${(usedMb / 1024).toFixed(2)} GB`;
    }

    return `${usedMb.toFixed(0)} MB`;
}

function getHealthRank(health: string): number {
    switch (health) {
        case "healthy":
            return 0;
        case "starting":
            return 1;
        case "unknown":
            return 2;
        case "unhealthy":
            return 3;
        default:
            return 4;
    }
}

function getHealthVariant(
    container: DockerContainer
): "success" | "warning" | "error" | "default" {
    if (container.health === "healthy") return "success";
    if (container.health === "unhealthy") return "error";
    if (container.state === "running") return "warning";
    return "default";
}

function getStateVariant(state: string): "success" | "warning" | "error" | "default" {
    if (state === "running") return "success";
    if (state === "exited") return "error";
    if (state === "restarting" || state === "created") return "warning";
    return "default";
}

function getStateRank(state: string): number {
    switch (state) {
        case "running":
            return 0;
        case "restarting":
            return 1;
        case "created":
            return 2;
        case "paused":
            return 3;
        case "exited":
            return 4;
        case "dead":
            return 5;
        default:
            return 6;
    }
}

interface DockerContainersTableProps {
    containers: DockerContainer[];
    onDetails: (containerId: string) => void;
    onLogs: (containerId: string) => void;
    onConsole: (containerId: string) => void;
    onRestart: (containerId: string) => void;
    onRestartStack: () => void;
}

export function DockerContainersTable({
    containers,
    onDetails,
    onLogs,
    onConsole,
    onRestart,
    onRestartStack,
}: DockerContainersTableProps) {
    const [sorting, setSorting] = useState<SortingState>([]);

    const columns = [
        columnHelper.accessor("name", {
            header: "Container",
            cell: (info) => {
                const container = info.row.original;
                return (
                    <div className="min-w-0">
                        <div className="text-primary-50 font-medium break-words">
                            {container.name}
                        </div>
                        <div className="text-primary-400 text-xs break-all">
                            {container.image}
                        </div>
                        <div className="text-primary-500 mt-1 flex flex-wrap gap-2 text-xs">
                            {container.service ? (
                                <span>service: {container.service}</span>
                            ) : null}
                            {container.project ? (
                                <span>project: {container.project}</span>
                            ) : null}
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
                        <div className="text-primary-400 mt-1 text-xs">
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
                        <div className="text-primary-400 mt-1 text-xs">
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
                    <div className="text-primary-300 text-xs">
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
                    <div className="text-primary-300 text-xs">
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
                    <div className="text-primary-300 text-xs break-words">
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
                    <div
                        className="flex flex-nowrap items-center gap-2"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <Button
                            size="sm"
                            variant="secondary"
                            title="Logs"
                            aria-label="Logs"
                            onClick={() => onLogs(container.id)}
                        >
                            <FileText className="h-4 w-4" />
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            title="Console"
                            aria-label="Console"
                            onClick={() => onConsole(container.id)}
                        >
                            <SquareTerminal className="h-4 w-4" />
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            title="Restart"
                            aria-label="Restart"
                            onClick={() => onRestart(container.id)}
                        >
                            <RotateCcw className="h-4 w-4" />
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

    if (containers.length === 0) {
        return (
            <Card className="overflow-hidden">
                <div className="border-primary-700 border-b px-3 py-3 text-lg font-semibold sm:px-4">
                    Containers
                </div>
                <EmptyState message="No containers found." />
            </Card>
        );
    }

    return (
        <Card className="overflow-hidden">
            <div className="border-primary-700 flex flex-col gap-3 border-b px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                <div className="text-lg font-semibold">Containers</div>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={onRestartStack}
                    className="w-full sm:w-auto"
                >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Restart stack
                </Button>
            </div>

            <div className="space-y-3 p-3 md:hidden">
                {table.getRowModel().rows.map((row) => {
                    const container = row.original;
                    return (
                        <div
                            key={row.id}
                            role="button"
                            tabIndex={0}
                            className="border-primary-700 bg-primary-900/40 hover:bg-primary-800/50 w-full rounded-lg border p-3 text-left"
                            onClick={() => onDetails(container.id)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    onDetails(container.id);
                                }
                            }}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-primary-50 font-medium break-words">
                                        {container.name}
                                    </div>
                                    <div className="text-primary-400 mt-1 text-xs break-all">
                                        {container.image}
                                    </div>
                                </div>
                                <Badge variant={getStateVariant(container.state)}>
                                    {container.state}
                                </Badge>
                            </div>
                            <div className="text-primary-300 mt-3 grid grid-cols-2 gap-2 text-xs">
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
                                <div className="text-primary-400 mt-3 text-xs break-words">
                                    Ports: {container.ports.join(", ")}
                                </div>
                            ) : null}
                            <div
                                className="mt-3 grid grid-cols-3 gap-2"
                                onClick={(event) => event.stopPropagation()}
                            >
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    aria-label={`Show logs for ${container.name}`}
                                    onClick={() => onLogs(container.id)}
                                >
                                    <FileText className="h-4 w-4" />
                                </Button>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    aria-label={`Open console for ${container.name}`}
                                    onClick={() => onConsole(container.id)}
                                >
                                    <SquareTerminal className="h-4 w-4" />
                                </Button>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    aria-label={`Restart ${container.name}`}
                                    onClick={() => onRestart(container.id)}
                                >
                                    <RotateCcw className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="hidden max-h-[520px] overflow-auto md:block">
                <table className="min-w-[900px] text-sm lg:min-w-full">
                    <thead className="bg-primary-900/95 text-primary-300 sticky top-0 z-10 text-left backdrop-blur">
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr key={headerGroup.id}>
                                {headerGroup.headers.map((header) => (
                                    <th key={header.id} className="px-4 py-3 align-top">
                                        {header.column.getCanSort() ? (
                                            <button
                                                type="button"
                                                className="hover:text-primary-100 flex items-center gap-1 select-none"
                                                onClick={header.column.getToggleSortingHandler()}
                                            >
                                                {flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext()
                                                )}
                                                <span className="text-primary-500">
                                                    {header.column.getIsSorted() ===
                                                    "asc" ? (
                                                        <ChevronDown className="h-3 w-3" />
                                                    ) : header.column.getIsSorted() ===
                                                      "desc" ? (
                                                        <ChevronDown className="h-3 w-3 rotate-180" />
                                                    ) : null}
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
                                className="border-primary-700/50 hover:bg-primary-700/30 cursor-pointer border-b"
                                onClick={() => onDetails(row.original.id)}
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
