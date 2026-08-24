import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import type {
    BackupRequestOperationResult,
    KopiaBackupStatus,
    WalgBackupStatus,
} from "../../contracts/backups.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Text } from "../ui/Text.tsx";
import {
    authenticatedBackupIdentity,
    backupRequestFingerprint,
    BackupRecoveryError,
    clearBackupRecovery,
    readOrCreateBackupIdempotencyKey,
    type BackupBrowserOperation,
} from "./backupOperations.ts";

const backupKopiaStatusQueryKey = ["backups", "kopia"] as const;
const backupWalgStatusQueryKey = ["backups", "walg"] as const;
const statusRefreshIntervalMs = 60_000;

type ProviderStatus = KopiaBackupStatus | WalgBackupStatus;

export interface BackupOverviewSectionViewProps {
    readonly controlsDisabled?: boolean;
    readonly error?: string;
    readonly kopia?: KopiaBackupStatus;
    readonly loading?: boolean;
    readonly mutationBusy?: "kopia" | "walg";
    readonly onClearKopiaAttention?: () => void;
    readonly onClearWalgAttention?: () => void;
    readonly onRetry?: () => void;
    readonly onRetryKopia?: () => void;
    readonly onRetryWalg?: () => void;
    readonly onRunKopia?: () => void;
    readonly onRunWalg?: () => void;
    readonly queued?: BackupRequestOperationResult;
    readonly walg?: WalgBackupStatus;
}

function freshnessBadge(status: ProviderStatus) {
    if (status.state === "fresh") return <Badge variant="success">Fresh</Badge>;
    if (status.state === "last-known-good") {
        return <Badge variant="warning">Last known good</Badge>;
    }
    return <Badge variant="danger">Unavailable</Badge>;
}

function activityBadge(status: ProviderStatus) {
    const activity = status.activity.state;
    if (activity === "needs-attention") {
        return <Badge variant="danger">Needs attention</Badge>;
    }
    if (activity === "queued") return <Badge variant="info">Queued</Badge>;
    if (activity === "running") return <Badge variant="info">Running</Badge>;
    if (activity === "failed") return <Badge variant="danger">Failed</Badge>;
    if (status.state !== "unavailable" && !status.payload.providerIdle) {
        return <Badge variant="info">Busy</Badge>;
    }
    if (activity === "succeeded") return <Badge variant="success">Succeeded</Badge>;
    return <Badge>Idle</Badge>;
}

function providerUnavailable(status: ProviderStatus): boolean {
    return (
        status.state !== "fresh" ||
        !status.payload.providerIdle ||
        status.activity.state === "queued" ||
        status.activity.state === "running"
    );
}

interface ProviderCardProps {
    readonly controlsDisabled: boolean;
    readonly mutationBusy: boolean;
    readonly onClearAttention?: () => void;
    readonly onRun?: () => void;
    readonly status: ProviderStatus;
    readonly title: string;
}

function ProviderCard({
    controlsDisabled,
    mutationBusy,
    onClearAttention,
    onRun,
    status,
    title,
}: ProviderCardProps) {
    const needsAttention = status.activity.state === "needs-attention";
    const disabled = controlsDisabled || providerUnavailable(status) || mutationBusy;
    return (
        <Card aria-label={`${title} backup`} className="bg-primary-900/35">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <Heading level={3}>{title}</Heading>
                    <Text className="mt-1" tone="muted">
                        Checked {formatDashboardDateTime(status.checkedAtMs)}
                    </Text>
                </div>
                <div className="flex flex-wrap gap-2">
                    {freshnessBadge(status)}
                    {activityBadge(status)}
                </div>
            </div>
            {status.state === "unavailable" ? (
                <Text className="mt-5" tone="warning">
                    No trustworthy provider status is currently available.
                </Text>
            ) : (
                <div className="mt-5 grid gap-2 text-sm sm:grid-cols-2">
                    <Text>
                        Backups <strong>{status.payload.backupCount}</strong>
                    </Text>
                    <Text tone={status.payload.healthy ? "success" : "warning"}>
                        {status.payload.healthy ? "Healthy" : "Attention required"}
                    </Text>
                    {status.payload.type === "kopia" && (
                        <Text className="sm:col-span-2" tone="muted">
                            {status.payload.sources.length} validated read-only source
                            {status.payload.sources.length === 1 ? "" : "s"}
                        </Text>
                    )}
                    {status.payload.type === "walg" &&
                        status.payload.latestCompletedAtMs !== undefined && (
                            <Text className="sm:col-span-2" tone="muted">
                                Latest backup{" "}
                                {formatDashboardDateTime(
                                    status.payload.latestCompletedAtMs
                                )}
                            </Text>
                        )}
                </div>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
                {needsAttention ? (
                    <Button
                        busy={mutationBusy}
                        busyLabel={`Clearing ${title} attention…`}
                        disabled={disabled}
                        onClick={onClearAttention}
                        size="sm"
                        variant="danger"
                    >
                        Clear attention
                    </Button>
                ) : (
                    <Button
                        busy={mutationBusy}
                        busyLabel={`Queuing ${title} backup…`}
                        disabled={disabled}
                        onClick={onRun}
                        size="sm"
                    >
                        Run backup
                    </Button>
                )}
                {status.activity.state !== "idle" && (
                    <ActionLink
                        search={{ runId: status.activity.jobRunId }}
                        size="sm"
                        to="/jobs"
                        variant="ghost"
                    >
                        <Icon icon={ExternalLink} size="sm" />
                        View job
                    </ActionLink>
                )}
            </div>
            {controlsDisabled && (
                <Text className="mt-3" size="sm" tone="muted">
                    Backup controls are disabled for this session.
                </Text>
            )}
        </Card>
    );
}

function MissingProviderCard({
    loading,
    onRetry,
    title,
}: {
    readonly loading: boolean;
    readonly onRetry?: () => void;
    readonly title: string;
}) {
    return (
        <Card aria-label={`${title} backup`} className="bg-primary-900/35">
            <Heading level={3}>{title}</Heading>
            {loading ? (
                <PageState label={`Loading ${title} backup status…`} status="loading" />
            ) : (
                <div className="mt-4">
                    <Text tone="warning">
                        No trustworthy provider status is currently available.
                    </Text>
                    {onRetry !== undefined && (
                        <Button
                            className="mt-4"
                            onClick={onRetry}
                            size="sm"
                            variant="secondary"
                        >
                            Retry
                        </Button>
                    )}
                </div>
            )}
        </Card>
    );
}

/**
 * Pure progressive root section used by Storybook and the connected wrapper.
 *
 * @param props - Independent status, action, and progressive-state inputs.
 * @returns The backup overview section.
 */
export function BackupOverviewSectionView({
    controlsDisabled = false,
    error,
    kopia,
    loading = false,
    mutationBusy,
    onClearKopiaAttention,
    onClearWalgAttention,
    onRetry,
    onRetryKopia,
    onRetryWalg,
    onRunKopia,
    onRunWalg,
    queued,
    walg,
}: BackupOverviewSectionViewProps) {
    if (loading && kopia === undefined && walg === undefined) {
        return (
            <Card aria-label="Backups">
                <PageState label="Loading backup status…" status="loading" />
            </Card>
        );
    }
    if (kopia === undefined && walg === undefined) {
        return (
            <PageState
                headingLevel={2}
                message={error ?? "Backup status is temporarily unavailable."}
                onRetry={onRetry}
                status="error"
                title="Backups unavailable"
            />
        );
    }
    return (
        <section aria-labelledby="backup-overview-heading">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <Heading id="backup-overview-heading" level={2}>
                        Backups
                    </Heading>
                    <Text className="mt-1" tone="muted">
                        Durable Kopia and WAL-G operations with independent saved status.
                    </Text>
                </div>
                <ActionLink size="sm" to="/jobs" variant="ghost">
                    <Icon icon={ExternalLink} size="sm" />
                    All backup jobs
                </ActionLink>
            </div>
            {error !== undefined && (
                <Alert className="mt-4" message={error} variant="error" />
            )}
            {queued !== undefined && (
                <Alert
                    className="mt-4"
                    focusOnError={false}
                    message={`${queued.type === "kopia" ? "Kopia" : "WAL-G"} ${queued.operation === "run" ? "run" : "attention clearance"} queued. Runtime success is not assumed.`}
                    variant="success"
                />
            )}
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
                {kopia === undefined ? (
                    <MissingProviderCard
                        loading={loading}
                        onRetry={onRetryKopia ?? onRetry}
                        title="Kopia"
                    />
                ) : (
                    <ProviderCard
                        controlsDisabled={controlsDisabled}
                        mutationBusy={mutationBusy === "kopia"}
                        onClearAttention={onClearKopiaAttention}
                        onRun={onRunKopia}
                        status={kopia}
                        title="Kopia"
                    />
                )}
                {walg === undefined ? (
                    <MissingProviderCard
                        loading={loading}
                        onRetry={onRetryWalg ?? onRetry}
                        title="WAL-G"
                    />
                ) : (
                    <ProviderCard
                        controlsDisabled={controlsDisabled}
                        mutationBusy={mutationBusy === "walg"}
                        onClearAttention={onClearWalgAttention}
                        onRun={onRunWalg}
                        status={walg}
                        title="WAL-G"
                    />
                )}
            </div>
        </section>
    );
}

/**
 * Connected root section with no mutation replay and session-bound recovery keys.
 *
 * @returns The authenticated backup overview section.
 */
export function BackupOverviewSection() {
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const boundary = useAuthenticatedMutationBoundary();
    const [mutationBusy, setMutationBusy] = useState<"kopia" | "walg">();
    const [mutationError, setMutationError] = useState<string>();
    const [queued, setQueued] = useState<BackupRequestOperationResult>();
    const kopiaQuery = useQuery({
        queryFn: ({ signal }) => client.query("backups.getKopiaStatus", {}, { signal }),
        queryKey: backupKopiaStatusQueryKey,
        refetchInterval: statusRefreshIntervalMs,
        retry: false,
    });
    const walgQuery = useQuery({
        queryFn: ({ signal }) => client.query("backups.getWalgStatus", {}, { signal }),
        queryKey: backupWalgStatusQueryKey,
        refetchInterval: statusRefreshIntervalMs,
        retry: false,
    });

    async function submit(type: "kopia" | "walg", operation: BackupBrowserOperation) {
        const status = type === "kopia" ? kopiaQuery.data : walgQuery.data;
        if (status === undefined || status.state !== "fresh") return;
        const attentionRunId =
            status.activity.state === "needs-attention"
                ? status.activity.jobRunId
                : undefined;
        setMutationBusy(type);
        setMutationError(undefined);
        setQueued(undefined);
        try {
            const result = await boundary.run((signal) => {
                const identity = authenticatedBackupIdentity(boundary.queryClient);
                if (identity === undefined) throw new BackupRecoveryError();
                const key = readOrCreateBackupIdempotencyKey({
                    fingerprint: backupRequestFingerprint(status, operation),
                    identity,
                    operation,
                    type,
                });
                if (type === "kopia" && operation === "run") {
                    return client.mutation(
                        "backups.runKopia",
                        {
                            confirmation: "run-kopia-backup",
                            idempotencyKey: key,
                            sourceRevision: status.payload.sourceRevision,
                        },
                        { signal }
                    );
                }
                if (type === "walg" && operation === "run") {
                    return client.mutation(
                        "backups.runWalg",
                        {
                            confirmation: "run-walg-backup",
                            idempotencyKey: key,
                            sourceRevision: status.payload.sourceRevision,
                        },
                        { signal }
                    );
                }
                if (attentionRunId === undefined) {
                    return Promise.reject(new Error("Backup attention changed"));
                }
                return type === "kopia"
                    ? client.mutation(
                          "backups.clearKopiaAttention",
                          {
                              attentionRunId,
                              confirmation: "clear-kopia-backup-attention",
                              idempotencyKey: key,
                              sourceRevision: status.payload.sourceRevision,
                          },
                          { signal }
                      )
                    : client.mutation(
                          "backups.clearWalgAttention",
                          {
                              attentionRunId,
                              confirmation: "clear-walg-backup-attention",
                              idempotencyKey: key,
                              sourceRevision: status.payload.sourceRevision,
                          },
                          { signal }
                      );
            });
            if (!boundary.completionIsCurrent()) return;
            const identity = authenticatedBackupIdentity(boundary.queryClient);
            const recoveryCleared =
                identity !== undefined &&
                clearBackupRecovery({ identity, operation, type });
            setQueued(result);
            if (!recoveryCleared) {
                setMutationError(
                    "The request was confirmed queued, but Dashboard could not clear its browser recovery key. Do not create a new request identity."
                );
            }
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: backupKopiaStatusQueryKey }),
                queryClient.invalidateQueries({ queryKey: backupWalgStatusQueryKey }),
            ]);
        } catch (error) {
            if (boundary.completionIsCurrent()) {
                setMutationError(
                    error instanceof BackupRecoveryError
                        ? "Dashboard could not persist a safe recovery key in this browser session. The backup request was not submitted."
                        : dashboardBrowserFailureMessage(error)
                );
            }
        } finally {
            setMutationBusy(undefined);
        }
    }

    const readError = kopiaQuery.error ?? walgQuery.error;
    return (
        <BackupOverviewSectionView
            error={
                mutationError ??
                (readError === null
                    ? undefined
                    : dashboardBrowserFailureMessage(readError))
            }
            kopia={kopiaQuery.data}
            loading={kopiaQuery.isPending || walgQuery.isPending}
            mutationBusy={mutationBusy}
            onClearKopiaAttention={() => void submit("kopia", "clear-attention")}
            onClearWalgAttention={() => void submit("walg", "clear-attention")}
            onRetry={() => {
                void Promise.allSettled([kopiaQuery.refetch(), walgQuery.refetch()]);
            }}
            onRetryKopia={() => void kopiaQuery.refetch()}
            onRetryWalg={() => void walgQuery.refetch()}
            onRunKopia={() => void submit("kopia", "run")}
            onRunWalg={() => void submit("walg", "run")}
            queued={queued}
            walg={walgQuery.data}
        />
    );
}
