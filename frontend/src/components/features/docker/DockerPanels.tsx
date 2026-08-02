import { Boxes } from "lucide-react";

import type {
    DockerContainer,
    DockerContainerDetails,
} from "../../../../../contracts/docker/inventory";
import type {
    DockerUpdaterEvent,
    DockerUpdaterService,
} from "../../../../../contracts/docker/updater";
import { messageFromError } from "../../../lib/errorMessage";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { LoadingState } from "../../ui/LoadingState";
import { DockerContainersTable } from "./DockerContainersTable";
import {
    formatDockerMemory,
    formatFullVersionDisplay,
    formatTimestamp,
    formatUpdaterTransition,
    formatVersionDisplay,
} from "./dockerFormatters";

export function DockerUpdaterServicesPanel({
    isLoading,
    isManualUpdatePending,
    isReadOnly,
    onSelectManualUpdate,
    services,
}: {
    isLoading: boolean;
    isManualUpdatePending: boolean;
    isReadOnly: boolean;
    onSelectManualUpdate: (service: { id: number; label: string }) => void;
    services: DockerUpdaterService[];
}) {
    if (isLoading) {
        return <LoadingState message="Loading updater services..." size="md" />;
    }
    if (services.length === 0) {
        return <EmptyState message="No pending updater candidates right now." />;
    }
    return (
        <div className="space-y-3">
            {services.map((service) => (
                <Card key={service.id} className="p-3 sm:p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                            <div className="font-medium wrap-break-word text-primary-50">
                                {service.serviceName}
                            </div>
                            <div className="mt-1 text-xs break-all text-primary-400">
                                {service.imageRepo}
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                            <div className="rounded-full bg-amber-500/15 px-2 py-1 text-xs text-amber-300">
                                {service.policy}
                            </div>
                            <Button
                                size="sm"
                                onClick={() =>
                                    onSelectManualUpdate({
                                        id: service.id,
                                        label: service.serviceName,
                                    })
                                }
                                disabled={isReadOnly || isManualUpdatePending}
                                className="w-full sm:w-auto"
                            >
                                Update now
                            </Button>
                        </div>
                    </div>
                    <div className="mt-3 grid gap-2 text-xs text-primary-300 md:grid-cols-2">
                        <div
                            className="min-w-0 break-all"
                            title={formatFullVersionDisplay(
                                service.currentTag,
                                service.currentDigest
                            )}
                        >
                            Current:{" "}
                            {formatVersionDisplay(
                                service.currentTag,
                                service.currentDigest
                            )}
                        </div>
                        <div
                            className="min-w-0 break-all"
                            title={formatFullVersionDisplay(
                                service.latestTag,
                                service.latestDigest
                            )}
                        >
                            Candidate:{" "}
                            {formatVersionDisplay(
                                service.latestTag,
                                service.latestDigest
                            )}
                        </div>
                        <div>Last checked: {formatTimestamp(service.lastCheckedAt)}</div>
                        <div>Status: {service.lastStatus || "—"}</div>
                    </div>
                </Card>
            ))}
        </div>
    );
}

export function DockerUpdaterEventsPanel({
    events,
    isLoading,
}: {
    events: DockerUpdaterEvent[];
    isLoading: boolean;
}) {
    if (isLoading) {
        return <LoadingState message="Loading updater history..." size="md" />;
    }
    if (events.length === 0) {
        return <EmptyState message="No updater events yet." />;
    }
    return (
        <div className="space-y-3">
            {events.slice(0, 20).map((event) => (
                <Card key={event.id} className="p-3 sm:p-4">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                        <div className="font-medium wrap-break-word text-primary-50">
                            {event.serviceName}
                        </div>
                        <div className="shrink-0 text-xs text-primary-500">
                            {formatTimestamp(event.createdAt)}
                        </div>
                    </div>
                    <div className="mt-1 text-xs tracking-wide text-primary-400 uppercase">
                        {event.eventType}
                    </div>
                    <div
                        className="mt-2 font-mono text-xs break-all text-primary-300"
                        title={`${formatFullVersionDisplay(event.fromTag, event.fromDigest)} → ${formatFullVersionDisplay(event.toTag, event.toDigest)}`}
                    >
                        {formatUpdaterTransition(event)}
                    </div>
                </Card>
            ))}
        </div>
    );
}

export function DockerContainersPanel({
    containers,
    error,
    isError,
    isReadOnly,
    onConsole,
    onDetails,
    onLogs,
    onRestart,
    onRestartStack,
}: {
    containers: DockerContainer[];
    error: unknown;
    isError: boolean;
    isReadOnly: boolean;
    onConsole: (containerId: string) => void;
    onDetails: (containerId: string) => void;
    onLogs: (containerId: string) => void;
    onRestart: (containerId: string) => void;
    onRestartStack: () => void;
}) {
    if (isError && containers.length === 0) {
        return (
            <Card className="overflow-hidden">
                <div className="border-b border-primary-700 p-3 text-lg font-semibold sm:px-4">
                    Containers
                </div>
                <EmptyState message="Failed to load containers. Try refresh.">
                    <div className="mt-3 text-xs text-red-400">
                        {messageFromError(error, "Unknown container query error")}
                    </div>
                </EmptyState>
            </Card>
        );
    }
    if (containers.length === 0) {
        return (
            <Card className="overflow-hidden">
                <div className="border-b border-primary-700 p-3 text-lg font-semibold sm:px-4">
                    Containers
                </div>
                <EmptyState message="No containers found.">
                    <div className="mt-3 flex justify-center text-primary-500">
                        <Boxes className="size-6" />
                    </div>
                </EmptyState>
            </Card>
        );
    }
    return (
        <DockerContainersTable
            containers={containers}
            isReadOnly={isReadOnly}
            onDetails={onDetails}
            onLogs={onLogs}
            onConsole={onConsole}
            onRestart={onRestart}
            onRestartStack={onRestartStack}
        />
    );
}

export function DockerContainerDetailsPanel({
    containerDetails,
    isLoading,
}: {
    containerDetails: DockerContainerDetails | undefined;
    isLoading: boolean;
}) {
    if (isLoading) {
        return <LoadingState message="Loading container details..." size="md" />;
    }
    if (containerDetails === undefined) {
        return <EmptyState message="Failed to load container details." />;
    }
    return (
        <div className="space-y-3 text-sm sm:space-y-4">
            <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
                <Card className="p-3 sm:p-4">
                    <div className="mb-2 font-semibold">Runtime</div>
                    <div>Created: {formatTimestamp(containerDetails.createdAt)}</div>
                    <div>Started: {formatTimestamp(containerDetails.startedAt)}</div>
                    <div>Status: {containerDetails.status}</div>
                </Card>
                <Card className="p-3 sm:p-4">
                    <div className="mb-2 font-semibold">Resources</div>
                    <div>CPU: {containerDetails.stats?.cpu || "—"}</div>
                    <div>
                        Memory: {formatDockerMemory(containerDetails.stats?.memory)}
                    </div>
                    <div>Net I/O: {containerDetails.stats?.netIO || "—"}</div>
                    <div>Block I/O: {containerDetails.stats?.blockIO || "—"}</div>
                </Card>
            </div>

            <Card className="p-3 sm:p-4">
                <div className="mb-2 font-semibold">Networks</div>
                <div className="space-y-2 text-xs text-primary-300">
                    {containerDetails.networks.map((network) => (
                        <div
                            key={network.name}
                            className="rounded bg-primary-900/50 p-2 break-all"
                        >
                            <div className="font-medium text-primary-100">
                                {network.name}
                            </div>
                            <div>IP: {network.ipAddress || "—"}</div>
                            <div>Gateway: {network.gateway || "—"}</div>
                            <div>MAC: {network.macAddress || "—"}</div>
                        </div>
                    ))}
                </div>
            </Card>

            <Card className="p-3 sm:p-4">
                <div className="mb-2 font-semibold">Mounts</div>
                <div className="space-y-2 text-xs text-primary-300">
                    {containerDetails.mounts.map((mount) => (
                        <div
                            key={`${mount.source}:${mount.destination}`}
                            className="rounded bg-primary-900/50 p-2 break-all"
                        >
                            <div>{mount.source}</div>
                            <div className="text-primary-500">→ {mount.destination}</div>
                            <div>
                                {mount.type} · {mount.mode || "default"} ·{" "}
                                {mount.readOnly ? "ro" : "rw"}
                            </div>
                        </div>
                    ))}
                </div>
            </Card>
        </div>
    );
}
