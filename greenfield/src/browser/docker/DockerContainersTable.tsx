import {
    ArrowDown,
    ArrowUp,
    ArrowUpDown,
    FileText,
    Info,
    Play,
    RotateCw,
    Square,
    SquareTerminal,
} from "lucide-react";
import { useState } from "react";

import type { DockerContainer } from "../../contracts/docker.ts";
import { formatByteCount, formatPercent } from "../lib/formatMeasurements.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { buttonClassNames } from "../ui/buttonStyles.ts";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { SearchInput } from "../ui/SearchInput.tsx";
import { Text } from "../ui/Text.tsx";
import {
    type DockerContainerSort,
    type DockerContainerSortField,
    defaultDockerContainerSort,
    dockerContainerHealthVariant,
    dockerContainerMatchesSearch,
    dockerContainerStateVariant,
    formatDockerMemory,
    formatDockerPort,
    sortDockerContainers,
} from "./dockerPresentation.ts";

type ContainerOperation = "container-restart" | "container-start" | "container-stop";

interface SortHeaderProps {
    readonly field: DockerContainerSortField;
    readonly label: string;
    readonly onSort: (field: DockerContainerSortField) => void;
    readonly sort: DockerContainerSort;
}

function SortHeader({ field, label, onSort, sort }: SortHeaderProps) {
    const active = sort.field === field;
    const nextDirection =
        active && sort.direction === "ascending" ? "descending" : "ascending";
    let SortIcon = ArrowUpDown;
    if (active) SortIcon = sort.direction === "ascending" ? ArrowUp : ArrowDown;
    return (
        <th
            aria-sort={active ? sort.direction : "none"}
            className="text-primary-300 border-primary-700 bg-primary-950 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
            scope="col"
        >
            <button
                aria-label={"Sort by " + label + " " + nextDirection}
                className="hover:text-primary-50 focus-visible:ring-accent-300 inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-2"
                onClick={() => onSort(field)}
                type="button"
            >
                {label}
                <Icon icon={SortIcon} size="sm" tone="inherit" />
            </button>
        </th>
    );
}

interface DockerContainersTableProps {
    readonly busy: boolean;
    readonly containers: readonly DockerContainer[];
    readonly controlsDisabled: boolean;
    readonly onOpenDetails: (container: DockerContainer) => void;
    readonly onOpenLogs: (container: DockerContainer) => void;
    readonly onRequestOperation: (
        operation: ContainerOperation,
        container: DockerContainer
    ) => void;
}

function containerCanStart(container: DockerContainer): boolean {
    return !["paused", "restarting", "running"].includes(container.state);
}

function containerCanStop(container: DockerContainer): boolean {
    return ["paused", "restarting", "running"].includes(container.state);
}

function containerCanRestart(container: DockerContainer): boolean {
    return ["paused", "restarting", "running"].includes(container.state);
}

function TableLabel({ children }: { readonly children: string }) {
    return (
        <span aria-hidden="true" className="dashboard-data-table-label text-primary-400">
            {children}
        </span>
    );
}

/** @returns Searchable and accessible exact-container inventory and controls. */
export function DockerContainersTable({
    busy,
    containers,
    controlsDisabled,
    onOpenDetails,
    onOpenLogs,
    onRequestOperation,
}: DockerContainersTableProps) {
    const [search, setSearch] = useState("");
    const [sort, setSort] = useState<DockerContainerSort>(defaultDockerContainerSort);
    const visibleContainers = sortDockerContainers(
        containers.filter((container) => dockerContainerMatchesSearch(container, search)),
        sort
    );

    function toggleSort(field: DockerContainerSortField): void {
        setSort((current) => ({
            direction:
                current.field === field && current.direction === "ascending"
                    ? "descending"
                    : "ascending",
            field,
        }));
    }

    return (
        <Card aria-labelledby="docker-containers-heading" className="min-w-0 p-0">
            <div className="border-primary-700 flex flex-col gap-4 border-b p-5 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <Heading id="docker-containers-heading" level={2}>
                        Containers
                    </Heading>
                    <Text className="mt-1" tone="muted">
                        Engine state, health, live statistics, published ports, and exact
                        container controls.
                    </Text>
                </div>
                <SearchInput
                    className="w-full sm:max-w-sm"
                    label="Search Docker containers"
                    onChange={setSearch}
                    placeholder="Name, image, service, state, or port"
                    value={search}
                />
            </div>
            {visibleContainers.length === 0 ? (
                <div className="p-8 text-center">
                    <Text tone="muted">
                        {containers.length === 0
                            ? "No containers were discovered."
                            : "No containers match this search."}
                    </Text>
                </div>
            ) : (
                <div className="dashboard-data-table-query-container w-full max-w-full min-w-0 p-5">
                    <section
                        aria-label="Docker containers"
                        className="dashboard-data-table-container border-primary-700 w-full max-w-full min-w-0 overflow-x-auto overscroll-x-contain rounded-lg border"
                    >
                        <table
                            aria-label="Docker containers"
                            className="dashboard-data-table w-full min-w-320 border-separate border-spacing-0"
                        >
                            <thead className="dashboard-data-table-head bg-primary-950 sticky top-0 z-20 shadow-sm">
                                <tr>
                                    <SortHeader
                                        field="name"
                                        label="Container"
                                        onSort={toggleSort}
                                        sort={sort}
                                    />
                                    <SortHeader
                                        field="state"
                                        label="State"
                                        onSort={toggleSort}
                                        sort={sort}
                                    />
                                    <SortHeader
                                        field="health"
                                        label="Health"
                                        onSort={toggleSort}
                                        sort={sort}
                                    />
                                    <SortHeader
                                        field="cpu"
                                        label="CPU"
                                        onSort={toggleSort}
                                        sort={sort}
                                    />
                                    <SortHeader
                                        field="memory"
                                        label="Memory"
                                        onSort={toggleSort}
                                        sort={sort}
                                    />
                                    <th
                                        className="text-primary-300 border-primary-700 bg-primary-950 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                        scope="col"
                                    >
                                        I/O and processes
                                    </th>
                                    <th
                                        className="text-primary-300 border-primary-700 bg-primary-950 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                        scope="col"
                                    >
                                        Ports
                                    </th>
                                    <th
                                        className="text-primary-300 border-primary-700 bg-primary-950 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                        scope="col"
                                    >
                                        Actions
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="dashboard-data-table-body">
                                {visibleContainers.map((container) => (
                                    <tr
                                        className="dashboard-data-table-row border-primary-700 border-b text-sm"
                                        key={container.id}
                                    >
                                        <td className="dashboard-data-table-cell min-w-0 p-3">
                                            <TableLabel>Container</TableLabel>
                                            <div className="dashboard-data-table-value min-w-0">
                                                <div className="text-primary-50 font-medium wrap-anywhere">
                                                    {container.name}
                                                </div>
                                                <div className="text-primary-400 mt-1 text-xs wrap-anywhere">
                                                    {container.image}
                                                </div>
                                                {(container.project !== undefined ||
                                                    container.service !== undefined) && (
                                                    <div className="text-primary-400 mt-1 text-xs wrap-anywhere">
                                                        {container.project} /{" "}
                                                        {container.service}
                                                    </div>
                                                )}
                                                <code
                                                    className="text-primary-500 mt-1 block text-xs wrap-anywhere"
                                                    title={container.id}
                                                >
                                                    {container.id.slice(0, 12)}
                                                </code>
                                            </div>
                                        </td>
                                        <td className="dashboard-data-table-cell min-w-0 p-3">
                                            <TableLabel>State</TableLabel>
                                            <span className="dashboard-data-table-value">
                                                <Badge
                                                    variant={dockerContainerStateVariant(
                                                        container.state
                                                    )}
                                                >
                                                    {container.state}
                                                </Badge>
                                                <span className="text-primary-400 mt-2 block text-xs tabular-nums">
                                                    {container.restartCount} restarts
                                                </span>
                                            </span>
                                        </td>
                                        <td className="dashboard-data-table-cell min-w-0 p-3">
                                            <TableLabel>Health</TableLabel>
                                            <span className="dashboard-data-table-value">
                                                <Badge
                                                    variant={dockerContainerHealthVariant(
                                                        container.health
                                                    )}
                                                >
                                                    {container.health === "none"
                                                        ? "No health check"
                                                        : container.health}
                                                </Badge>
                                            </span>
                                        </td>
                                        <td className="dashboard-data-table-cell min-w-0 p-3">
                                            <TableLabel>CPU</TableLabel>
                                            <span className="dashboard-data-table-value text-primary-200 tabular-nums">
                                                {container.stats === undefined
                                                    ? "Unavailable"
                                                    : formatPercent(
                                                          container.stats.cpuPercent
                                                      )}
                                            </span>
                                        </td>
                                        <td className="dashboard-data-table-cell min-w-0 p-3">
                                            <TableLabel>Memory</TableLabel>
                                            <span className="dashboard-data-table-value text-primary-200 tabular-nums">
                                                {formatDockerMemory(container)}
                                            </span>
                                        </td>
                                        <td className="dashboard-data-table-cell min-w-0 p-3">
                                            <TableLabel>I/O and processes</TableLabel>
                                            <span className="dashboard-data-table-value text-primary-300 block text-xs tabular-nums">
                                                {container.stats === undefined ? (
                                                    "Unavailable"
                                                ) : (
                                                    <>
                                                        <span className="block">
                                                            Network ↓{" "}
                                                            {formatByteCount(
                                                                container.stats
                                                                    .networkReceivedBytes
                                                            )}{" "}
                                                            · ↑{" "}
                                                            {formatByteCount(
                                                                container.stats
                                                                    .networkSentBytes
                                                            )}
                                                        </span>
                                                        <span className="mt-1 block">
                                                            Block ↓{" "}
                                                            {formatByteCount(
                                                                container.stats
                                                                    .blockReadBytes
                                                            )}{" "}
                                                            · ↑{" "}
                                                            {formatByteCount(
                                                                container.stats
                                                                    .blockWrittenBytes
                                                            )}
                                                        </span>
                                                        <span className="mt-1 block">
                                                            {container.stats.pids}{" "}
                                                            processes
                                                        </span>
                                                    </>
                                                )}
                                            </span>
                                        </td>
                                        <td className="dashboard-data-table-cell min-w-0 p-3">
                                            <TableLabel>Ports</TableLabel>
                                            <div className="dashboard-data-table-value text-primary-300 text-xs">
                                                {container.ports.length === 0 ? (
                                                    "None published"
                                                ) : (
                                                    <ul className="space-y-1">
                                                        {container.ports.map((port) => (
                                                            <li
                                                                className="font-mono wrap-anywhere"
                                                                key={formatDockerPort(
                                                                    port
                                                                )}
                                                            >
                                                                {formatDockerPort(port)}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </div>
                                        </td>
                                        <td className="dashboard-data-table-cell min-w-0 p-3">
                                            <TableLabel>Actions</TableLabel>
                                            <div className="dashboard-data-table-value flex min-w-52 flex-wrap gap-2">
                                                <Button
                                                    aria-label={
                                                        "Show details for " +
                                                        container.name
                                                    }
                                                    onClick={() =>
                                                        onOpenDetails(container)
                                                    }
                                                    size="sm"
                                                    variant="secondary"
                                                >
                                                    <Icon icon={Info} size="sm" />
                                                    Details
                                                </Button>
                                                <Button
                                                    aria-label={
                                                        "Show logs for " + container.name
                                                    }
                                                    disabled={controlsDisabled}
                                                    onClick={() => onOpenLogs(container)}
                                                    size="sm"
                                                    variant="secondary"
                                                >
                                                    <Icon icon={FileText} size="sm" />
                                                    Logs
                                                </Button>
                                                {!controlsDisabled &&
                                                container.state === "running" ? (
                                                    <a
                                                        aria-label={
                                                            "Open console for " +
                                                            container.name
                                                        }
                                                        className={buttonClassNames({
                                                            size: "sm",
                                                            variant: "secondary",
                                                        })}
                                                        href={
                                                            "/terminal?dockerContainerId=" +
                                                            encodeURIComponent(
                                                                container.id
                                                            )
                                                        }
                                                    >
                                                        <Icon
                                                            icon={SquareTerminal}
                                                            size="sm"
                                                        />
                                                        Console
                                                    </a>
                                                ) : null}
                                                <Button
                                                    aria-label={"Start " + container.name}
                                                    disabled={
                                                        controlsDisabled ||
                                                        busy ||
                                                        !containerCanStart(container)
                                                    }
                                                    onClick={() =>
                                                        onRequestOperation(
                                                            "container-start",
                                                            container
                                                        )
                                                    }
                                                    size="sm"
                                                    variant="secondary"
                                                >
                                                    <Icon icon={Play} size="sm" />
                                                    Start
                                                </Button>
                                                <Button
                                                    aria-label={"Stop " + container.name}
                                                    disabled={
                                                        controlsDisabled ||
                                                        busy ||
                                                        !containerCanStop(container)
                                                    }
                                                    onClick={() =>
                                                        onRequestOperation(
                                                            "container-stop",
                                                            container
                                                        )
                                                    }
                                                    size="sm"
                                                    variant="secondary"
                                                >
                                                    <Icon icon={Square} size="sm" />
                                                    Stop
                                                </Button>
                                                <Button
                                                    aria-label={
                                                        "Restart " + container.name
                                                    }
                                                    disabled={
                                                        controlsDisabled ||
                                                        busy ||
                                                        !containerCanRestart(container)
                                                    }
                                                    onClick={() =>
                                                        onRequestOperation(
                                                            "container-restart",
                                                            container
                                                        )
                                                    }
                                                    size="sm"
                                                    variant="secondary"
                                                >
                                                    <Icon icon={RotateCw} size="sm" />
                                                    Restart
                                                </Button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </section>
                </div>
            )}
        </Card>
    );
}
