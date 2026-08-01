import { History, Play, RefreshCw, Square, X } from "lucide-react";
import type { ChangeEvent } from "react";

import { formatBytes } from "../components/features/docker/dockerFormatters";
import { DockerImagesTable } from "../components/features/docker/DockerImagesTable";
import { DockerVolumesTable } from "../components/features/docker/DockerVolumesTable";
import { useDockerController } from "../components/features/docker/useDockerController";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { Input } from "../components/ui/Input";
import { LoadingState } from "../components/ui/LoadingState";
import { Modal } from "../components/ui/Modal";
import { RefreshButton } from "../components/ui/RefreshButton";
import { Select } from "../components/ui/Select";
import { stopDockerExec } from "../hooks/useDocker";
/**
 * Renders the Docker UI.
 * @returns Rendered the Docker UI.
 */
export function Docker() {
    const controller = useDockerController();
    const {
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
    } = controller;

    if (isInitialLoading) {
        return <LoadingState message="Loading Docker overview..." size="lg" />;
    }

    return (
        <div className="space-y-4 p-3 sm:p-4 lg:space-y-6 lg:p-6">
            {isDockerIsolated || containersQuery.isLiveUnavailable ? (
                <output className="block rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100 sm:p-4">
                    <div className="font-semibold">
                        {isDockerIsolated
                            ? "Isolated Docker snapshot"
                            : "Cached Docker snapshot"}
                    </div>
                    <div className="mt-1 text-xs text-amber-200/80">
                        {isDockerIsolated
                            ? "PR development shows copied production inventory. Live details, logs, console, refreshes, and mutations are disabled."
                            : "The live Docker API is unavailable. Inventory remains read-only until the connection recovers."}
                    </div>
                </output>
            ) : undefined}

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
                        actionOutputRef.current = element ?? undefined;
                    }}
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
                            disabled={isDockerReadOnly || runDockerUpdater.isPending}
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
                            {updaterServicesContent}
                        </div>
                    </div>
                    <div className="min-w-0">
                        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-primary-100">
                            <History className="size-4 text-accent-400" />
                            Recent updater events
                        </div>
                        <div className="max-h-80 overflow-y-auto pr-1 sm:max-h-100 sm:pr-2">
                            {updaterEventsContent}
                        </div>
                    </div>
                </div>
            </Card>

            {containersContent}

            <div className="grid gap-4 xl:grid-cols-2 xl:gap-6">
                <DockerImagesTable
                    images={images}
                    isReadOnly={isDockerReadOnly}
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
                    isReadOnly={isDockerReadOnly}
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
                {containerDetailsContent}
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
                <div className="mb-3 flex flex-col gap-3 sm:mb-4 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                        <Input
                            aria-label="Docker console command"
                            value={consoleCommand}
                            onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                setConsoleCommand(event.target.value)
                            }
                            onKeyDown={handleConsoleCommandKeyDown}
                            placeholder="Command to run inside container"
                            className="font-mono"
                        />
                    </div>
                    <div className="flex flex-col gap-2 sm:min-w-44 sm:flex-row sm:items-center sm:justify-end">
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
