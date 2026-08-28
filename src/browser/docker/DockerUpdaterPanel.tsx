import { ArrowUpCircle, History, Layers3, Play, RefreshCw } from "lucide-react";

import {
    type DockerUpdaterEvent,
    type DockerUpdaterService,
} from "../../contracts/docker.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import {
    dockerUpdaterPolicyLabel,
    dockerUpdaterEventVariant,
    dockerUpdaterStatusLabel,
    dockerUpdaterStatusVariant,
    humanizeDockerEventKind,
} from "./dockerPresentation.ts";

interface DockerUpdaterPanelProps {
    readonly anyUpdaterBusy: boolean;
    readonly controlsDisabled: boolean;
    readonly events: readonly DockerUpdaterEvent[];
    readonly onRun: () => void;
    readonly onScan: () => void;
    readonly onUpdateService: (service: DockerUpdaterService) => void;
    readonly requestBusy: boolean;
    readonly runBusy: boolean;
    readonly scanBusy: boolean;
    readonly serviceIsBusy: (serviceId: string) => boolean;
    readonly services: readonly DockerUpdaterService[];
}

function updaterEventIsFailure(kind: DockerUpdaterEvent["kind"]): boolean {
    switch (kind) {
        case "discovery-failed":
        case "scan-failed":
        case "update-failed":
        case "update-outcome-unknown": {
            return true;
        }
        default: {
            return false;
        }
    }
}

interface DockerUpdaterEventGroup {
    readonly atMs: number;
    readonly events: readonly DockerUpdaterEvent[];
    readonly id: string;
    readonly jobRunId?: string;
    readonly kind: DockerUpdaterEvent["kind"];
}

function groupedUpdaterEvents(
    events: readonly DockerUpdaterEvent[]
): readonly DockerUpdaterEventGroup[] {
    const groups = new Map<string, DockerUpdaterEvent[]>();
    for (const event of events) {
        const identity = event.jobRunId ?? event.id;
        groups.set(identity, [...(groups.get(identity) ?? []), event]);
    }
    return [...groups.entries()].map(([id, grouped]) => {
        const failure = grouped.find(({ kind }) => updaterEventIsFailure(kind));
        const kind =
            failure?.kind ??
            grouped.find(({ kind: candidate }) => candidate === "update-succeeded")
                ?.kind ??
            grouped.find(({ kind: candidate }) => candidate === "update-available")
                ?.kind ??
            grouped[0]!.kind;
        return {
            atMs: Math.max(...grouped.map(({ atMs }) => atMs)),
            events: grouped,
            id,
            ...(grouped[0]?.jobRunId === undefined
                ? {}
                : { jobRunId: grouped[0].jobRunId }),
            kind,
        };
    });
}

/** @returns Complete updater policy/status inventory, controls, and bounded history. */
export function DockerUpdaterPanel({
    anyUpdaterBusy,
    controlsDisabled,
    events,
    onRun,
    onScan,
    onUpdateService,
    requestBusy,
    runBusy,
    scanBusy,
    serviceIsBusy,
    services,
}: DockerUpdaterPanelProps) {
    const updateServices = services.filter(
        ({ status }) => status.state === "update-available"
    );
    const updateCount = updateServices.length;
    const unavailableCount = services.filter(
        ({ status }) => status.state === "unavailable"
    ).length;
    const notCheckedCount = services.filter(
        ({ status }) => status.state === "not-checked"
    ).length;
    const inventoryOnlyCount = services.filter(
        ({ policy }) => policy.state === "inventory-only"
    ).length;
    const automaticCount = services.filter(
        ({ policy }) => policy.state === "managed" && policy.automatic
    ).length;
    const notifyCount = services.filter(
        ({ policy }) => policy.state === "managed" && !policy.automatic
    ).length;
    const eventGroups = groupedUpdaterEvents(events);
    const recentFailureCount = eventGroups.filter(({ events: grouped }) =>
        grouped.some(({ kind }) => updaterEventIsFailure(kind))
    ).length;

    return (
        <Card aria-labelledby="docker-updater-heading" className="min-w-0">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                        <Icon icon={RefreshCw} tone="accent" />
                        <Heading id="docker-updater-heading" level={2}>
                            Updater
                        </Heading>
                    </div>
                    <Text className="mt-1" tone="muted">
                        Compose-owned service inventory, registry candidates, and recent
                        updater outcomes.
                    </Text>
                </div>
                <div className="grid w-full grid-cols-1 gap-2 min-[28rem]:grid-cols-2 lg:flex lg:w-auto">
                    <Button
                        aria-label="Scan Docker services for updates"
                        busy={scanBusy}
                        busyLabel="Scanning…"
                        className="w-full lg:w-auto"
                        disabled={controlsDisabled || requestBusy || anyUpdaterBusy}
                        onClick={onScan}
                        size="sm"
                        variant="secondary"
                    >
                        <Icon icon={RefreshCw} size="sm" />
                        Scan for updates
                    </Button>
                    <Button
                        aria-label="Run all available Docker updates"
                        busy={runBusy}
                        busyLabel="Running updates…"
                        className="w-full lg:w-auto"
                        disabled={controlsDisabled || requestBusy || anyUpdaterBusy}
                        onClick={onRun}
                        size="sm"
                    >
                        <Icon icon={Play} size="sm" />
                        Run updates
                    </Button>
                </div>
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div className="border-primary-700 bg-primary-900/35 rounded-lg border p-3">
                    <dt className="text-primary-400 text-sm">Services</dt>
                    <dd className="text-primary-50 mt-1 text-2xl font-semibold tabular-nums">
                        {services.length}
                    </dd>
                </div>
                <div className="border-primary-700 bg-primary-900/35 rounded-lg border p-3">
                    <dt className="text-primary-400 text-sm">Updates available</dt>
                    <dd className="mt-1 text-2xl font-semibold text-amber-200 tabular-nums">
                        {updateCount}
                    </dd>
                </div>
                <div className="border-primary-700 bg-primary-900/35 rounded-lg border p-3">
                    <dt className="text-primary-400 text-sm">Automatic</dt>
                    <dd className="text-primary-50 mt-1 text-2xl font-semibold tabular-nums">
                        {automaticCount}
                    </dd>
                </div>
                <div className="border-primary-700 bg-primary-900/35 rounded-lg border p-3">
                    <dt className="text-primary-400 text-sm">Notify / manual</dt>
                    <dd className="text-primary-50 mt-1 text-2xl font-semibold tabular-nums">
                        {notifyCount}
                    </dd>
                </div>
                <div className="border-primary-700 bg-primary-900/35 rounded-lg border p-3">
                    <dt className="text-primary-400 text-sm">Recent failures</dt>
                    <dd className="mt-1 text-2xl font-semibold text-red-300 tabular-nums">
                        {recentFailureCount}
                    </dd>
                </div>
                <div className="border-primary-700 bg-primary-900/35 rounded-lg border p-3">
                    <dt className="text-primary-400 text-sm">Registry unavailable</dt>
                    <dd className="text-primary-50 mt-1 text-2xl font-semibold tabular-nums">
                        {unavailableCount}
                    </dd>
                </div>
                <div className="border-primary-700 bg-primary-900/35 rounded-lg border p-3">
                    <dt className="text-primary-400 text-sm">Not checked</dt>
                    <dd className="text-primary-50 mt-1 text-2xl font-semibold tabular-nums">
                        {notCheckedCount}
                    </dd>
                </div>
                <div className="border-primary-700 bg-primary-900/35 rounded-lg border p-3">
                    <dt className="text-primary-400 text-sm">Inventory only</dt>
                    <dd className="text-primary-50 mt-1 text-2xl font-semibold tabular-nums">
                        {inventoryOnlyCount}
                    </dd>
                </div>
            </dl>

            <div className="mt-6 grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
                <section
                    aria-labelledby="docker-updater-services-heading"
                    className="min-w-0"
                >
                    <div className="flex items-center gap-2">
                        <Icon icon={Layers3} tone="accent" />
                        <Heading
                            id="docker-updater-services-heading"
                            level={3}
                            size="subsection"
                        >
                            Services
                        </Heading>
                    </div>
                    {updateServices.length === 0 ? (
                        <Text className="mt-3" tone="muted">
                            No services currently have updates available.
                        </Text>
                    ) : (
                        <div className="mt-3 space-y-3">
                            {updateServices.map((service) => {
                                const canUpdate =
                                    service.policy.state === "managed" &&
                                    service.status.state === "update-available";
                                const serviceBusy = serviceIsBusy(service.id);
                                return (
                                    <section
                                        aria-label={
                                            service.project + " " + service.service
                                        }
                                        className="border-primary-700 bg-primary-900/30 rounded-lg border p-4"
                                        key={service.id}
                                    >
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                            <div className="min-w-0">
                                                <Heading level={3} size="subsection">
                                                    {service.project} / {service.service}
                                                </Heading>
                                                <div className="mt-2 flex flex-wrap gap-2">
                                                    <Badge
                                                        variant={dockerUpdaterStatusVariant(
                                                            service.status
                                                        )}
                                                    >
                                                        {dockerUpdaterStatusLabel(
                                                            service.status
                                                        )}
                                                    </Badge>
                                                    <Badge
                                                        variant={
                                                            service.policy.state ===
                                                            "managed"
                                                                ? "info"
                                                                : "default"
                                                        }
                                                    >
                                                        {dockerUpdaterPolicyLabel(
                                                            service.policy
                                                        )}
                                                    </Badge>
                                                </div>
                                            </div>
                                            <Button
                                                aria-label={
                                                    "Update Docker service " +
                                                    service.project +
                                                    " " +
                                                    service.service
                                                }
                                                busy={serviceBusy}
                                                busyLabel="Updating…"
                                                disabled={
                                                    controlsDisabled ||
                                                    requestBusy ||
                                                    anyUpdaterBusy ||
                                                    !canUpdate
                                                }
                                                onClick={() => onUpdateService(service)}
                                                size="sm"
                                            >
                                                <Icon icon={ArrowUpCircle} size="sm" />
                                                Update service
                                            </Button>
                                        </div>
                                        <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                                            <div>
                                                <dt className="text-primary-400">
                                                    Current image
                                                </dt>
                                                <dd className="text-primary-200 mt-1 font-mono wrap-anywhere">
                                                    {service.currentImage}
                                                </dd>
                                            </div>
                                            <div>
                                                <dt className="text-primary-400">
                                                    Candidate image
                                                </dt>
                                                <dd className="text-primary-200 mt-1 font-mono wrap-anywhere">
                                                    {service.status.state ===
                                                    "update-available"
                                                        ? service.status.candidateImage
                                                        : "None confirmed"}
                                                </dd>
                                            </div>
                                        </dl>
                                        <code className="text-primary-400 mt-2 block text-xs wrap-anywhere">
                                            {service.id}
                                        </code>
                                    </section>
                                );
                            })}
                        </div>
                    )}
                </section>

                <section
                    aria-labelledby="docker-updater-events-heading"
                    className="min-w-0"
                >
                    <div className="flex items-center gap-2">
                        <Icon icon={History} size="sm" tone="accent" />
                        <Heading
                            id="docker-updater-events-heading"
                            level={3}
                            size="subsection"
                        >
                            Recent events
                        </Heading>
                    </div>
                    {eventGroups.length === 0 ? (
                        <Text className="mt-3" tone="muted">
                            No updater events are available.
                        </Text>
                    ) : (
                        <ol className="mt-3 max-h-160 space-y-3 overflow-y-auto pr-1">
                            {eventGroups.map((group) => (
                                <li
                                    className="border-primary-700 bg-primary-900/30 rounded-lg border p-3"
                                    key={group.id}
                                >
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                        <Badge
                                            variant={dockerUpdaterEventVariant(
                                                group.kind
                                            )}
                                        >
                                            {group.jobRunId === undefined
                                                ? humanizeDockerEventKind(group.kind)
                                                : "Updater run"}
                                        </Badge>
                                        <time
                                            className="text-primary-400 text-xs"
                                            dateTime={new Date(group.atMs).toISOString()}
                                        >
                                            {formatDashboardDateTime(group.atMs)}
                                        </time>
                                    </div>
                                    {group.events.length === 1 ? (
                                        <Text className="mt-2 wrap-anywhere" size="sm">
                                            {group.events[0]!.summary}
                                        </Text>
                                    ) : (
                                        <ul className="text-primary-200 mt-2 space-y-1 text-sm">
                                            {group.events.map((event) => (
                                                <li
                                                    className="wrap-anywhere"
                                                    key={event.id}
                                                >
                                                    {event.summary}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                    {group.jobRunId !== undefined && (
                                        <ActionLink
                                            className="text-accent-300 hover:text-accent-200 mt-2 block text-xs font-medium wrap-anywhere"
                                            search={{ runId: group.jobRunId }}
                                            to="/jobs"
                                        >
                                            Open job {group.jobRunId}
                                        </ActionLink>
                                    )}
                                </li>
                            ))}
                        </ol>
                    )}
                </section>
            </div>
        </Card>
    );
}
