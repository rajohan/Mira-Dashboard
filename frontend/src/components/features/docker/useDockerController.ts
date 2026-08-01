import type { KeyboardEvent } from "react";
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

/**
 * Owns Docker queries, mutations, selection state, and derived page data.
 * @returns Docker page state, data, and actions.
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
    const actionOutputRef = useRef<HTMLDivElement | null>(null);

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

    return {
        actionOutput,
        actionOutputRef,
        consoleCommand,
        consoleContainerId,
        consoleJobId,
        consoleStartError,
        containerDetails,
        containerDetailsQuery,
        containers,
        containersQuery,
        dangerousDelete,
        deleteImage,
        deleteVolume,
        dockerManualUpdate,
        dockerPrune,
        execJobQuery,
        handleConsoleCommandKeyDown,
        handleContainerAction,
        handleDangerousDelete,
        handleManualUpdate,
        handlePrune,
        handleRunDockerUpdater,
        handleStartConsole,
        handleStackRestart,
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
        servicesWithUpdates,
        updaterEvents,
        updaterEventsQuery,
        updaterServicesQuery,
        updaterSummary,
        volumes,
    };
}
