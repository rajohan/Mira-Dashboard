import { Boxes } from "lucide-react";
import { useMemo, useState } from "react";

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
    useDockerPrune,
    useDockerStackAction,
    useDockerVolumes,
} from "../hooks/useDocker";

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

export function Docker() {
    const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);
    const [logsContainerId, setLogsContainerId] = useState<string | null>(null);
    const [consoleContainerId, setConsoleContainerId] = useState<string | null>(null);
    const [logsTail, setLogsTail] = useState(200);
    const [consoleCommand, setConsoleCommand] = useState("sh");
    const [consoleJobId, setConsoleJobId] = useState<string | null>(null);
    const [dangerousDelete, setDangerousDelete] = useState<
        | null
        | { type: "image"; id: string; label: string }
        | { type: "volume"; id: string; label: string }
    >(null);
    const [actionOutput, setActionOutput] = useState<string>("");

    const containersQuery = useDockerContainers();
    const imagesQuery = useDockerImages();
    const volumesQuery = useDockerVolumes();
    const containerDetailsQuery = useDockerContainer(selectedContainerId);
    const logsQuery = useDockerContainerLogs(logsContainerId, logsTail, Boolean(logsContainerId));
    const execJobQuery = useDockerExecJob(consoleJobId);

    const dockerAction = useDockerAction();
    const dockerStackAction = useDockerStackAction();
    const deleteImage = useDeleteDockerImage();
    const deleteVolume = useDeleteDockerVolume();
    const dockerPrune = useDockerPrune();

    const containers = containersQuery.data || [];
    const images = imagesQuery.data || [];
    const volumes = volumesQuery.data || [];
    const isInitialLoading =
        containersQuery.isLoading || imagesQuery.isLoading || volumesQuery.isLoading;


    const selectedContainer = containers.find((container) => container.id === selectedContainerId) || null;
    const selectedLogsContainer = containers.find((container) => container.id === logsContainerId) || null;
    const selectedConsoleContainer =
        containers.find((container) => container.id === consoleContainerId) || null;

    const summary = useMemo(() => {
        const running = containers.filter((container) => container.state === "running").length;
        const unhealthy = containers.filter((container) => container.health === "unhealthy").length;
        const composeManaged = containers.filter((container) => container.service).length;
        const totalImageSize = images.reduce((sum, image) => sum + image.size, 0);

        return {
            running,
            unhealthy,
            composeManaged,
            totalImageSize,
        };
    }, [containers, images]);

    async function handleContainerAction(containerId: string, action: "start" | "stop" | "restart" | "update") {
        const result = await dockerAction.mutateAsync({ containerId, action });
        setActionOutput(result.output || "Done");
    }

    async function handleStackAction(action: "restart" | "update", service?: string) {
        const result = await dockerStackAction.mutateAsync({ action, service });
        setActionOutput(result.output || "Done");
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
                    <div className="mt-2 text-3xl font-semibold">{summary.composeManaged}</div>
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
                    onUpdate={(containerId) => {
                        void handleContainerAction(containerId, "update");
                    }}
                    onRestartStack={() => {
                        void handleStackAction("restart");
                    }}
                    onUpdateStack={() => {
                        void handleStackAction("update");
                    }}
                />
            )}

            <div className="grid gap-6 xl:grid-cols-2">
                <DockerImagesTable
                    images={images}
                    onDelete={(imageId, label) =>
                        setDangerousDelete({
                            type: "image",
                            id: imageId,
                            label,
                        })
                    }
                    onPruneUnused={() => {
                        void dockerPrune.mutateAsync("images").then((result) => {
                            setActionOutput(result.output || "Unused images removed");
                        });
                    }}
                />

                <DockerVolumesTable
                    volumes={volumes}
                    onDelete={(volumeName) =>
                        setDangerousDelete({
                            type: "volume",
                            id: volumeName,
                            label: volumeName,
                        })
                    }
                    onPruneUnused={() => {
                        void dockerPrune.mutateAsync("volumes").then((result) => {
                            setActionOutput(result.output || "Unused volumes removed");
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
                                <div>Created: {containerDetailsQuery.data.createdAt}</div>
                                <div>Started: {containerDetailsQuery.data.startedAt || "—"}</div>
                                <div>Finished: {containerDetailsQuery.data.finishedAt || "—"}</div>
                                <div>Status: {containerDetailsQuery.data.status}</div>
                            </Card>
                            <Card className="p-4">
                                <div className="mb-2 font-semibold">Resources</div>
                                <div>CPU: {containerDetailsQuery.data.stats?.cpu || "—"}</div>
                                <div>Memory: {containerDetailsQuery.data.stats?.memory || "—"}</div>
                                <div>Net I/O: {containerDetailsQuery.data.stats?.netIO || "—"}</div>
                                <div>Block I/O: {containerDetailsQuery.data.stats?.blockIO || "—"}</div>
                            </Card>
                        </div>

                        <Card className="p-4">
                            <div className="mb-2 font-semibold">Networks</div>
                            <div className="space-y-2 text-xs text-primary-300">
                                {containerDetailsQuery.data.networks.map((network) => (
                                    <div key={network.name} className="rounded bg-primary-900/50 p-2">
                                        <div className="font-medium text-primary-100">{network.name}</div>
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
                                    <div key={`${mount.source}:${mount.destination}`} className="rounded bg-primary-900/50 p-2">
                                        <div>{mount.source}</div>
                                        <div className="text-primary-500">→ {mount.destination}</div>
                                        <div>
                                            {mount.type} · {mount.mode || "default"} · {mount.readOnly ? "ro" : "rw"}
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
                title={selectedLogsContainer ? `${selectedLogsContainer.name} logs` : "Container logs"}
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
                    <RefreshButton onClick={() => void logsQuery.refetch()} isLoading={logsQuery.isFetching} />
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
                title={selectedConsoleContainer ? `${selectedConsoleContainer.name} console` : "Container console"}
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
                        <Button variant="danger" onClick={() => void stopDockerExec(consoleJobId)}>
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
                title={dangerousDelete?.type === "image" ? "Delete image" : "Delete volume"}
                message={`Delete ${dangerousDelete?.label}? This cannot be undone.`}
                confirmLabel="Delete"
                confirmLoadingLabel={dangerousDelete?.type === "image" ? "Deleting image..." : "Deleting volume..."}
                loading={deleteImage.isPending || deleteVolume.isPending}
                danger
                onConfirm={() => {
                    if (!dangerousDelete || deleteImage.isPending || deleteVolume.isPending) {
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
        </div>
    );
}

export default Docker;
