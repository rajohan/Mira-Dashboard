import { Boxes, History, RefreshCw } from "lucide-react";
import type { ChangeEvent } from "react";
import { useRef, useState } from "react";

import { DockerContainersTable } from "../components/features/docker/DockerContainersTable";
import {
    formatBytes,
    formatDockerMemory,
    formatFullVersionDisplay,
    formatTimestamp,
    formatUpdaterTransition,
    formatVersionDisplay,
} from "../components/features/docker/dockerFormatters";
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
    useDockerUpdaterServices,
    useDockerVolumes,
    useRunDockerUpdater,
} from "../hooks/useDocker";
/** Renders the docker UI. */
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
    const actionOutputRef = useRef<HTMLDivElement>(null);

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

    /** Handles format action error. */
    function formatActionError(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    /** Handles show action output. */
    function showActionOutput(output: string) {
        setActionOutput(output);
        requestAnimationFrame(() => {
            actionOutputRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
            });
        });
    }

    /** Handles handle container action. */
    async function handleContainerAction(
        containerId: string,
        action: "start" | "stop" | "restart" | "update"
    ) {
        showActionOutput(`${action} requested for container...`);
        try {
            const result = await dockerAction.mutateAsync({ containerId, action });
            showActionOutput(result.output || `${action} completed.`);
        } catch (error) {
            showActionOutput(
                `Failed to ${action} container.\n\n${formatActionError(error)}`
            );
        }
    }

    /** Handles handle stack restart. */
    async function handleStackRestart(service?: string) {
        showActionOutput(
            service ? `Restarting ${service}...` : "Restarting Docker stack..."
        );
        try {
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
            showActionOutput(result.output || "Docker stack restart completed.");
        } catch (error) {
            showActionOutput(
                `Failed to restart Docker stack.\n\n${formatActionError(error)}`
            );
        }
    }

    /** Handles handle manual update. */
    async function handleManualUpdate(serviceId: number) {
        showActionOutput("Running manual Docker update...");
        try {
            const result = await dockerManualUpdate.mutateAsync(serviceId);
            const updatedCount = result.result?.summary?.updated ?? 0;
            const failedCount = result.result?.summary?.failed ?? 0;
            showActionOutput(
                `Manual updater run finished. updated=${updatedCount} failed=${failedCount}` +
                    (result.stderr ? `\n\n${result.stderr}` : "")
            );
        } catch (error) {
            showActionOutput(`Manual update failed.\n\n${formatActionError(error)}`);
        }
    }

    /** Handles handle prune. */
    async function handlePrune(target: "images" | "volumes") {
        setPruningTarget(target);
        showActionOutput(`Removing unused Docker ${target}...`);
        try {
            const result = await dockerPrune.mutateAsync(target);
            showActionOutput(result.output || `Unused Docker ${target} removed.`);
        } catch (error) {
            showActionOutput(
                `Failed to remove unused Docker ${target}.\n\n${formatActionError(error)}`
            );
        } finally {
            setPruningTarget(null);
        }
    }

    /** Handles handle dangerous delete. */
    async function handleDangerousDelete() {
        if (!dangerousDelete || deleteImage.isPending || deleteVolume.isPending) {
            return;
        }

        const target = dangerousDelete;
        showActionOutput(`Deleting Docker ${target.type} ${target.label}...`);
        try {
            await (target.type === "image"
                ? deleteImage.mutateAsync(target.id)
                : deleteVolume.mutateAsync(target.id));
            setDangerousDelete(null);
            showActionOutput(`Deleted Docker ${target.type} ${target.label}.`);
        } catch (error) {
            showActionOutput(
                `Failed to delete Docker ${target.type} ${target.label}.\n\n${formatActionError(error)}`
            );
        }
    }

    /** Handles handle run docker updater. */
    async function handleRunDockerUpdater() {
        showActionOutput("Running Docker updater...");
        try {
            const result = await runDockerUpdater.mutateAsync();
            showActionOutput(JSON.stringify(result, null, 2));
        } catch (error) {
            showActionOutput(`Docker updater failed.\n\n${formatActionError(error)}`);
        }
    }

    /** Handles handle start console. */
    async function handleStartConsole(containerId: string) {
        const result = await startDockerExec(containerId, consoleCommand);
        setConsoleJobId(result.jobId);
    }

    if (isInitialLoading) {
        return <LoadingState message="Loading Docker overview..." size="lg" />;
    }

    return (
        <div className="space-y-4 p-3 sm:p-4 lg:space-y-6 lg:p-6">
            <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
                <Card className="p-3 sm:p-4">
                    <div className="text-primary-400 text-sm">Running containers</div>
                    <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                        {summary.running}
                    </div>
                </Card>
                <Card className="p-3 sm:p-4">
                    <div className="text-primary-400 text-sm">Unhealthy</div>
                    <div className="mt-2 text-2xl font-semibold text-red-400 sm:text-3xl">
                        {summary.unhealthy}
                    </div>
                </Card>
                <Card className="p-3 sm:p-4">
                    <div className="text-primary-400 text-sm">Compose managed</div>
                    <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                        {summary.composeManaged}
                    </div>
                </Card>
                <Card className="p-3 sm:p-4">
                    <div className="text-primary-400 text-sm">Images size</div>
                    <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                        {formatBytes(summary.totalImageSize)}
                    </div>
                </Card>
            </div>

            {actionOutput ? (
                <Card
                    ref={actionOutputRef}
                    role="status"
                    aria-live="polite"
                    className="p-3 sm:p-4"
                >
                    <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="text-primary-100 text-sm font-semibold">
                            Docker action status
                        </div>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setActionOutput("")}
                            className="w-full sm:w-auto"
                        >
                            Dismiss
                        </Button>
                    </div>
                    <pre className="text-primary-100 max-h-80 overflow-auto rounded-lg bg-black/40 p-3 text-xs">
                        {actionOutput}
                    </pre>
                </Card>
            ) : null}

            {runDockerUpdater.data ? (
                <Card className="p-3 sm:p-4">
                    <div className="text-primary-100 mb-2 text-sm font-semibold">
                        Last updater run
                    </div>
                    <pre className="text-primary-100 max-h-80 overflow-auto rounded-lg bg-black/40 p-3 text-xs">
                        {JSON.stringify(runDockerUpdater.data, null, 2)}
                    </pre>
                </Card>
            ) : null}

            <Card className="overflow-hidden">
                <div className="border-primary-700 border-b px-3 py-3 sm:px-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                            <div className="text-lg font-semibold">Updater overview</div>
                            <div className="text-primary-400 text-xs">
                                Registry poll state from n8n, plus recent updater history.
                            </div>
                        </div>
                        <Button
                            size="sm"
                            onClick={() => void handleRunDockerUpdater()}
                            disabled={runDockerUpdater.isPending}
                            className="w-full sm:w-auto"
                        >
                            {runDockerUpdater.isPending
                                ? "Running..."
                                : "Run updater now"}
                        </Button>
                    </div>
                </div>
                <div className="border-primary-700 grid gap-3 border-b px-3 py-3 sm:grid-cols-2 sm:gap-4 sm:px-4 sm:py-4 xl:grid-cols-5">
                    <Card className="p-3 sm:p-4">
                        <div className="text-primary-400 text-sm">Tracked services</div>
                        <div className="mt-2 text-2xl font-semibold">
                            {updaterSummary?.total ?? "—"}
                        </div>
                    </Card>
                    <Card className="p-3 sm:p-4">
                        <div className="text-primary-400 text-sm">Updates available</div>
                        <div className="mt-2 text-2xl font-semibold text-amber-300">
                            {updaterSummary?.updateAvailable ?? "—"}
                        </div>
                    </Card>
                    <Card className="p-3 sm:p-4">
                        <div className="text-primary-400 text-sm">Auto policy</div>
                        <div className="mt-2 text-2xl font-semibold">
                            {updaterSummary?.autoPolicy ?? "—"}
                        </div>
                    </Card>
                    <Card className="p-3 sm:p-4">
                        <div className="text-primary-400 text-sm">Notify policy</div>
                        <div className="mt-2 text-2xl font-semibold">
                            {updaterSummary?.notifyPolicy ?? "—"}
                        </div>
                    </Card>
                    <Card className="p-3 sm:p-4">
                        <div className="text-primary-400 text-sm">Recent failures</div>
                        <div className="mt-2 text-2xl font-semibold text-red-400">
                            {updaterSummary?.failed ?? "—"}
                        </div>
                    </Card>
                </div>
                <div className="grid gap-4 px-3 py-3 sm:px-4 sm:py-4 xl:grid-cols-[1.3fr_1fr] xl:gap-6">
                    <div className="min-w-0">
                        <div className="text-primary-100 mb-3 flex items-center gap-2 text-sm font-semibold">
                            <RefreshCw className="text-accent-400 h-4 w-4" />
                            Pending or newer candidates
                        </div>
                        <div className="max-h-80 overflow-y-auto pr-1 sm:max-h-[400px] sm:pr-2">
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
                                        <Card key={service.id} className="p-3 sm:p-4">
                                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                                <div className="min-w-0">
                                                    <div className="text-primary-50 font-medium break-words">
                                                        {service.serviceName}
                                                    </div>
                                                    <div className="text-primary-400 mt-1 text-xs break-all">
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
                                                            setManualUpdateTarget({
                                                                id: service.id,
                                                                label: service.serviceName,
                                                            })
                                                        }
                                                        disabled={
                                                            dockerManualUpdate.isPending
                                                        }
                                                        className="w-full sm:w-auto"
                                                    >
                                                        Update now
                                                    </Button>
                                                </div>
                                            </div>
                                            <div className="text-primary-300 mt-3 grid gap-2 text-xs md:grid-cols-2">
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
                    <div className="min-w-0">
                        <div className="text-primary-100 mb-3 flex items-center gap-2 text-sm font-semibold">
                            <History className="text-accent-400 h-4 w-4" />
                            Recent updater events
                        </div>
                        <div className="max-h-80 overflow-y-auto pr-1 sm:max-h-[400px] sm:pr-2">
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
                                        <Card key={event.id} className="p-3 sm:p-4">
                                            <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                                                <div className="text-primary-50 font-medium break-words">
                                                    {event.serviceName}
                                                </div>
                                                <div className="text-primary-500 shrink-0 text-xs">
                                                    {formatTimestamp(event.createdAt)}
                                                </div>
                                            </div>
                                            <div className="text-primary-400 mt-1 text-xs tracking-wide uppercase">
                                                {event.eventType}
                                            </div>
                                            <div
                                                className="text-primary-300 mt-2 font-mono text-xs break-all"
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
                    <div className="border-primary-700 border-b px-3 py-3 text-lg font-semibold sm:px-4">
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
                    <div className="border-primary-700 border-b px-3 py-3 text-lg font-semibold sm:px-4">
                        Containers
                    </div>
                    <EmptyState message="No containers found.">
                        <div className="text-primary-500 mt-3 flex justify-center">
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

            <div className="grid gap-4 xl:grid-cols-2 xl:gap-6">
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
                        void handlePrune("images");
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
                        void handlePrune("volumes");
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
                    <div className="space-y-3 text-sm sm:space-y-4">
                        <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
                            <Card className="p-3 sm:p-4">
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
                            <Card className="p-3 sm:p-4">
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

                        <Card className="p-3 sm:p-4">
                            <div className="mb-2 font-semibold">Networks</div>
                            <div className="text-primary-300 space-y-2 text-xs">
                                {containerDetailsQuery.data.networks.map((network) => (
                                    <div
                                        key={network.name}
                                        className="bg-primary-900/50 rounded p-2 break-all"
                                    >
                                        <div className="text-primary-100 font-medium">
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
                            <div className="text-primary-300 space-y-2 text-xs">
                                {containerDetailsQuery.data.mounts.map((mount) => (
                                    <div
                                        key={`${mount.source}:${mount.destination}`}
                                        className="bg-primary-900/50 rounded p-2 break-all"
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
                <div className="mb-3 flex flex-col gap-3 sm:mb-4 sm:flex-row sm:items-center">
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
                <pre className="text-primary-100 max-h-[70vh] overflow-auto rounded-lg bg-black p-3 text-xs sm:p-4">
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
                <div className="mb-3 flex flex-col gap-3 sm:mb-4 sm:flex-row sm:items-center">
                    <Input
                        value={consoleCommand}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            setConsoleCommand(event.target.value)
                        }
                        placeholder="Command to run inside container"
                        className="min-w-0 flex-1"
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
                <pre className="text-primary-100 max-h-[70vh] overflow-auto rounded-lg bg-black p-3 text-xs sm:p-4">
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
                    void handleDangerousDelete();
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
