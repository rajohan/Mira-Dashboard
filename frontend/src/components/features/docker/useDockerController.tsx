import { Boxes } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useRef, useState } from "react";

import {
    restartDockerStack,
    startDockerExec,
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
    useDockerSummaryAutoRefresh,
    useDockerUpdaterEvents,
    useDockerUpdaterServices,
    useDockerVolumes,
    useRefreshDockerSummary,
    useRunDockerUpdater,
} from "../../../hooks/useDocker";
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

/**
 * Owns Docker queries, mutations, selection state, and derived panels.
 * @returns Docker page state, actions, and rendered detail panels.
 */
export function useDockerController() {
    const [selectedContainerId, setSelectedContainerId] = useState<string | undefined>();
    const [logsContainerId, setLogsContainerId] = useState<string | undefined>();
    const [consoleContainerId, setConsoleContainerId] = useState<string | undefined>();
    const [logsTail, setLogsTail] = useState(200);
    const [consoleCommand, setConsoleCommand] = useState("");
    const [consoleJobId, setConsoleJobId] = useState<string | undefined>();
    const [consoleStartError, setConsoleStartError] = useState<string | undefined>();
    const [isStartingConsoleJob, setIsStartingConsoleJob] = useState(false);
    const [dangerousDelete, setDangerousDelete] = useState<
        | undefined
        | { type: "image"; id: string; label: string }
        | { type: "volume"; id: string; label: string }
    >();
    const [manualUpdateTarget, setManualUpdateTarget] = useState<
        | undefined
        | {
              id: number;
              label: string;
          }
    >();
    const [actionOutput, setActionOutput] = useState<string>("");
    const [pruningTarget, setPruningTarget] = useState<
        "images" | "volumes" | undefined
    >();
    const actionOutputRef = useRef<HTMLDivElement | undefined>(undefined);

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
    useDockerSummaryAutoRefresh(containersQuery.mode === "live");

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
    const isDockerIsolated = containersQuery.mode === "isolated";
    const isDockerReadOnly = containersQuery.mode !== "live";
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

    /**
     * Displays action output and scrolls it into view.
     * @param output Output value.
     */
    function showActionOutput(output: string) {
        setActionOutput(output);
        requestAnimationFrame(() => {
            actionOutputRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
            });
        });
    }

    /**
     * Runs a container action and shows the resulting output.
     * @param containerId Container identifier.
     * @param action Action value.
     */
    async function handleContainerAction(
        containerId: string,
        action: "start" | "stop" | "restart"
    ) {
        showActionOutput(`${action} requested for container...`);
        try {
            const result = await dockerAction.mutateAsync({ containerId, action });
            showActionOutput(result.output || `${action} completed.`);
        } catch (error) {
            showActionOutput(
                `Failed to ${action} container.\n\n${messageFromError(error, "Docker action failed")}`
            );
        }
    }

    /** Restarts a Docker stack or one service within the stack. */
    async function handleStackRestart() {
        showActionOutput("Restarting Docker stack...");
        try {
            const result = await restartDockerStack();
            await refreshDockerSummary();
            showActionOutput(result.output || "Docker stack restart completed.");
        } catch (error) {
            showActionOutput(
                `Failed to restart Docker stack.\n\n${messageFromError(error, "Docker restart failed")}`
            );
        }
    }

    /**
     * Triggers a manual update for the selected service.
     * @param serviceId Service identifier.
     */
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
            showActionOutput(
                `Manual update failed.\n\n${messageFromError(error, "Docker update failed")}`
            );
        }
    }

    /**
     * Runs the selected Docker prune operation after confirmation.
     * @param target Target value.
     */
    async function handlePrune(target: "images" | "volumes") {
        setPruningTarget(target);
        showActionOutput(`Removing unused Docker ${target}...`);
        try {
            const result = await dockerPrune.mutateAsync(target);
            showActionOutput(result.output || `Unused Docker ${target} removed.`);
        } catch (error) {
            showActionOutput(
                `Failed to remove unused Docker ${target}.\n\n${messageFromError(error, "Docker prune failed")}`
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
                `Failed to delete Docker ${target.type} ${target.label}.\n\n${messageFromError(error, "Docker delete failed")}`
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
            showActionOutput(
                `Docker updater failed.\n\n${messageFromError(error, "Docker updater failed")}`
            );
        }
    }

    /**
     * Starts an interactive Docker console job for the selected container.
     * @param containerId Container identifier.
     */
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
            const message = `Failed to start Docker console.\n\n${messageFromError(error, "Docker console failed")}`;
            setConsoleStartError(message);
            showActionOutput(message);
        } finally {
            setIsStartingConsoleJob(false);
        }
    }

    /** Handles console command keys. */
    function handleConsoleCommandKeyDown(event: KeyboardEvent<HTMLInputElement>) {
        if (!selectedConsoleContainer || event.key !== "Enter") {
            return;
        }

        event.preventDefault();
        void handleStartConsole(selectedConsoleContainer.id);
    }

    let updaterServicesContent: ReactNode;
    if (updaterServicesQuery.isLoading) {
        updaterServicesContent = (
            <LoadingState message="Loading updater services..." size="md" />
        );
    } else if (servicesWithUpdates.length === 0) {
        updaterServicesContent = (
            <EmptyState message="No pending updater candidates right now." />
        );
    } else {
        updaterServicesContent = (
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
                                        isDockerReadOnly || dockerManualUpdate.isPending
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
                                Last checked: {formatTimestamp(service.lastCheckedAt)}
                            </div>
                            <div>Status: {service.lastStatus || "—"}</div>
                        </div>
                    </Card>
                ))}
            </div>
        );
    }

    let updaterEventsContent: ReactNode;
    if (updaterEventsQuery.isLoading) {
        updaterEventsContent = (
            <LoadingState message="Loading updater history..." size="md" />
        );
    } else if (updaterEvents.length === 0) {
        updaterEventsContent = <EmptyState message="No updater events yet." />;
    } else {
        updaterEventsContent = (
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
        );
    }

    let containersContent: ReactNode;
    if (containersQuery.isError && containers.length === 0) {
        containersContent = (
            <Card className="overflow-hidden">
                <div className="border-b border-primary-700 p-3 text-lg font-semibold sm:px-4">
                    Containers
                </div>
                <EmptyState message="Failed to load containers. Try refresh.">
                    <div className="mt-3 text-xs text-red-400">
                        {messageFromError(
                            containersQuery.error,
                            "Unknown container query error"
                        )}
                    </div>
                </EmptyState>
            </Card>
        );
    } else if (containers.length === 0) {
        containersContent = (
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
    } else {
        containersContent = (
            <DockerContainersTable
                containers={containers}
                isReadOnly={isDockerReadOnly}
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
        );
    }

    let containerDetailsContent: ReactNode;
    if (containerDetailsQuery.isLoading) {
        containerDetailsContent = (
            <LoadingState message="Loading container details..." size="md" />
        );
    } else if (containerDetails === undefined) {
        containerDetailsContent = (
            <EmptyState message="Failed to load container details." />
        );
    } else {
        containerDetailsContent = (
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
        );
    }

    return {
        actionOutput,
        actionOutputRef,
        consoleCommand,
        consoleContainerId,
        consoleJobId,
        consoleStartError,
        containerDetailsContent,
        containersContent,
        containersQuery,
        dangerousDelete,
        deleteImage,
        deleteVolume,
        dockerManualUpdate,
        dockerPrune,
        execJobQuery,
        handleConsoleCommandKeyDown,
        handleDangerousDelete,
        handleManualUpdate,
        handlePrune,
        handleRunDockerUpdater,
        handleStartConsole,
        images,
        isDockerIsolated,
        isDockerReadOnly,
        isInitialLoading,
        isStartingConsoleJob,
        logsContainerId,
        logsQuery,
        logsTail,
        manualUpdateTarget,
        pruningTarget,
        runDockerUpdater,
        selectedConsoleContainer,
        selectedContainer,
        selectedContainerId,
        selectedLogsContainer,
        setActionOutput,
        setConsoleCommand,
        setConsoleContainerId,
        setConsoleJobId,
        setConsoleStartError,
        setDangerousDelete,
        setLogsContainerId,
        setLogsTail,
        setManualUpdateTarget,
        setSelectedContainerId,
        summary,
        updaterEventsContent,
        updaterServicesContent,
        updaterSummary,
        volumes,
    };
}
