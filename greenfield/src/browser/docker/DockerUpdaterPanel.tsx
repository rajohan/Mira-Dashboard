import { ArrowUpCircle, History, Play, RefreshCw } from "lucide-react";

import {
    dockerUpdaterEventMaximum,
    type DockerUpdaterEvent,
    type DockerUpdaterService,
} from "../../contracts/docker.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import {
    dockerUpdaterPolicyLabel,
    dockerUpdaterStatusLabel,
    dockerUpdaterStatusVariant,
    humanizeDockerEventKind,
} from "./dockerPresentation.ts";

interface DockerUpdaterPanelProps {
    readonly busy: boolean;
    readonly controlsDisabled: boolean;
    readonly events: readonly DockerUpdaterEvent[];
    readonly onRun: () => void;
    readonly onScan: () => void;
    readonly onUpdateService: (service: DockerUpdaterService) => void;
    readonly services: readonly DockerUpdaterService[];
}

function updaterEventVariant(
    kind: DockerUpdaterEvent["kind"]
): "danger" | "default" | "warning" {
    if (kind.includes("failed") || kind === "update-outcome-unknown") return "danger";
    if (kind === "update-available") return "warning";
    return "default";
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

/** @returns Complete updater policy/status inventory, controls, and bounded history. */
export function DockerUpdaterPanel({
    busy,
    controlsDisabled,
    events,
    onRun,
    onScan,
    onUpdateService,
    services,
}: DockerUpdaterPanelProps) {
    const updateCount = services.filter(
        ({ status }) => status.state === "update-available"
    ).length;
    const unavailableCount = services.filter(
        ({ status }) => status.state === "unavailable"
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
    const recentFailureCount = events.filter(({ kind }) =>
        updaterEventIsFailure(kind)
    ).length;

    return (
        <Card aria-labelledby="docker-updater-heading" className="min-w-0">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <Heading id="docker-updater-heading" level={2}>
                        Updater
                    </Heading>
                    <Text className="mt-1" tone="muted">
                        Compose-owned service inventory, registry candidates, and recent
                        updater outcomes.
                    </Text>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button
                        aria-label="Scan Docker services for updates"
                        disabled={controlsDisabled || busy}
                        onClick={onScan}
                        size="sm"
                        variant="secondary"
                    >
                        <Icon icon={RefreshCw} size="sm" />
                        Scan for updates
                    </Button>
                    <Button
                        aria-label="Run automatic Docker updates"
                        disabled={controlsDisabled || busy}
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
                    <Heading
                        id="docker-updater-services-heading"
                        level={3}
                        size="subsection"
                    >
                        Services
                    </Heading>
                    {services.length === 0 ? (
                        <Text className="mt-3" tone="muted">
                            No Compose updater services were discovered.
                        </Text>
                    ) : (
                        <div className="mt-3 space-y-3">
                            {services.map((service) => {
                                const canUpdate =
                                    service.policy.state === "managed" &&
                                    service.status.state === "update-available";
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
                                                disabled={
                                                    controlsDisabled || busy || !canUpdate
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
                                                <dt className="text-primary-500">
                                                    Current image
                                                </dt>
                                                <dd className="text-primary-200 mt-1 font-mono wrap-anywhere">
                                                    {service.currentImage}
                                                </dd>
                                            </div>
                                            <div>
                                                <dt className="text-primary-500">
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
                                        <code className="text-primary-600 mt-2 block text-xs wrap-anywhere">
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
                    <Text className="mt-1" size="sm" tone="muted">
                        {events.length} shown · bounded to {dockerUpdaterEventMaximum}
                    </Text>
                    {events.length === 0 ? (
                        <Text className="mt-3" tone="muted">
                            No updater events are available.
                        </Text>
                    ) : (
                        <ol className="mt-3 max-h-160 space-y-3 overflow-y-auto pr-1">
                            {events.map((event) => (
                                <li
                                    className="border-primary-700 bg-primary-900/30 rounded-lg border p-3"
                                    key={event.id}
                                >
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                        <Badge variant={updaterEventVariant(event.kind)}>
                                            {humanizeDockerEventKind(event.kind)}
                                        </Badge>
                                        <time
                                            className="text-primary-500 text-xs"
                                            dateTime={new Date(event.atMs).toISOString()}
                                        >
                                            {formatDashboardDateTime(event.atMs)}
                                        </time>
                                    </div>
                                    <Text className="mt-2 wrap-anywhere" size="sm">
                                        {event.summary}
                                    </Text>
                                    {event.jobRunId !== undefined && (
                                        <a
                                            className="text-accent-300 hover:text-accent-200 mt-2 block text-xs font-medium wrap-anywhere"
                                            href={
                                                "/jobs?runId=" +
                                                encodeURIComponent(event.jobRunId)
                                            }
                                        >
                                            Open job {event.jobRunId}
                                        </a>
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
