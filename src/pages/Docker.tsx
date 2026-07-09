import { Boxes, History, Play, RefreshCw, Square, X } from "lucide-react";
import type { ChangeEvent, KeyboardEvent } from "react";
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
    useRefreshDockerSummary,
    useRunDockerUpdater,
} from "../hooks/useDocker";
/** Renders the Docker UI. */
export function Docker() {
    const [selectedContainerId, setSelectedContainerId] = useState<string | undefined>(
        undefined
    );
    const [logsContainerId, setLogsContainerId] = useState<string | undefined>(undefined);
    const [consoleContainerId, setConsoleContainerId] = useState<string | undefined>(
        undefined
    );
    const [logsTail, setLogsTail] = useState(200);
    const [consoleCommand, setConsoleCommand] = useState("");
    const [consoleJobId, setConsoleJobId] = useState<string | undefined>(undefined);
    const [consoleStartError, setConsoleStartError] = useState<string | undefined>(
        undefined
    );
    const [isStartingConsoleJob, setIsStartingConsoleJob] = useState(false);
    const [dangerousDelete, setDangerousDelete] = useState<
        | undefined
        | { type: "image"; id: string; label: string }
        | { type: "volume"; id: string; label: string }
    >(undefined);
    const [manualUpdateTarget, setManualUpdateTarget] = useState<
        | undefined
        | {
              id: number;
              label: string;
          }
    >(undefined);
    const [actionOutput, setActionOutput] = useState<string>("");
    const [pruningTarget, setPruningTarget] = useState<"images" | "volumes" | undefined>(
        undefined
    );
    const actionOutputReference = useRef<HTMLDivElement | undefined>(undefined);

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
    const refreshDockerSummary = useRefreshDockerSummary();

    const containers = containersQuery.data || [];
    const images = imagesQuery.data || [];
    const volumes = volumesQuery.data || [];
    const isInitialLoading =
        containersQuery.isLoading || imagesQuery.isLoading || volumesQuery.isLoading;

    const selectedContainer =
        containers.find((container) => container.id === selectedContainerId) || undefined;
    const selectedLogsContainer =
        containers.find((container) => container.id === logsContainerId) || undefined;
    const selectedConsoleContainer =
        containers.find((container) => container.id === consoleContainerId) || undefined;
    const selectedContainerStats =
        selectedContainer === undefined
            ? containerDetailsQuery.data?.stats
            : selectedContainer.stats;
    const containerDetails = containerDetailsQuery.data
        ? {
              ...containerDetailsQuery.data,
              stats: selectedContainerStats,
              status: selectedContainer?.status ?? containerDetailsQuery.data.status,
          }
        : undefined;

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

    /** Formats an action error for display. */
    function formatActionError(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    /** Displays action output and scrolls it into view. */
    function showActionOutput(output: string) {
        setActionOutput(output);
        requestAnimationFrame(() => {
            actionOutputReference.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
            });
        });
    }

    /** Runs a container action and shows the resulting output. */
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

    /** Restarts a Docker stack or one service within the stack. */
    async function handleStackRestart() {
        showActionOutput("Restarting Docker stack...");
        try {
            const response = await fetch("/api/docker/stack/action", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ action: "restart" }),
            });
            const result = (await response.json()) as { output?: string; error?: string };
            if (!response.ok) {
                throw new Error(result.error || "Failed to restart stack");
            }
            await refreshDockerSummary();
            showActionOutput(result.output || "Docker stack restart completed.");
        } catch (error) {
            showActionOutput(
                `Failed to restart Docker stack.\n\n${formatActionError(error)}`
            );
        }
    }

    /** Triggers a manual update for the selected service. */
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

    /** Runs the selected Docker prune operation after confirmation. */
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
            setPruningTarget(undefined);
        }
    }

    /** Deletes the selected Docker image or volume after confirmation. */
    async function handleDangerousDelete() {
        if (!dangerousDelete || deleteImage.isPending || deleteVolume.isPending) {
            return;
        }

        const target = dangerousDelete;
        showActionOutput(`Deleting Docker ${target.type} ${target.label}...`);
        try {
            const deleteTarget = target.type === "image" ? deleteImage : deleteVolume;
            await deleteTarget.mutateAsync(target.id);
            setDangerousDelete(undefined);
            showActionOutput(`Deleted Docker ${target.type} ${target.label}.`);
        } catch (error) {
            showActionOutput(
                `Failed to delete Docker ${target.type} ${target.label}.\n\n${formatActionError(error)}`
            );
        }
    }

    /** Runs the Docker updater workflow and displays the output. */
    async function handleRunDockerUpdater() {
        showActionOutput("Running Docker updater...");
        try {
            const result = await runDockerUpdater.mutateAsync();
            showActionOutput(JSON.stringify(result, undefined, 2));
        } catch (error) {
            showActionOutput(`Docker updater failed.\n\n${formatActionError(error)}`);
        }
    }

    /** Starts an interactive Docker console job for the selected container. */
    async function handleStartConsole(containerId: string) {
        const command = consoleCommand.trim();
        if (!command || isStartingConsoleJob) {
            return;
        }

        setIsStartingConsoleJob(true);
        setConsoleStartError(undefined);
        try {
            const result = await startDockerExec(containerId, command);
            setConsoleJobId(result.jobId);
            setConsoleCommand("");
        } catch (error) {
            const message = `Failed to start Docker console.\n\n${formatActionError(error)}`;
            setConsoleStartError(message);
            showActionOutput(message);
        } finally {
            setIsStartingConsoleJob(false);
        }
    }

    /** Handles console command keys. */
    function handleConsoleCommandKeyDown(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key !== "Enter" || !selectedConsoleContainer) {
            return;
        }

        event.preventDefault();
        void handleStartConsole(selectedConsoleContainer.id);
    }

    if (isInitialLoading) {
        return <LoadingState message="Loading Docker overview..." size="lg" />;
    }

    return (
        <div className="space-y-4 p-3 sm:p-4 lg:space-y-6 lg:p-6">
            <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
                <Card className="p-3 sm:p-4">
                    <div className="text-sm text-primary-400">Running containers</div>
                    <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                        {summary.running}
                    </div>
                </Card>
                <Card className="p-3 sm:p-4">
                    <div className="text-sm text-primary-400">Unhealthy</div>
                    <div className="mt-2 text-2xl font-semibold text-red-400 sm:text-3xl">
                        {summary.unhealthy}
                    </div>
                </Card>
                <Card className="p-3 sm:p-4">
                    <div className="text-sm text-primary-400">Compose managed</div>
                    <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                        {summary.composeManaged}
                    </div>
                </Card>
                <Card className="p-3 sm:p-4">
                    <div className="text-sm text-primary-400">Images size</div>
                    <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                        {formatBytes(summary.totalImageSize)}
                    </div>
                </Card>
            </div>

            {actionOutput ? (
                <Card
                    ref={(element) => {
                        actionOutputReference.current = element ?? undefined;
                    }}
                    role="status"
                    aria-live="polite"
                    className="p-3 sm:p-4"
                >
                    <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="text-sm font-semibold text-primary-100">
                            Docker action status
                        </div>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setActionOutput("")}
                            className="w-full sm:w-auto"
                        >
                            <X className="size-4" />
                            Dismiss
                        </Button>
                    </div>
                    <pre className="max-h-80 overflow-auto rounded-lg bg-black/40 p-3 text-xs text-primary-100">
                        {actionOutput}
                    </pre>
                </Card>
            ) : undefined}

            <Card className="overflow-hidden">
                <div className="border-b border-primary-700 p-3 sm:px-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                            <div className="text-lg font-semibold">Updater overview</div>
                            <div className="text-xs text-primary-400">
                                Registry poll state plus recent updater history.
                            </div>
                        </div>
                        <Button
                            size="sm"
                            onClick={() => void handleRunDockerUpdater()}
                            disabled={runDockerUpdater.isPending}
                            className="w-full sm:w-auto"
                        >
                            {runDockerUpdater.isPending ? (
                                <>
                                    <RefreshCw className="size-4 animate-spin" />
                                    Running...
                                </>
                            ) : (
                                <>
                                    <Play className="size-4" />
                                    Run updater now
                                </>
                            )}
                        </Button>
                    </div>
                </div>
                <div className="grid gap-3 border-b border-primary-700 p-3 sm:grid-cols-2 sm:gap-4 sm:p-4 xl:grid-cols-5">
                    <Card className="p-3 sm:p-4">
                        <div className="text-sm text-primary-400">Tracked services</div>
                        <div className="mt-2 text-2xl font-semibold">
                            {updaterSummary?.total ?? "—"}
                        </div>
                    </Card>
                    <Card className="p-3 sm:p-4">
                        <div className="text-sm text-primary-400">Updates available</div>
                        <div className="mt-2 text-2xl font-semibold text-amber-300">
                            {updaterSummary?.updateAvailable ?? "—"}
                        </div>
                    </Card>
                    <Card className="p-3 sm:p-4">
                        <div className="text-sm text-primary-400">Auto policy</div>
                        <div className="mt-2 text-2xl font-semibold">
                            {updaterSummary?.autoPolicy ?? "—"}
                        </div>
                    </Card>
                    <Card className="p-3 sm:p-4">
                        <div className="text-sm text-primary-400">Notify policy</div>
                        <div className="mt-2 text-2xl font-semibold">
                            {updaterSummary?.notifyPolicy ?? "—"}
                        </div>
                    </Card>
                    <Card className="p-3 sm:p-4">
                        <div className="text-sm text-primary-400">Recent failures</div>
                        <div className="mt-2 text-2xl font-semibold text-red-400">
                            {updaterSummary?.failed ?? "—"}
                        </div>
                    </Card>
                </div>
                <div className="grid gap-4 p-3 sm:p-4 xl:grid-cols-[1.3fr_1fr] xl:gap-6">
                    <div className="min-w-0">
                        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-primary-100">
                            <RefreshCw className="size-4 text-accent-400" />
                            Pending or newer candidates
                        </div>
                        <div className="max-h-80 overflow-y-auto pr-1 sm:max-h-100 sm:pr-2">
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
                        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-primary-100">
                            <History className="size-4 text-accent-400" />
                            Recent updater events
                        </div>
                        <div className="max-h-80 overflow-y-auto pr-1 sm:max-h-100 sm:pr-2">
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
                            )}
                        </div>
                    </div>
                </div>
            </Card>

            {containersQuery.isError && containers.length === 0 ? (
                <Card className="overflow-hidden">
                    <div className="border-b border-primary-700 p-3 text-lg font-semibold sm:px-4">
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
                    <div className="border-b border-primary-700 p-3 text-lg font-semibold sm:px-4">
                        Containers
                    </div>
                    <EmptyState message="No containers found.">
                        <div className="mt-3 flex justify-center text-primary-500">
                            <Boxes className="size-6" />
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
                        setConsoleJobId(undefined);
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
                onClose={() => setSelectedContainerId(undefined)}
                title={selectedContainer?.name || "Container details"}
                size="3xl"
            >
                {containerDetailsQuery.isLoading ? (
                    <LoadingState message="Loading container details..." size="md" />
                ) : containerDetails ? (
                    <div className="space-y-3 text-sm sm:space-y-4">
                        <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
                            <Card className="p-3 sm:p-4">
                                <div className="mb-2 font-semibold">Runtime</div>
                                <div>
                                    Created: {formatTimestamp(containerDetails.createdAt)}
                                </div>
                                <div>
                                    Started: {formatTimestamp(containerDetails.startedAt)}
                                </div>
                                <div>Status: {containerDetails.status}</div>
                            </Card>
                            <Card className="p-3 sm:p-4">
                                <div className="mb-2 font-semibold">Resources</div>
                                <div>CPU: {containerDetails.stats?.cpu || "—"}</div>
                                <div>
                                    Memory:{" "}
                                    {formatDockerMemory(containerDetails.stats?.memory)}
                                </div>
                                <div>Net I/O: {containerDetails.stats?.netIO || "—"}</div>
                                <div>
                                    Block I/O: {containerDetails.stats?.blockIO || "—"}
                                </div>
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
                onClose={() => setLogsContainerId(undefined)}
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
                <pre className="max-h-[70vh] overflow-auto rounded-lg bg-black p-3 text-xs text-primary-100 sm:p-4">
                    {logsQuery.data || "No logs"}
                </pre>
            </Modal>

            <Modal
                isOpen={Boolean(consoleContainerId)}
                onClose={() => {
                    setConsoleContainerId(undefined);
                    setConsoleJobId(undefined);
                    setConsoleStartError(undefined);
                }}
                title={
                    selectedConsoleContainer
                        ? `${selectedConsoleContainer.name} console`
                        : "Container console"
                }
                size="3xl"
            >
                <div className="mb-3 grid w-full grid-cols-1 gap-3 sm:mb-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                    <Input
                        aria-label="Docker console command"
                        value={consoleCommand}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            setConsoleCommand(event.target.value)
                        }
                        onKeyDown={handleConsoleCommandKeyDown}
                        placeholder="Command to run inside container"
                        className="w-full min-w-0 font-mono"
                    />
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Button
                            onClick={() => {
                                if (!selectedConsoleContainer) {
                                    return;
                                }

                                void handleStartConsole(selectedConsoleContainer.id);
                            }}
                            disabled={
                                !selectedConsoleContainer ||
                                !consoleCommand.trim() ||
                                isStartingConsoleJob
                            }
                            className="w-full sm:w-auto"
                        >
                            <Play className="size-4" />
                            {isStartingConsoleJob ? "Sending..." : "Send"}
                        </Button>
                        {consoleJobId && execJobQuery.data?.status === "running" ? (
                            <Button
                                variant="danger"
                                onClick={() => void stopDockerExec(consoleJobId)}
                                className="w-full sm:w-auto"
                            >
                                <Square className="size-4" />
                                Stop
                            </Button>
                        ) : undefined}
                    </div>
                </div>
                <pre className="max-h-[70vh] overflow-auto rounded-lg bg-black p-3 text-xs text-primary-100 sm:p-4">
                    {consoleStartError ||
                        (execJobQuery.data
                            ? `${execJobQuery.data.stdout}${execJobQuery.data.stderr ? `\n${execJobQuery.data.stderr}` : ""}`
                            : "Run a command to see output.")}
                </pre>
            </Modal>

            <ConfirmModal
                isOpen={Boolean(dangerousDelete)}
                onCancel={() => {
                    if (deleteImage.isPending || deleteVolume.isPending) {
                        return;
                    }
                    setDangerousDelete(undefined);
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
                    setManualUpdateTarget(undefined);
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

                    void (async () => {
                        try {
                            await handleManualUpdate(manualUpdateTarget.id);
                        } finally {
                            setManualUpdateTarget(undefined);
                        }
                    })();
                }}
            />
        </div>
    );
}

export default Docker;
