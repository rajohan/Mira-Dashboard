import { useNavigate } from "@tanstack/react-router";
import { Boxes, FileText, Play, RotateCw, Square, SquareTerminal } from "lucide-react";
import { useState } from "react";

import type { DockerContainer } from "../../contracts/docker.ts";
import { cn } from "../lib/classNames.ts";
import { formatByteCount, formatPercent } from "../lib/formatMeasurements.ts";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { dashboardDataTableClassNames } from "../ui/dataTableStyles.ts";
import { DropdownMenu } from "../ui/DropdownMenu.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { SearchInput } from "../ui/SearchInput.tsx";
import { TableSortButton } from "../ui/TableSortButton.tsx";
import { nextTableSortDirection } from "../ui/tableSortState.ts";
import { Text } from "../ui/Text.tsx";
import {
    type DockerContainerSort,
    type DockerContainerSortField,
    dockerContainerHealthVariant,
    dockerContainerIsActive,
    dockerContainerMatchesSearch,
    dockerContainerStateVariant,
    formatDockerContainerRuntime,
    formatDockerPort,
    sortDockerContainers,
} from "./dockerPresentation.ts";

type ContainerOperation = "container-restart" | "container-start" | "container-stop";
type StackOperation = "stack-restart" | "stack-start" | "stack-stop";

interface SortHeaderProps {
    readonly field: DockerContainerSortField;
    readonly label: string;
    readonly onSort: (field: DockerContainerSortField) => void;
    readonly sort: DockerContainerSort | null;
}

function SortHeader({ field, label, onSort, sort }: SortHeaderProps) {
    const active = sort?.field === field;
    const direction = active ? sort.direction : false;
    const nextDirection = nextTableSortDirection(direction);
    return (
        <th
            aria-sort={active ? sort.direction : "none"}
            className="text-primary-300 border-primary-700 bg-primary-950 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
            scope="col"
        >
            <TableSortButton
                accessibleLabel={`Sort by ${label} ${nextDirection}`}
                direction={direction}
                onClick={() => onSort(field)}
            >
                {label}
            </TableSortButton>
        </th>
    );
}

interface DockerContainersTableProps {
    readonly busy: boolean;
    readonly containers: readonly DockerContainer[];
    readonly controlsDisabled: boolean;
    readonly observedAtMs: number;
    readonly onOpenDetails: (container: DockerContainer) => void;
    readonly onOpenLogs: (container: DockerContainer) => void;
    readonly onRequestOperation: (
        operation: ContainerOperation,
        container: DockerContainer
    ) => void;
    readonly onRequestStackOperation: (operation: StackOperation) => void;
}

function containerCanStart(container: DockerContainer): boolean {
    return ["created", "exited"].includes(container.state);
}

function containerCanStop(container: DockerContainer): boolean {
    return dockerContainerIsActive(container);
}

function containerCanRestart(container: DockerContainer): boolean {
    return dockerContainerIsActive(container);
}

interface ContainerActionMenuProps {
    readonly busy: DockerContainersTableProps["busy"];
    readonly container: DockerContainer;
    readonly controlsDisabled: DockerContainersTableProps["controlsDisabled"];
    readonly onOpenConsole: (container: DockerContainer) => void;
    readonly onOpenLogs: DockerContainersTableProps["onOpenLogs"];
    readonly onRequestOperation: DockerContainersTableProps["onRequestOperation"];
}

function ContainerActionMenu({
    busy,
    container,
    controlsDisabled,
    onOpenConsole,
    onOpenLogs,
    onRequestOperation,
}: ContainerActionMenuProps) {
    const lifecycleAction = containerCanStop(container)
        ? {
              description: "Stop this container.",
              disabled: controlsDisabled || busy,
              icon: Square,
              id: "stop",
              label: "Stop",
              onSelect: (trigger: HTMLButtonElement) => {
                  trigger.focus();
                  onRequestOperation("container-stop", container);
              },
              tone: "danger" as const,
          }
        : {
              description: "Start this container.",
              disabled: controlsDisabled || busy || !containerCanStart(container),
              icon: Play,
              id: "start",
              label: "Start",
              onSelect: (trigger: HTMLButtonElement) => {
                  trigger.focus();
                  onRequestOperation("container-start", container);
              },
          };

    return (
        <DropdownMenu
            actions={[
                {
                    description: "Read a bounded redacted tail of the container logs.",
                    disabled: controlsDisabled,
                    icon: FileText,
                    id: "logs",
                    label: "Logs",
                    onSelect: (trigger) => {
                        trigger.focus();
                        onOpenLogs(container);
                    },
                },
                {
                    description: "Open an interactive /bin/sh session in Terminal.",
                    disabled: controlsDisabled || container.state !== "running",
                    icon: SquareTerminal,
                    id: "console",
                    label: "Console",
                    onSelect: () => onOpenConsole(container),
                },
                lifecycleAction,
                {
                    description: "Restart this container.",
                    disabled: controlsDisabled || busy || !containerCanRestart(container),
                    icon: RotateCw,
                    id: "restart",
                    label: "Restart",
                    onSelect: (trigger) => {
                        trigger.focus();
                        onRequestOperation("container-restart", container);
                    },
                    tone: "danger",
                },
            ]}
            triggerLabel={`Actions for ${container.name}`}
        />
    );
}

interface StackActionMenuProps {
    readonly busy: boolean;
    readonly controlsDisabled: boolean;
    readonly onRequestStackOperation: (operation: StackOperation) => void;
}

function StackActionMenu({
    busy,
    controlsDisabled,
    onRequestStackOperation,
}: StackActionMenuProps) {
    const disabled = controlsDisabled || busy;
    return (
        <DropdownMenu
            actions={[
                {
                    description: "Start the discovered root Compose stack.",
                    disabled,
                    icon: Play,
                    id: "stack-start",
                    label: "Start stack",
                    onSelect: (trigger) => {
                        trigger.focus();
                        onRequestStackOperation("stack-start");
                    },
                },
                {
                    description: "Stop the discovered root Compose stack.",
                    disabled,
                    icon: Square,
                    id: "stack-stop",
                    label: "Stop stack",
                    onSelect: (trigger) => {
                        trigger.focus();
                        onRequestStackOperation("stack-stop");
                    },
                    tone: "danger",
                },
                {
                    description: "Restart the discovered root Compose stack.",
                    disabled,
                    icon: RotateCw,
                    id: "stack-restart",
                    label: "Restart stack",
                    onSelect: (trigger) => {
                        trigger.focus();
                        onRequestStackOperation("stack-restart");
                    },
                    tone: "danger",
                },
            ]}
            disabled={disabled}
            triggerLabel="Docker stack actions"
        />
    );
}

function ContainerIdentity({ container }: { readonly container: DockerContainer }) {
    return (
        <div className="min-w-0">
            <div className="text-primary-50 font-medium wrap-anywhere">
                {container.name}
            </div>
            <div className="text-primary-400 mt-1 text-xs wrap-anywhere">
                {container.image}
            </div>
            {(container.project !== undefined || container.service !== undefined) && (
                <div className="text-primary-400 mt-1 flex flex-wrap gap-2 text-xs">
                    {container.service !== undefined && (
                        <span>service: {container.service}</span>
                    )}
                    {container.project !== undefined && (
                        <span>project: {container.project}</span>
                    )}
                </div>
            )}
        </div>
    );
}

interface DockerContainerMobileCardProps extends ContainerActionMenuProps {
    readonly observedAtMs: DockerContainersTableProps["observedAtMs"];
    readonly onOpenDetails: DockerContainersTableProps["onOpenDetails"];
}

function DockerContainerMobileCard({
    busy,
    container,
    controlsDisabled,
    observedAtMs,
    onOpenConsole,
    onOpenDetails,
    onOpenLogs,
    onRequestOperation,
}: DockerContainerMobileCardProps) {
    return (
        <li
            aria-label={`${container.name} container`}
            className="border-primary-700 bg-primary-950/40 relative rounded-lg border p-3 shadow-sm shadow-black/10"
        >
            <button
                aria-label={`Open details for ${container.name}`}
                className="hover:bg-primary-800/50 focus-visible:ring-accent-400 absolute inset-0 z-0 cursor-pointer rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
                onClick={() => onOpenDetails(container)}
                type="button"
            />
            <div className="pointer-events-none relative z-10">
                <div className="flex items-start justify-between gap-3">
                    <ContainerIdentity container={container} />
                    <div className="pointer-events-auto shrink-0">
                        <ContainerActionMenu
                            busy={busy}
                            container={container}
                            controlsDisabled={controlsDisabled}
                            onOpenConsole={onOpenConsole}
                            onOpenLogs={onOpenLogs}
                            onRequestOperation={onRequestOperation}
                        />
                    </div>
                </div>

                <dl className="text-primary-400 mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                    <div className="min-w-0">
                        <dt className="text-primary-400">State</dt>
                        <dd className="mt-1">
                            <Badge variant={dockerContainerStateVariant(container.state)}>
                                {container.state}
                            </Badge>
                            <span className="mt-1 block tabular-nums">
                                {formatDockerContainerRuntime(container, observedAtMs)}
                            </span>
                        </dd>
                    </div>
                    <div className="min-w-0">
                        <dt className="text-primary-400">Health</dt>
                        <dd className="mt-1">
                            <Badge
                                variant={dockerContainerHealthVariant(container.health)}
                            >
                                {container.health === "none"
                                    ? "No health check"
                                    : container.health}
                            </Badge>
                            <span className="mt-1 block tabular-nums">
                                {container.restartCount} restarts
                            </span>
                        </dd>
                    </div>
                    <div>
                        <dt className="text-primary-400">CPU</dt>
                        <dd className="text-primary-200 mt-1 tabular-nums">
                            {container.stats === undefined
                                ? "Unavailable"
                                : formatPercent(container.stats.cpuPercent)}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-primary-400">Memory</dt>
                        <dd className="text-primary-200 mt-1 tabular-nums">
                            {container.stats === undefined
                                ? "Unavailable"
                                : formatByteCount(container.stats.memoryUsedBytes)}
                        </dd>
                    </div>
                </dl>

                {container.ports.length > 0 && (
                    <div className="text-primary-400 mt-3 text-xs wrap-anywhere">
                        <span className="text-primary-400">Ports: </span>
                        {container.ports.map(formatDockerPort).join(", ")}
                    </div>
                )}
            </div>
        </li>
    );
}

function containerRowTargetIsInteractive(target: EventTarget | null): boolean {
    return (
        target instanceof Element &&
        target.closest("a, button, input, select, textarea") !== null
    );
}

function TableLabel({ children }: { readonly children: string }) {
    return (
        <span aria-hidden="true" className={dashboardDataTableClassNames.label}>
            {children}
        </span>
    );
}

/** @returns Searchable and accessible exact-container inventory and controls. */
export function DockerContainersTable({
    busy,
    containers,
    controlsDisabled,
    observedAtMs,
    onOpenDetails,
    onOpenLogs,
    onRequestOperation,
    onRequestStackOperation,
}: DockerContainersTableProps) {
    const navigate = useNavigate({ from: "/docker" });
    const [search, setSearch] = useState("");
    const [sort, setSort] = useState<DockerContainerSort | null>(null);
    const filteredContainers = containers.filter((container) =>
        dockerContainerMatchesSearch(container, search)
    );
    const visibleContainers =
        sort === null
            ? filteredContainers
            : sortDockerContainers(filteredContainers, sort);

    function toggleSort(field: DockerContainerSortField): void {
        setSort((current) => {
            if (current?.field !== field) return { direction: "ascending", field };
            if (current.direction === "ascending") {
                return { direction: "descending", field };
            }
            return null;
        });
    }

    function openConsole(container: DockerContainer): void {
        void navigate({
            search: { dockerContainerId: container.id },
            to: "/terminal",
        });
    }

    return (
        <Card aria-labelledby="docker-containers-heading" className="min-w-0 p-0">
            <div className="border-primary-700 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-4 border-b p-5 xl:grid-cols-[minmax(0,1fr)_24rem_auto] xl:items-end">
                <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                        <Icon icon={Boxes} tone="accent" />
                        <Heading id="docker-containers-heading" level={2}>
                            Containers
                        </Heading>
                    </div>
                    <Text className="mt-1" tone="muted">
                        Engine state, health, live statistics, published ports, and exact
                        container controls.
                    </Text>
                </div>
                <SearchInput
                    className="col-span-2 row-start-2 w-full xl:col-span-1 xl:col-start-2 xl:row-start-1 xl:w-96"
                    label="Search Docker containers"
                    onChange={setSearch}
                    placeholder="Search containers"
                    value={search}
                />
                <div className="col-start-2 row-start-1 xl:col-start-3 xl:self-end xl:pb-1">
                    <StackActionMenu
                        busy={busy}
                        controlsDisabled={controlsDisabled}
                        onRequestStackOperation={onRequestStackOperation}
                    />
                </div>
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
                <div
                    className={cn(
                        dashboardDataTableClassNames.queryContainer,
                        "p-3 sm:p-5"
                    )}
                >
                    <ul
                        aria-label="Docker containers"
                        className="space-y-3 @min-[66rem]:hidden"
                    >
                        {visibleContainers.map((container) => (
                            <DockerContainerMobileCard
                                busy={busy}
                                container={container}
                                controlsDisabled={controlsDisabled}
                                key={container.id}
                                observedAtMs={observedAtMs}
                                onOpenConsole={openConsole}
                                onOpenDetails={onOpenDetails}
                                onOpenLogs={onOpenLogs}
                                onRequestOperation={onRequestOperation}
                            />
                        ))}
                    </ul>
                    <section
                        aria-label="Docker containers"
                        className={cn(
                            dashboardDataTableClassNames.scrollContainer,
                            "hidden overflow-x-auto overscroll-x-contain @min-[66rem]:block"
                        )}
                    >
                        <table
                            aria-label="Docker containers"
                            className={cn(
                                dashboardDataTableClassNames.table,
                                "min-w-288"
                            )}
                        >
                            <thead className={dashboardDataTableClassNames.head}>
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
                                        className="text-primary-300 border-primary-700 bg-primary-950 border-b px-3 py-2 text-center text-xs font-semibold tracking-wide uppercase"
                                        scope="col"
                                    >
                                        Actions
                                    </th>
                                </tr>
                            </thead>
                            <tbody className={dashboardDataTableClassNames.body}>
                                {visibleContainers.map((container) => (
                                    <tr
                                        aria-label={`Open details for ${container.name}`}
                                        className={cn(
                                            dashboardDataTableClassNames.row,
                                            "hover:bg-primary-700/30 focus-visible:bg-primary-700/30 focus-visible:ring-accent-400 cursor-pointer transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
                                        )}
                                        key={container.id}
                                        onClick={(event) => {
                                            if (
                                                containerRowTargetIsInteractive(
                                                    event.target
                                                )
                                            ) {
                                                return;
                                            }
                                            event.currentTarget.focus();
                                            onOpenDetails(container);
                                        }}
                                        onKeyDown={(event) => {
                                            if (
                                                event.target !== event.currentTarget ||
                                                ![" ", "Enter"].includes(event.key)
                                            ) {
                                                return;
                                            }
                                            event.preventDefault();
                                            onOpenDetails(container);
                                        }}
                                        tabIndex={0}
                                    >
                                        <td className={dashboardDataTableClassNames.cell}>
                                            <TableLabel>Container</TableLabel>
                                            <div
                                                className={
                                                    dashboardDataTableClassNames.value
                                                }
                                            >
                                                <ContainerIdentity
                                                    container={container}
                                                />
                                            </div>
                                        </td>
                                        <td className={dashboardDataTableClassNames.cell}>
                                            <TableLabel>State</TableLabel>
                                            <span
                                                className={
                                                    dashboardDataTableClassNames.value
                                                }
                                            >
                                                <Badge
                                                    variant={dockerContainerStateVariant(
                                                        container.state
                                                    )}
                                                >
                                                    {container.state}
                                                </Badge>
                                                <span className="text-primary-400 mt-2 block text-xs tabular-nums">
                                                    {formatDockerContainerRuntime(
                                                        container,
                                                        observedAtMs
                                                    )}
                                                </span>
                                            </span>
                                        </td>
                                        <td className={dashboardDataTableClassNames.cell}>
                                            <TableLabel>Health</TableLabel>
                                            <span
                                                className={
                                                    dashboardDataTableClassNames.value
                                                }
                                            >
                                                <Badge
                                                    variant={dockerContainerHealthVariant(
                                                        container.health
                                                    )}
                                                >
                                                    {container.health === "none"
                                                        ? "No health check"
                                                        : container.health}
                                                </Badge>
                                                <span className="text-primary-400 mt-2 block text-xs tabular-nums">
                                                    restarts: {container.restartCount}
                                                </span>
                                            </span>
                                        </td>
                                        <td className={dashboardDataTableClassNames.cell}>
                                            <TableLabel>CPU</TableLabel>
                                            <span
                                                className={cn(
                                                    dashboardDataTableClassNames.value,
                                                    "text-primary-200 tabular-nums"
                                                )}
                                            >
                                                {container.stats === undefined
                                                    ? "Unavailable"
                                                    : formatPercent(
                                                          container.stats.cpuPercent
                                                      )}
                                            </span>
                                        </td>
                                        <td className={dashboardDataTableClassNames.cell}>
                                            <TableLabel>Memory</TableLabel>
                                            <span
                                                className={cn(
                                                    dashboardDataTableClassNames.value,
                                                    "text-primary-200 tabular-nums"
                                                )}
                                            >
                                                {container.stats === undefined
                                                    ? "Unavailable"
                                                    : formatByteCount(
                                                          container.stats.memoryUsedBytes
                                                      )}
                                            </span>
                                        </td>
                                        <td className={dashboardDataTableClassNames.cell}>
                                            <TableLabel>I/O and processes</TableLabel>
                                            <span
                                                className={cn(
                                                    dashboardDataTableClassNames.value,
                                                    "text-primary-300 block text-xs tabular-nums"
                                                )}
                                            >
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
                                        <td className={dashboardDataTableClassNames.cell}>
                                            <TableLabel>Ports</TableLabel>
                                            <div
                                                className={cn(
                                                    dashboardDataTableClassNames.value,
                                                    "text-primary-300 text-xs"
                                                )}
                                            >
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
                                        <td className={dashboardDataTableClassNames.cell}>
                                            <TableLabel>Actions</TableLabel>
                                            <div
                                                className={cn(
                                                    dashboardDataTableClassNames.value,
                                                    "flex justify-center"
                                                )}
                                            >
                                                <ContainerActionMenu
                                                    busy={busy}
                                                    container={container}
                                                    controlsDisabled={controlsDisabled}
                                                    onOpenConsole={openConsole}
                                                    onOpenLogs={onOpenLogs}
                                                    onRequestOperation={
                                                        onRequestOperation
                                                    }
                                                />
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
