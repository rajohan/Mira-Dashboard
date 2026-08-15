import { useQuery } from "@tanstack/react-query";
import {
    Boxes,
    ExternalLink,
    HeartPulse,
    Layers3,
    Package,
    Play,
    RefreshCw,
    RotateCw,
    ServerOff,
    Square,
    SquareTerminal,
    X,
} from "lucide-react";
import { useState } from "react";

import type {
    DockerContainer,
    DockerOverview,
    DockerPreparePruneResult,
    DockerRequestOperationInput,
    DockerRequestOperationResult,
} from "../../contracts/docker.ts";
import { dockerOverviewCacheKey } from "../../contracts/docker.ts";
import {
    classifyDashboardBrowserFailure,
    dashboardBrowserFailureMessage,
    isDashboardOperationOutcomeUnknown,
} from "../api/trpcError.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { formatByteCount } from "../lib/formatMeasurements.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { MetricCard } from "../ui/MetricCard.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Text } from "../ui/Text.tsx";
import type { DockerClient } from "./dockerClient.ts";
import { DockerContainersTable } from "./DockerContainersTable.tsx";
import {
    DockerContainerDetailsDialog,
    DockerLogsDialog,
    type DockerLogsSelection,
    type DockerPrunePreview,
    DockerPrunePreviewDialog,
} from "./DockerDialogs.tsx";
import {
    type DockerOperationPrompt,
    containerOperationPrompt,
    createDockerIdempotencyKey,
    imageDeletePrompt,
    serviceUpdatePrompt,
    stackOperationPrompt,
    updaterOperationPrompt,
    volumeDeletePrompt,
} from "./dockerOperations.ts";
import { dockerOverviewQueryOptions } from "./dockerQueries.ts";
import { DockerResourcePanels } from "./DockerResourcePanels.tsx";
import { DockerUpdaterPanel } from "./DockerUpdaterPanel.tsx";

function dockerFailureMessage(error: unknown): string {
    if (isDashboardOperationOutcomeUnknown(error)) {
        return "The queue outcome could not be confirmed. Check Dashboard jobs before retrying with the same request.";
    }
    switch (classifyDashboardBrowserFailure(error)) {
        case "conflict": {
            return "Docker state changed. Refresh the snapshot and try again.";
        }
        case "not-found": {
            return "The exact Docker target or one-time ticket no longer exists.";
        }
        case "unavailable": {
            return "Docker operations are temporarily unavailable. Try again shortly.";
        }
        default: {
            return dashboardBrowserFailureMessage(error);
        }
    }
}

function pruneInput(
    result: DockerPreparePruneResult,
    idempotencyKey: string
): DockerRequestOperationInput {
    return result.target === "images"
        ? {
              confirmation: "prune-docker-images",
              idempotencyKey,
              operation: "prune-execute",
              sourceRevision: result.sourceRevision,
              target: "images",
              ticketId: result.ticketId,
          }
        : {
              confirmation: "prune-docker-volumes",
              idempotencyKey,
              operation: "prune-execute",
              sourceRevision: result.sourceRevision,
              target: "volumes",
              ticketId: result.ticketId,
          };
}

function freshnessBadge(overview: DockerOverview) {
    switch (overview.state) {
        case "fresh": {
            return <Badge variant="success">Fresh snapshot</Badge>;
        }
        case "last-known-good": {
            return <Badge variant="warning">Last-known-good snapshot</Badge>;
        }
        case "unavailable": {
            return <Badge variant="danger">Snapshot unavailable</Badge>;
        }
    }
}

function FreshnessBanner({ overview }: { readonly overview: DockerOverview }) {
    switch (overview.state) {
        case "fresh": {
            return (
                <Alert
                    focusOnError={false}
                    message={
                        "Docker state is fresh as of " +
                        formatDashboardDateTime(overview.observedAtMs) +
                        ". Exact controls are available."
                    }
                    variant="success"
                />
            );
        }
        case "last-known-good": {
            return (
                <Alert
                    focusOnError={false}
                    message={
                        "Showing last-known-good Docker state from " +
                        formatDashboardDateTime(overview.observedAtMs) +
                        ". Mutations and live logs are disabled until a fresh snapshot is available."
                    }
                    variant="warning"
                />
            );
        }
        case "unavailable": {
            return (
                <Alert
                    focusOnError={false}
                    message="No usable Docker snapshot is available. Inventory, mutations, and live logs are unavailable."
                    variant="warning"
                />
            );
        }
    }
}

interface DockerSummaryProps {
    readonly overview: Exclude<DockerOverview, { readonly state: "unavailable" }>;
}

function DockerSummary({ overview }: DockerSummaryProps) {
    const running = overview.containers.filter(({ state }) => state === "running").length;
    const unhealthy = overview.containers.filter(
        ({ health }) => health === "unhealthy"
    ).length;
    const composeManaged = overview.containers.filter(
        ({ project, service }) => project !== undefined && service !== undefined
    ).length;
    const imageBytes = overview.images.reduce(
        (total, image) => total + image.sizeBytes,
        0
    );
    return (
        <section aria-labelledby="docker-summary-heading">
            <Heading id="docker-summary-heading" level={2}>
                Engine summary
            </Heading>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                    description={overview.containers.length + " discovered in total"}
                    icon={Boxes}
                    title="Running containers"
                    value={running + " / " + overview.containers.length}
                />
                <MetricCard
                    description="Containers reporting an unhealthy health check"
                    icon={HeartPulse}
                    title="Unhealthy"
                    value={unhealthy}
                />
                <MetricCard
                    description="Containers with a complete Compose identity"
                    icon={Layers3}
                    title="Compose managed"
                    value={composeManaged}
                />
                <MetricCard
                    description={overview.images.length + " Engine images"}
                    icon={Package}
                    title="Image storage"
                    value={formatByteCount(imageBytes)}
                />
            </div>
        </section>
    );
}

interface DockerStackControlsProps {
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly onRequest: (
        operation: "stack-restart" | "stack-start" | "stack-stop"
    ) => void;
}

function DockerStackControls({ busy, disabled, onRequest }: DockerStackControlsProps) {
    return (
        <Card aria-labelledby="docker-stack-heading">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                    <span className="bg-accent-500/10 shrink-0 rounded-lg p-2.5">
                        <Icon icon={Layers3} tone="accent" />
                    </span>
                    <div>
                        <Heading id="docker-stack-heading" level={2}>
                            Compose stack
                        </Heading>
                        <Text className="mt-1" tone="muted">
                            Fixed root-stack controls use the discovered source revision.
                        </Text>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button
                        aria-label="Start Docker stack"
                        disabled={disabled || busy}
                        onClick={() => onRequest("stack-start")}
                        size="sm"
                        variant="secondary"
                    >
                        <Icon icon={Play} size="sm" />
                        Start stack
                    </Button>
                    <Button
                        aria-label="Stop Docker stack"
                        disabled={disabled || busy}
                        onClick={() => onRequest("stack-stop")}
                        size="sm"
                        variant="secondary"
                    >
                        <Icon icon={Square} size="sm" />
                        Stop stack
                    </Button>
                    <Button
                        aria-label="Restart Docker stack"
                        disabled={disabled || busy}
                        onClick={() => onRequest("stack-restart")}
                        size="sm"
                        variant="secondary"
                    >
                        <Icon icon={RotateCw} size="sm" />
                        Restart stack
                    </Button>
                </div>
            </div>
        </Card>
    );
}

interface DockerQueuedResultProps {
    readonly onDismiss: () => void;
    readonly result: DockerRequestOperationResult;
}

function DockerQueuedResult({ onDismiss, result }: DockerQueuedResultProps) {
    return (
        <Card aria-labelledby="docker-operation-result-heading">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <Heading id="docker-operation-result-heading" level={2}>
                        Docker operation queued
                    </Heading>
                    <Text className="mt-1" tone="muted">
                        The API confirmed {result.operation}. No runtime success is
                        assumed.
                    </Text>
                    <code className="text-primary-400 mt-2 block text-xs wrap-anywhere">
                        {result.jobRunId}
                    </code>
                </div>
                <div className="flex flex-wrap gap-2">
                    <ActionLink
                        search={{ runId: result.jobRunId }}
                        size="sm"
                        to="/jobs"
                        variant="primary"
                    >
                        <Icon icon={ExternalLink} size="sm" />
                        View job
                    </ActionLink>
                    <Button onClick={onDismiss} size="sm" variant="ghost">
                        <Icon icon={X} size="sm" />
                        Dismiss
                    </Button>
                </div>
            </div>
        </Card>
    );
}

interface DockerRouteProps {
    readonly client: DockerClient;
}

/** @returns Complete fresh-gated Docker observability and exact control page. */
export function DockerRoute({ client }: DockerRouteProps) {
    const mutationBoundary = useAuthenticatedMutationBoundary();
    const overviewQuery = useQuery(dockerOverviewQueryOptions(client));
    const overview = overviewQuery.data;
    const controlsAvailable = overview?.state === "fresh" && overviewQuery.error === null;
    const [pendingOperation, setPendingOperation] = useState<DockerOperationPrompt>();
    const [operationBusy, setOperationBusy] = useState(false);
    const [operationError, setOperationError] = useState<string>();
    const [queuedResult, setQueuedResult] = useState<DockerRequestOperationResult>();
    const [refreshBusy, setRefreshBusy] = useState(false);
    const [refreshError, setRefreshError] = useState<string>();
    const [refreshIdempotencyKey, setRefreshIdempotencyKey] = useState(() =>
        createDockerIdempotencyKey()
    );
    const [refreshRunId, setRefreshRunId] = useState<string>();
    const [prunePreview, setPrunePreview] = useState<DockerPrunePreview>();
    const [preparingPrune, setPreparingPrune] = useState<"images" | "volumes">();
    const [detailsContainerId, setDetailsContainerId] = useState<string>();
    const [logsSelection, setLogsSelection] = useState<DockerLogsSelection>();
    const [logsTail, setLogsTail] = useState<100 | 200 | 500>(200);
    const detailsContainer =
        detailsContainerId === undefined ||
        overview === undefined ||
        overview.state === "unavailable"
            ? undefined
            : overview.containers.find(({ id }) => id === detailsContainerId);
    const logsSourceCurrent =
        controlsAvailable &&
        logsSelection !== undefined &&
        overview.sourceRevision === logsSelection.sourceRevision;
    const logsQuery = useQuery({
        enabled: logsSourceCurrent,
        queryFn: ({ signal }) => {
            if (logsSelection === undefined) {
                return Promise.reject(new TypeError("Docker log selection is missing"));
            }
            return client.query(
                "docker.getContainerLogs",
                {
                    containerId: logsSelection.containerId,
                    sourceRevision: logsSelection.sourceRevision,
                    tail: logsTail,
                },
                { signal }
            );
        },
        queryKey: [
            "docker",
            "container-logs",
            logsSelection?.sourceRevision,
            logsSelection?.containerId,
            logsTail,
        ],
        retry: false,
    });
    const busy = operationBusy || preparingPrune !== undefined || refreshBusy;
    const freshRevision =
        controlsAvailable && overview.state === "fresh"
            ? overview.sourceRevision
            : undefined;

    function showPrompt(prompt: DockerOperationPrompt): void {
        setOperationError(undefined);
        setQueuedResult(undefined);
        setPendingOperation(prompt);
    }

    async function refreshSnapshot(): Promise<void> {
        if (refreshBusy || operationBusy) return;
        setRefreshBusy(true);
        setRefreshError(undefined);
        setRefreshRunId(undefined);
        try {
            const run = await mutationBoundary.run((signal) =>
                client.mutation(
                    "cache.refreshEntry",
                    {
                        idempotencyKey: refreshIdempotencyKey,
                        key: dockerOverviewCacheKey,
                    },
                    { signal }
                )
            );
            if (!mutationBoundary.completionIsCurrent()) return;
            setRefreshRunId(run.id);
            setRefreshIdempotencyKey(createDockerIdempotencyKey());
            void overviewQuery.refetch();
        } catch (error) {
            if (mutationBoundary.completionIsCurrent()) {
                setRefreshError(dockerFailureMessage(error));
            }
        } finally {
            if (mutationBoundary.completionIsCurrent()) setRefreshBusy(false);
        }
    }

    async function queueOperation(input: DockerRequestOperationInput): Promise<boolean> {
        if (
            freshRevision === undefined ||
            input.sourceRevision !== freshRevision ||
            operationBusy
        ) {
            setOperationError(
                "A fresh matching Docker snapshot is required before queueing this operation."
            );
            return false;
        }
        setOperationBusy(true);
        setOperationError(undefined);
        setQueuedResult(undefined);
        try {
            const result = await mutationBoundary.run((signal) =>
                client.mutation("docker.requestOperation", input, { signal })
            );
            if (!mutationBoundary.completionIsCurrent()) return false;
            setQueuedResult(result);
            void overviewQuery.refetch();
            return true;
        } catch (error) {
            if (mutationBoundary.completionIsCurrent()) {
                setOperationError(dockerFailureMessage(error));
            }
            return false;
        } finally {
            if (mutationBoundary.completionIsCurrent()) setOperationBusy(false);
        }
    }

    function requestContainerOperation(
        operation: "container-restart" | "container-start" | "container-stop",
        container: DockerContainer
    ): void {
        if (freshRevision !== undefined) {
            showPrompt(containerOperationPrompt(container, operation, freshRevision));
        }
    }

    async function preparePrune(target: "images" | "volumes"): Promise<void> {
        if (freshRevision === undefined || preparingPrune !== undefined) return;
        setPreparingPrune(target);
        setOperationError(undefined);
        setQueuedResult(undefined);
        try {
            const result = await mutationBoundary.run((signal) =>
                client.query(
                    "docker.preparePrune",
                    { sourceRevision: freshRevision, target },
                    { signal }
                )
            );
            if (mutationBoundary.completionIsCurrent()) {
                setPrunePreview({
                    idempotencyKey: createDockerIdempotencyKey(),
                    result,
                });
            }
        } catch (error) {
            if (mutationBoundary.completionIsCurrent()) {
                setOperationError(dockerFailureMessage(error));
            }
        } finally {
            if (mutationBoundary.completionIsCurrent()) setPreparingPrune(undefined);
        }
    }

    async function confirmPendingOperation(): Promise<void> {
        if (pendingOperation === undefined) return;
        if (await queueOperation(pendingOperation.input)) {
            setPendingOperation(undefined);
        }
    }

    async function confirmPrune(): Promise<void> {
        if (prunePreview === undefined) return;
        if (Date.now() >= prunePreview.result.expiresAtMs) {
            setOperationError(
                "This prune ticket expired. Close it and prepare a new preview."
            );
            return;
        }
        if (
            await queueOperation(
                pruneInput(prunePreview.result, prunePreview.idempotencyKey)
            )
        ) {
            setPrunePreview(undefined);
        }
    }

    const pendingSourceCurrent =
        pendingOperation === undefined ||
        (freshRevision !== undefined &&
            pendingOperation.input.sourceRevision === freshRevision);
    const pruneSourceCurrent =
        prunePreview === undefined ||
        (freshRevision !== undefined &&
            prunePreview.result.sourceRevision === freshRevision);
    let logsError: string | undefined;
    if (logsSelection !== undefined && !logsSourceCurrent) {
        logsError = "A fresh matching Docker snapshot is required to read live logs.";
    } else if (logsQuery.error !== null) {
        logsError = dockerFailureMessage(logsQuery.error);
    }

    return (
        <div>
            <PageHeader
                actions={
                    <div className="flex flex-wrap gap-2">
                        <ActionLink to="/terminal" variant="secondary">
                            <Icon icon={SquareTerminal} size="sm" />
                            Open terminal
                        </ActionLink>
                        <Button
                            busy={refreshBusy}
                            busyLabel="Queueing refresh…"
                            disabled={operationBusy}
                            onClick={() => void refreshSnapshot()}
                            variant="secondary"
                        >
                            <Icon icon={RefreshCw} size="sm" />
                            Refresh snapshot
                        </Button>
                    </div>
                }
                description="Inspect the bounded Docker Engine and Compose projection, then queue exact audited operations."
                eyebrow="Operations"
                title="Docker"
            />
            <div className="mt-8">
                {overviewQuery.isPending && overview === undefined && (
                    <PageState label="Loading Docker…" size="lg" status="loading" />
                )}
                {!overviewQuery.isPending && overview === undefined && (
                    <PageState
                        message={dockerFailureMessage(overviewQuery.error)}
                        onRetry={() => void overviewQuery.refetch()}
                        retryBusy={overviewQuery.isFetching}
                        status="error"
                        title="Docker unavailable"
                    />
                )}
                {overview !== undefined && (
                    <div className="space-y-6">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            {freshnessBadge(overview)}
                            <Text size="sm" tone="muted">
                                Checked {formatDashboardDateTime(overview.checkedAtMs)}
                            </Text>
                        </div>
                        <FreshnessBanner overview={overview} />
                        {overviewQuery.error !== null && (
                            <Alert
                                focusOnError={false}
                                message={
                                    dockerFailureMessage(overviewQuery.error) +
                                    " Docker controls remain disabled until refresh succeeds."
                                }
                            />
                        )}
                        {refreshError !== undefined && (
                            <Alert
                                message={refreshError}
                                onDismiss={() => setRefreshError(undefined)}
                            />
                        )}
                        {refreshRunId !== undefined && (
                            <Card>
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <Text>Docker snapshot refresh queued.</Text>
                                    <ActionLink
                                        search={{ runId: refreshRunId }}
                                        to="/jobs"
                                        variant="ghost"
                                    >
                                        <Icon icon={ExternalLink} size="sm" />
                                        View refresh job
                                    </ActionLink>
                                </div>
                            </Card>
                        )}
                        {operationError !== undefined &&
                            pendingOperation === undefined &&
                            prunePreview === undefined && (
                                <Alert
                                    message={operationError}
                                    onDismiss={() => setOperationError(undefined)}
                                />
                            )}
                        {queuedResult !== undefined && (
                            <DockerQueuedResult
                                onDismiss={() => setQueuedResult(undefined)}
                                result={queuedResult}
                            />
                        )}
                        {overview.state === "unavailable" ? (
                            <EmptyState
                                action={
                                    <Button
                                        busy={overviewQuery.isFetching}
                                        busyLabel="Retrying Docker…"
                                        onClick={() => void overviewQuery.refetch()}
                                        variant="secondary"
                                    >
                                        Retry
                                    </Button>
                                }
                                description="Wait for the worker-owned Docker discovery snapshot to recover."
                                icon={ServerOff}
                                title="Docker inventory unavailable"
                            />
                        ) : (
                            <>
                                <DockerSummary overview={overview} />
                                <DockerStackControls
                                    busy={busy}
                                    disabled={!controlsAvailable}
                                    onRequest={(operation) => {
                                        if (freshRevision !== undefined) {
                                            showPrompt(
                                                stackOperationPrompt(
                                                    operation,
                                                    freshRevision
                                                )
                                            );
                                        }
                                    }}
                                />
                                <DockerUpdaterPanel
                                    busy={busy}
                                    controlsDisabled={!controlsAvailable}
                                    events={overview.updaterEvents}
                                    onRun={() => {
                                        if (freshRevision !== undefined) {
                                            showPrompt(
                                                updaterOperationPrompt(
                                                    "updater-run",
                                                    freshRevision
                                                )
                                            );
                                        }
                                    }}
                                    onScan={() => {
                                        if (freshRevision !== undefined) {
                                            showPrompt(
                                                updaterOperationPrompt(
                                                    "updater-scan",
                                                    freshRevision
                                                )
                                            );
                                        }
                                    }}
                                    onUpdateService={(service) => {
                                        if (freshRevision !== undefined) {
                                            showPrompt(
                                                serviceUpdatePrompt(
                                                    service,
                                                    freshRevision
                                                )
                                            );
                                        }
                                    }}
                                    services={overview.updaterServices}
                                />
                                <DockerContainersTable
                                    busy={busy}
                                    containers={overview.containers}
                                    controlsDisabled={!controlsAvailable}
                                    onOpenDetails={(container) =>
                                        setDetailsContainerId(container.id)
                                    }
                                    onOpenLogs={(container) => {
                                        if (freshRevision !== undefined) {
                                            setLogsSelection({
                                                containerId: container.id,
                                                containerName: container.name,
                                                sourceRevision: freshRevision,
                                            });
                                        }
                                    }}
                                    onRequestOperation={requestContainerOperation}
                                />
                                <DockerResourcePanels
                                    busy={busy}
                                    containers={overview.containers}
                                    controlsDisabled={!controlsAvailable}
                                    images={overview.images}
                                    onDeleteImage={(image) => {
                                        if (freshRevision !== undefined) {
                                            showPrompt(
                                                imageDeletePrompt(image, freshRevision)
                                            );
                                        }
                                    }}
                                    onDeleteVolume={(volume) => {
                                        if (freshRevision !== undefined) {
                                            showPrompt(
                                                volumeDeletePrompt(volume, freshRevision)
                                            );
                                        }
                                    }}
                                    onPreviewPrune={(target) => void preparePrune(target)}
                                    volumes={overview.volumes}
                                />
                            </>
                        )}
                    </div>
                )}
            </div>
            <ConfirmModal
                busy={operationBusy}
                confirmDisabled={!pendingSourceCurrent}
                confirmLabel={pendingOperation?.confirmLabel}
                danger={pendingOperation?.danger}
                description={
                    pendingOperation?.description ?? "No Docker operation is selected."
                }
                error={operationError}
                onCancel={() => {
                    if (!operationBusy) {
                        setPendingOperation(undefined);
                        setOperationError(undefined);
                    }
                }}
                onConfirm={() => void confirmPendingOperation()}
                open={pendingOperation !== undefined}
                title={pendingOperation?.title ?? "Confirm Docker operation"}
            />
            <DockerPrunePreviewDialog
                busy={operationBusy}
                error={operationError}
                onClose={() => {
                    if (!operationBusy) {
                        setPrunePreview(undefined);
                        setOperationError(undefined);
                    }
                }}
                onConfirm={() => void confirmPrune()}
                preview={prunePreview}
                sourceCurrent={pruneSourceCurrent}
            />
            <DockerContainerDetailsDialog
                container={detailsContainer}
                onClose={() => setDetailsContainerId(undefined)}
            />
            <DockerLogsDialog
                error={logsError}
                loading={logsQuery.isPending}
                logs={logsSourceCurrent ? logsQuery.data : undefined}
                onClose={() => setLogsSelection(undefined)}
                onRefresh={() => void logsQuery.refetch()}
                onTailChange={setLogsTail}
                refreshing={logsQuery.isFetching}
                selection={logsSelection}
                tail={logsTail}
            />
        </div>
    );
}
