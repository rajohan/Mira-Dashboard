import { Boxes, History, RefreshCw } from "lucide-react";
import { useState } from "react";

import { DockerContainersTable } from "../components/features/docker/DockerContainersTable";
import { DockerImagesTable } from "../components/features/docker/DockerImagesTable";
import { DockerVolumesTable } from "../components/features/docker/DockerVolumesTable";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { LoadingState } from "../components/ui/LoadingState";
import { Modal } from "../components/ui/Modal";
import { RefreshButton } from "../components/ui/RefreshButton";
import { Select } from "../components/ui/Select";
import {
    startDockerExec,
    stopDockerExec,
    useDeleteDockerImage,
    useDeleteDockerVolume,
    useDockerAction,
    useDockerContainer,
    useDockerContainerLogs,
    useDockerContainers,
    useDockerExecJob,
    useDockerImages,
    useDockerManualUpdate,
    useDockerPrune,
    useDockerUpdaterEvents,
    useRunDockerUpdater,
    useDockerUpdaterServices,
    useDockerVolumes,
} from "../hooks/useDocker";
import { formatDate } from "../utils/format";

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

function formatDockerMemory(value: string | undefined): string {
    if (!value) {
        return "—";
    }

    const [usedRaw, totalRaw] = value.split("/").map((part) => part.trim());
    if (!usedRaw || !totalRaw) {
        return value;
    }

    const parsePart = (part: string): number | null => {
        const match = part.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]i?B|B)$/i);
        if (!match) {
            return null;
        }

        const amount = Number.parseFloat(match[1] || "0");
        const unit = (match[2] || "B").toUpperCase();
        const factors: Record<string, number> = {
            B: 1,
            KIB: 1024,
            KB: 1024,
            MIB: 1024 ** 2,
            MB: 1024 ** 2,
            GIB: 1024 ** 3,
            GB: 1024 ** 3,
            TIB: 1024 ** 4,
            TB: 1024 ** 4,
        };

        return amount * (factors[unit] || 1);
    };

    const usedBytes = parsePart(usedRaw);
    const totalBytes = parsePart(totalRaw);

    if (!usedBytes || !totalBytes) {
        return value;
    }

    return `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`;
}

function formatTimestamp(value: string | null | undefined): string {
    if (!value) {
        return "—";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return formatDate(date);
}

function formatUpdaterTransition(event: {
    fromTag: string | null;
    toTag: string | null;
    fromDigest: string | null;
    toDigest: string | null;
}): string {
    const from = formatVersionDisplay(event.fromTag, event.fromDigest);
    const to = formatVersionDisplay(event.toTag, event.toDigest);
    return `${from} → ${to}`;
}

function formatVersionDisplay(tag: string | null, digest: string | null): string {
    if (tag) {
        return tag;
    }

    if (digest) {
        return digest.slice(0, 12);
    }

    return "—";
}

function formatFullVersionDisplay(tag: string | null, digest: string | null): string {
    if (tag && digest) {
        return `${tag} (${digest})`;
    }

    if (tag) {
        return tag;
    }

    if (digest) {
        return digest;
    }

    return "—";
}

export function Docker() {
    const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);
    const [logsContainerId, setLogsContainerId] = useState<string | null>(null);
    const [consoleContainerId, setConsoleContainerId] = useState<string | null>(null);
    const [logsTail, setLogsTail] = useState(200);
    const [consoleCommand, setConsoleCommand] = useState("");
    const [consoleJobId, setConsoleJobId] = useState<string | null>(null);
    const [dangerousDelete, setDangerousDelete] = useState<
        | null
        | { type: "image"; id: string; label: string }
        | { type: "volume"; id: string; label: string }
    >(null);
    const [manualUpdateTarget, setManualUpdateTarget] = useState<{
        id: number;
        label: string;
    } | null>(null);
    const [actionOutput, setActionOutput] = useState<string>("");
    const [pruningTarget, setPruningTarget] = useState<"images" | "volumes" | null>(null);

    const containersQuery = useDockerContainers();
    const imagesQuery = useDockerImages();
    const volumesQuery = useDockerVolumes();
    const containerDetailsQuery = useDockerContainer(selectedContainerId);
    const logsQuery = useDockerContainerLogs(
        logsContainerId,
        logsTail,
        Boolean(logsContainerId)
    );
    const execJobQuery = useDockerExecJob(consoleJobId);
    const updaterServicesQuery = useDockerUpdaterServices();
    const updaterEventsQuery = useDockerUpdaterEvents(25);

    const dockerAction = useDockerAction();
    const deleteImage = useDeleteDockerImage();
    const deleteVolume = useDeleteDockerVolume();
    const dockerPrune = useDockerPrune();
    const dockerManualUpdate = useDockerManualUpdate();
    const runDockerUpdater = useRunDockerUpdater();

    const containers = containersQuery.data || [];
    const images = imagesQuery.data || [];
    const volumes = volumesQuery.data || [];
    const isInitialLoading =
        containersQuery.isLoading || imagesQuery.isLoading || volumesQuery.isLoading;

    const selectedContainer =
        containers.find((container) => container.id === selectedContainerId) || null;
    const selectedLogsContainer =
        containers.find((container) => container.id === logsContainerId) || null;
    const selectedConsoleContainer =
        containers.find((container) => container.id === consoleContainerId) || null;

    const summary = {
        running: containers.filter((container) => container.state === "running").length,
        unhealthy: containers.filter((container) => container.health === "unhealthy")
            .length,
        composeManaged: containers.filter((container) => container.service).length,
        totalImageSize: images.reduce((sum, image) => sum + image.size, 0),
    };

    const updaterServices = updaterServicesQuery.data?.services || [];
    const updaterSummary = updaterServicesQuery.data?.summary;
    const updaterEvents = updaterEventsQuery.data || [];
    const servicesWithUpdates = updaterServices.filter(
        (service) => service.updateAvailable
    );

    async function handleContainerAction(
        containerId: string,
        action: "start" | "stop" | "restart" | "update"
    ) {
        const result = await dockerAction.mutateAsync({ containerId, action });
        setActionOutput(result.output || "Done");
    }

    async function handleStackRestart(service?: string) {
        const response = await fetch("/api/docker/stack/action", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ action: "restart", service }),
        });
        const result = (await response.json()) as { output?: string; error?: string };
        if (!response.ok) {
            throw new Error(result.error || "Failed to restart stack");
        }
        setActionOutput(result.output || "Done");
    }

    async function handleManualUpdate(serviceId: number) {
        const result = await dockerManualUpdate.mutateAsync(serviceId);
        const updatedCount = result.result?.summary?.updated ?? 0;
        const failedCount = result.result?.summary?.failed ?? 0;
        setActionOutput(
            `Manual updater run finished. updated=${updatedCount} failed=${failedCount}` +
                (result.stderr ? `\n\n${result.stderr}` : "")
        );
    }

    async function handleStartConsole(containerId: string) {
        const result = await startDockerExec(containerId, consoleCommand);
        setConsoleJobId(result.jobId);
    }

    if (isInitialLoading) {
        return <LoadingState message="Loading Docker overview..." size="lg" />;
    }

    return (
        <div className="space-y-6 p-6">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Running containers</div>
                    <div className="mt-2 text-3xl font-semibold">{summary.running}</div>
                </Card>
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Unhealthy</div>
                    <div className="mt-2 text-3xl font-semibold text-red-400">
                        {summary.unhealthy}
                    </div>
                </Card>
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Compose managed</div>
                    <div className="mt-2 text-3xl font-semibold">
                        {summary.composeManaged}
                    </div>
                </Card>
                <Card className="p-4">
                    <div className="text-sm text-primary-400">Images size</div>
                    <div className="mt-2 text-3xl font-semibold">
                        {formatBytes(summary.totalImageSize)}
                    </div>
                </Card>
            </div>

            {actionOutput ? (
                <Card className="p-4">
                    <pre className="overflow-auto rounded-lg bg-black/40 p-3 text-xs text-primary-100">
                        {actionOutput}
                    </pre>
                </Card>
            ) : null}

            {runDockerUpdater.data ? (
                <Card className="p-4">
                    <div className="mb-2 text-sm font-semibold text-primary-100">
                        Last updater run
                    </div>
                    <pre className="overflow-auto rounded-lg bg-black/40 p-3 text-xs text-primary-100">
                        {JSON.stringify(runDockerUpdater.data, null, 2)}
                    </pre>
                </Card>
            ) : null}

            <Card className="overflow-hidden">
                <div className="border-b border-primary-700 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-lg font-semibold">Updater overview</div>
                            <div className="text-xs text-primary-400">
                                Registry poll state from n8n, plus recent updater history.
                            </div>
                        </div>
                        <Button
                            size="sm"
                            onClick={() => runDockerUpdater.mutate()}
                            disabled={runDockerUpdater.isPending}
                        >
                            {runDockerUpdater.isPending
                                ? "Running..."
                                : "Run updater now"}
                        </Button>
                    </div>
                </div>
                <div className="grid gap-4 border-b border-primary-700 px-4 py-4 md:grid-cols-2 xl:grid-cols-5">
                    <Card className="p-4">
                        <div className="text-sm text-primary-400">Tracked services</div>
                        <div className="mt-2 text-2xl font-semibold">
                            {updaterSummary?.total ?? "—"}
                        </div>
                    </Card>
                    <Card className="p-4">
                        <div className="text-sm text-primary-400">Updates available</div>
                        <div className="mt-2 text-2xl font-semibold text-amber-300">
                            {updaterSummary?.updateAvailable ?? "—"}
                        </div>
                    </Card>
                    <Card className="p-4">
                        <div className="text-sm text-primary-400">Auto policy</div>
                        <div className="mt-2 text-2xl font-semibold">
                            {updaterSummary?.autoPolicy ?? "—"}
                        </div>
                    </Card>
                    <Card className="p-4">
                        <div className="text-sm text-primary-400">Notify policy</div>
                        <div className="mt-2 text-2xl font-semibold">
                            {updaterSummary?.notifyPolicy ?? "—"}
                        </div>
                    </Card>
                    <Card className="p-4">
                        <div className="text-sm text-primary-400">Recent failures</div>
                        <div className="mt-2 text-2xl font-semibold text-red-400">
                            {updaterSummary?.failed ?? "—"}
                        </div>
                    </Card>
                </div>
                <div className="grid gap-6 px-4 py-4 xl:grid-cols-[1.3fr_1fr]">
                    <div>
                        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-primary-100">
                            <RefreshCw className="h-4 w-4 text-accent-400" />
                            Pending or newer candidates
                        </div>
                        <div className="max-h-[400px] overflow-y-auto pr-2">
                            {updaterServicesQuery.isLoading ? (
                                <LoadingState
                                    message="Loading updater services..."
                                    size="md"
                                />
                            ) : servicesWithUpdates.length === 0 ? (
                                <EmptyState message="No pending updater candidates right now." />
                            ) : (
                                <div className="space-y-3">
                                    {servicesWithUpdates.map((service) => (
                                        <Card key={service.id} className="p-4">
                                            <div className="flex items-start justify-between gap-3">
                                                <div>
                                                    <div className="font-medium text-primary-50">
                                                        {service.serviceName}
                                                    </div>
                                                    <div className="mt-1 text-xs text-primary-400">
                                                        {service.imageRepo}
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <div className="rounded-full bg-amber-500/15 px-2 py-1 text-xs text-amber-300">
                                                        {service.policy}
                                                    </div>
                                                    <Button
                                                        size="sm"
                                                        onClick={() =>
                                                            setManualUpdateTarget({
                                                                id: service.id,
                                                                label: service.serviceName,
                                                            })
                                                        }
                                                        disabled={
                                                            dockerManualUpdate.isPending
                                                        }
                                                    >
                                                        Update now
                                                    </Button>
                                                </div>
                                            </div>
                                            <div className="mt-3 grid gap-2 text-xs text-primary-300 md:grid-cols-2">
                                                <div
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
                                                <div>
                                                    Last checked:{" "}
                                                    {formatTimestamp(
                                                        service.lastCheckedAt
                                                    )}
                                                </div>
                                                <div>
                                                    Status: {service.lastStatus || "—"}
                                                </div>
                                            </div>
                                        </Card>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                    <div>
                        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-primary-100">
                            <History className="h-4 w-4 text-accent-400" />
                            Recent updater events
                        </div>
                        <div className="max-h-[400px] overflow-y-auto pr-2">
                            {updaterEventsQuery.isLoading ? (
                                <LoadingState
                                    message="Loading updater history..."
                                    size="md"
                                />
                            ) : updaterEvents.length === 0 ? (
                                <EmptyState message="No updater events yet." />
                            ) : (
                                <div className="space-y-3">
                                    {updaterEvents.slice(0, 20).map((event) => (
                                        <Card key={event.id} className="p-4">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="font-medium text-primary-50">
                                                    {event.serviceName}
                                                </div>
                                                <div className="text-xs text-primary-500">
                                                    {formatTimestamp(event.createdAt)}
                                                </div>
                                            </div>
                                            <div className="mt-1 text-xs uppercase tracking-wide text-primary-400">
                                                {event.eventType}
                                            </div>
                                            <div
                                                className="mt-2 font-mono text-xs text-primary-300"
                                                title={`${formatFullVersionDisplay(event.fromTag, event.fromDigest)} → ${formatFullVersionDisplay(event.toTag, event.toDigest)}`}
                                            >
                                                {formatUpdaterTransition(event)}
                                            </div>
                                        </Card>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </Card>

            {containersQuery.isError && containers.length === 0 ? (
                <Card className="overflow-hidden">
                    <div className="border-b border-primary-700 px-4 py-3 text-lg font-semibold">
                        Containers
                    </div>
                    <EmptyState message="Failed to load containers. Try refresh.">
                        <div className="mt-3 text-xs text-red-400">
                            {containersQuery.error instanceof Error
                                ? containersQuery.error.message
                                : "Unknown container query error"}
                        </div>
                    </EmptyState>
                </Card>
            ) : containers.length === 0 ? (
                <Card className="overflow-hidden">
                    <div className="border-b border-primary-700 px-4 py-3 text-lg font-semibold">
                        Containers
                    </div>
                    <EmptyState message="No containers found.">
                        <div className="mt-3 flex justify-center text-primary-500">
                            <Boxes className="h-6 w-6" />
                        </div>
                    </EmptyState>
                </Card>
            ) : (
                <DockerContainersTable
                    containers={containers}
                    onDetails={setSelectedContainerId}
                    onLogs={setLogsContainerId}
                    onConsole={(containerId) => {
                        setConsoleContainerId(containerId);
                        setConsoleJobId(null);
                    }}
                    onRestart={(containerId) => {
                        void handleContainerAction(containerId, "restart");
                    }}
                    onRestartStack={() => {
                        void handleStackRestart();
                    }}
                />
            )}

            <div className="grid gap-6 xl:grid-cols-2">
                <DockerImagesTable
                    images={images}
                    isPruning={pruningTarget === "images" && dockerPrune.isPending}
                    onDelete={(imageId, label) =>
                        setDangerousDelete({
                            type: "image",
                            id: imageId,
                            label,
                        })
                    }
                    onPruneUnused={() => {
                        setPruningTarget("images");
                        void dockerPrune
                            .mutateAsync("images")
                            .then((result) => {
                                setActionOutput(result.output || "Unused images removed");
                            })
                            .finally(() => {
                                setPruningTarget(null);
                            });
                    }}
                />

                <DockerVolumesTable
                    volumes={volumes}
                    isPruning={pruningTarget === "volumes" && dockerPrune.isPending}
                    onDelete={(volumeName) =>
                        setDangerousDelete({
                            type: "volume",
                            id: volumeName,
                            label: volumeName,
                        })
                    }
                    onPruneUnused={() => {
                        setPruningTarget("volumes");
                        void dockerPrune
                            .mutateAsync("volumes")
                            .then((result) => {
                                setActionOutput(
                                    result.output || "Unused volumes removed"
                                );
                            })
                            .finally(() => {
                                setPruningTarget(null);
                            });
                    }}
                />
            </div>

            <Modal
                isOpen={Boolean(selectedContainerId)}
                onClose={() => setSelectedContainerId(null)}
                title={selectedContainer?.name || "Container details"}
                size="3xl"
            >
                {containerDetailsQuery.isLoading ? (
                    <LoadingState message="Loading container details..." size="md" />
                ) : containerDetailsQuery.data ? (
                    <div className="space-y-4 text-sm">
                        <div className="grid gap-4 md:grid-cols-2">
                            <Card className="p-4">
                                <div className="mb-2 font-semibold">Runtime</div>
                                <div>
                                    Created:{" "}
                                    {formatTimestamp(
                                        containerDetailsQuery.data.createdAt
                                    )}
                                </div>
                                <div>
                                    Started:{" "}
                                    {formatTimestamp(
                                        containerDetailsQuery.data.startedAt
                                    )}
                                </div>
                                <div>Status: {containerDetailsQuery.data.status}</div>
                            </Card>
                            <Card className="p-4">
                                <div className="mb-2 font-semibold">Resources</div>
                                <div>
                                    CPU: {containerDetailsQuery.data.stats?.cpu || "—"}
                                </div>
                                <div>
                                    Memory:{" "}
                                    {formatDockerMemory(
                                        containerDetailsQuery.data.stats?.memory
                                    )}
                                </div>
                                <div>
                                    Net I/O:{" "}
                                    {containerDetailsQuery.data.stats?.netIO || "—"}
                                </div>
                                <div>
                                    Block I/O:{" "}
                                    {containerDetailsQuery.data.stats?.blockIO || "—"}
                                </div>
                            </Card>
                        </div>

                        <Card className="p-4">
                            <div className="mb-2 font-semibold">Networks</div>
                            <div className="space-y-2 text-xs text-primary-300">
                                {containerDetailsQuery.data.networks.map((network) => (
                                    <div
                                        key={network.name}
                                        className="rounded bg-primary-900/50 p-2"
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

                        <Card className="p-4">
                            <div className="mb-2 font-semibold">Mounts</div>
                            <div className="space-y-2 text-xs text-primary-300">
                                {containerDetailsQuery.data.mounts.map((mount) => (
                                    <div
                                        key={`${mount.source}:${mount.destination}`}
                                        className="rounded bg-primary-900/50 p-2"
                                    >
                                        <div>{mount.source}</div>
                                        <div className="text-primary-500">
                                            → {mount.destination}
                                        </div>
                                        <div>
                                            {mount.type} · {mount.mode || "default"} ·{" "}
                                            {mount.readOnly ? "ro" : "rw"}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    </div>
                ) : (
                    <EmptyState message="Failed to load container details." />
                )}
            </Modal>

            <Modal
                isOpen={Boolean(logsContainerId)}
                onClose={() => setLogsContainerId(null)}
                title={
                    selectedLogsContainer
                        ? `${selectedLogsContainer.name} logs`
                        : "Container logs"
                }
                size="3xl"
            >
                <div className="mb-4 flex items-center gap-3">
                    <Select
                        value={String(logsTail)}
                        onChange={(value) => setLogsTail(Number(value))}
                        options={[
                            { value: "100", label: "100 lines" },
                            { value: "200", label: "200 lines" },
                            { value: "500", label: "500 lines" },
                            { value: "1000", label: "1000 lines" },
                        ]}
                    />
                    <RefreshButton
                        onClick={() => void logsQuery.refetch()}
                        isLoading={logsQuery.isFetching}
                    />
                </div>
                <pre className="max-h-[70vh] overflow-auto rounded-lg bg-black p-4 text-xs text-primary-100">
                    {logsQuery.data || "No logs"}
                </pre>
            </Modal>

            <Modal
                isOpen={Boolean(consoleContainerId)}
                onClose={() => {
                    setConsoleContainerId(null);
                    setConsoleJobId(null);
                }}
                title={
                    selectedConsoleContainer
                        ? `${selectedConsoleContainer.name} console`
                        : "Container console"
                }
                size="3xl"
            >
                <div className="mb-4 flex items-center gap-3">
                    <Input
                        value={consoleCommand}
                        onChange={(event: any) => setConsoleCommand(event.target.value)}
                        placeholder="Command to run inside container"
                        className="flex-1"
                    />
                    <Button
                        onClick={() =>
                            selectedConsoleContainer
                                ? void handleStartConsole(selectedConsoleContainer.id)
                                : undefined
                        }
                        disabled={!selectedConsoleContainer || !consoleCommand.trim()}
                    >
                        Run
                    </Button>
                    {consoleJobId && execJobQuery.data?.status === "running" ? (
                        <Button
                            variant="danger"
                            onClick={() => void stopDockerExec(consoleJobId)}
                        >
                            Stop
                        </Button>
                    ) : null}
                </div>
                <pre className="max-h-[70vh] overflow-auto rounded-lg bg-black p-4 text-xs text-primary-100">
                    {execJobQuery.data
                        ? `${execJobQuery.data.stdout}${execJobQuery.data.stderr ? `\n${execJobQuery.data.stderr}` : ""}`
                        : "Run a command to see output."}
                </pre>
            </Modal>

            <ConfirmModal
                isOpen={Boolean(dangerousDelete)}
                onCancel={() => {
                    if (deleteImage.isPending || deleteVolume.isPending) {
                        return;
                    }
                    setDangerousDelete(null);
                }}
                title={
                    dangerousDelete?.type === "image" ? "Delete image" : "Delete volume"
                }
                message={`Delete ${dangerousDelete?.label}? This cannot be undone.`}
                confirmLabel="Delete"
                confirmLoadingLabel={
                    dangerousDelete?.type === "image"
                        ? "Deleting image..."
                        : "Deleting volume..."
                }
                loading={deleteImage.isPending || deleteVolume.isPending}
                danger
                onConfirm={() => {
                    if (
                        !dangerousDelete ||
                        deleteImage.isPending ||
                        deleteVolume.isPending
                    ) {
                        return;
                    }

                    const mutation =
                        dangerousDelete.type === "image"
                            ? deleteImage.mutateAsync(dangerousDelete.id)
                            : deleteVolume.mutateAsync(dangerousDelete.id);

                    void mutation.then(() => {
                        setDangerousDelete(null);
                    });
                }}
            />
            <ConfirmModal
                isOpen={Boolean(manualUpdateTarget)}
                onCancel={() => {
                    if (dockerManualUpdate.isPending) {
                        return;
                    }
                    setManualUpdateTarget(null);
                }}
                title="Run manual update"
                message={`Update ${manualUpdateTarget?.label}? This will update the compose image reference and run docker compose up -d for that service.`}
                confirmLabel="Update now"
                confirmLoadingLabel="Updating..."
                loading={dockerManualUpdate.isPending}
                onConfirm={() => {
                    if (!manualUpdateTarget || dockerManualUpdate.isPending) {
                        return;
                    }

                    void handleManualUpdate(manualUpdateTarget.id).finally(() => {
                        setManualUpdateTarget(null);
                    });
                }}
            />
        </div>
    );
}

export default Docker;
