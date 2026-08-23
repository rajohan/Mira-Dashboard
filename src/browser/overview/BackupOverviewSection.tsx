import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, FolderArchive } from "lucide-react";
import { useState } from "react";

import type {
    BackupRequestOperationResult,
    KopiaBackupStatus,
    WalgBackupStatus,
} from "../../contracts/backups.ts";
import { backupRunScheduleIds } from "../../contracts/backups.ts";
import type { DatabaseOverview } from "../../contracts/database.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import { databaseOverviewQueryOptions } from "../database/databaseQueries.ts";
import { useRunScheduleMutation } from "../jobs/jobMutations.ts";
import { jobRunStateBadgeVariant, jobRunStateLabel } from "../jobs/jobRunPresentation.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { formatByteCount } from "../lib/formatMeasurements.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
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
const sqliteMaintenanceScheduleId = "database.sqlite-maintenance";
const statusRefreshIntervalMs = 60_000;

type ProviderStatus = KopiaBackupStatus | WalgBackupStatus;
type SqliteVerificationLevel = "manifest-verified" | "restore-copy-verified";

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
    readonly onRunSqlite?: () => void;
    readonly onRunWalg?: () => void;
    readonly queued?: BackupRequestOperationResult;
    readonly sqlite?: DatabaseOverview["sqlite"];
    readonly sqliteBusy?: boolean;
    readonly walg?: WalgBackupStatus;
}

function freshnessBadge(status: ProviderStatus) {
    if (status.state === "fresh") return <Badge variant="success">Fresh</Badge>;
    if (status.state === "last-known-good") {
        return <Badge variant="warning">Last known good</Badge>;
    }
    return <Badge variant="danger">Unavailable</Badge>;
}

function sqliteVerificationLabel(
    verificationLevel: SqliteVerificationLevel | undefined
): string {
    if (verificationLevel === undefined) return "Unknown";
    return verificationLevel === "restore-copy-verified"
        ? "Restore verified"
        : "Manifest verified";
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

function providerType(status: ProviderStatus): "kopia" | "walg" {
    return status.state === "unavailable" ? status.type : status.payload.type;
}

function sourceHealthLabel(health: "current" | "missing" | "stale"): string {
    if (health === "current") return "Fresh";
    return health === "stale" ? "Stale" : "Missing";
}

function sqliteFreshnessLabel(sqlite: DatabaseOverview["sqlite"] | undefined): string {
    if (sqlite === undefined || sqlite.state === "unavailable") return "Unavailable";
    return sqlite.state === "fresh" ? "Fresh" : "Last known good";
}

interface ProviderCardProps {
    readonly ariaLabel?: string;
    readonly mutationBusy: boolean;
    readonly onClearAttention?: () => void;
    readonly status: ProviderStatus;
    readonly title: string;
}

function ProviderCard({
    ariaLabel,
    mutationBusy,
    onClearAttention,
    status,
    title,
}: ProviderCardProps) {
    const needsAttention = status.activity.state === "needs-attention";
    const disabled = providerUnavailable(status) || mutationBusy;
    return (
        <section
            aria-label={ariaLabel ?? `${title} backup`}
            className="border-primary-700 bg-primary-900/35 rounded-lg border p-3"
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <Heading level={3}>{title}</Heading>
                </div>
                <div className="flex flex-wrap gap-2">
                    {freshnessBadge(status)}
                    {activityBadge(status)}
                </div>
            </div>
            {status.state === "unavailable" && (
                <Text className="mt-5" tone="warning">
                    No trustworthy provider status is currently available.
                </Text>
            )}
            {status.state !== "unavailable" && status.payload.type === "walg" && (
                <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                        <Text className="text-xs uppercase" size="sm" tone="muted">
                            Latest Postgres backup
                        </Text>
                        <Text className="mt-1 font-mono text-xs break-all">
                            {status.payload.latestBackupName ?? "Unknown"}
                        </Text>
                    </div>
                    <div>
                        <Text className="text-xs uppercase" size="sm" tone="muted">
                            Finished
                        </Text>
                        <Text className="mt-1">
                            {status.payload.latestCompletedAtMs === undefined
                                ? "No backup yet"
                                : formatDashboardDateTime(
                                      status.payload.latestCompletedAtMs
                                  )}
                        </Text>
                    </div>
                    <div>
                        <Text className="text-xs uppercase" size="sm" tone="muted">
                            WAL file
                        </Text>
                        <Text className="mt-1 font-mono text-xs break-all">
                            {status.payload.latestWalFileName ?? "Unknown"}
                        </Text>
                    </div>
                    <div>
                        <Text className="text-xs uppercase" size="sm" tone="muted">
                            Backup count
                        </Text>
                        <Text className="mt-1 tabular-nums">
                            {status.payload.backupCount}
                        </Text>
                    </div>
                </div>
            )}
            {(needsAttention || status.activity.state !== "idle") && (
                <div className="mt-4 flex flex-wrap gap-2">
                    {needsAttention && (
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
                    )}
                    {status.activity.state !== "idle" && (
                        <ActionLink
                            search={{
                                runId: status.activity.jobRunId,
                                scheduleId: backupRunScheduleIds[providerType(status)],
                            }}
                            size="sm"
                            to="/jobs"
                            variant="secondary"
                        >
                            View job
                        </ActionLink>
                    )}
                </div>
            )}
        </section>
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
        <section
            aria-label={`${title} backup`}
            className="border-primary-700 bg-primary-900/35 rounded-lg border p-3"
        >
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
        </section>
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
    onRunSqlite,
    onRunWalg,
    queued,
    sqlite,
    sqliteBusy = false,
    walg,
}: BackupOverviewSectionViewProps) {
    if (loading && kopia === undefined && walg === undefined) {
        return (
            <Card aria-label="Backups">
                <PageState label="Loading backup status…" status="loading" />
            </Card>
        );
    }
    if (kopia === undefined && walg === undefined && sqlite === undefined) {
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
    const sqliteInventory =
        sqlite !== undefined &&
        sqlite.state !== "unavailable" &&
        sqlite.lifecycle.backupInventory.state !== "unavailable"
            ? sqlite.lifecycle.backupInventory
            : undefined;
    const latestSqliteBackup = sqliteInventory?.backups[0];
    const latestSqliteVerification = sqliteVerificationLabel(
        latestSqliteBackup?.verificationLevel
    );
    const latestSqliteRun =
        sqlite !== undefined &&
        sqlite.state !== "unavailable" &&
        sqlite.lifecycle.maintenance.state !== "unavailable"
            ? sqlite.lifecycle.maintenance.runs[0]
            : undefined;
    return (
        <section aria-label="Backup status">
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
            <div className="grid gap-4 xl:grid-cols-3">
                <Card className="order-2 h-full">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex min-w-0 gap-2">
                            <DatabaseBackup
                                aria-hidden="true"
                                className="text-accent-300 mt-0.5 size-5 shrink-0"
                            />
                            <Heading level={3}>Postgres backup</Heading>
                        </div>
                        <Button
                            aria-label="Queue Postgres backup"
                            disabled={
                                walg === undefined ||
                                controlsDisabled ||
                                mutationBusy !== undefined ||
                                providerUnavailable(walg)
                            }
                            onClick={onRunWalg}
                            size="sm"
                        >
                            Queue backup
                        </Button>
                    </div>
                    <div className="mt-4">
                        {walg === undefined ? (
                            <MissingProviderCard
                                loading={loading}
                                onRetry={onRetryWalg ?? onRetry}
                                title="WAL-G"
                            />
                        ) : (
                            <ProviderCard
                                ariaLabel="WAL-G backup"
                                mutationBusy={mutationBusy === "walg"}
                                onClearAttention={onClearWalgAttention}
                                status={walg}
                                title="Postgres backup"
                            />
                        )}
                    </div>
                </Card>
                <Card className="order-1 h-full">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex min-w-0 gap-2">
                            <FolderArchive
                                aria-hidden="true"
                                className="text-accent-300 mt-0.5 size-5 shrink-0"
                            />
                            <Heading level={3}>Kopia backup</Heading>
                        </div>
                        <Button
                            aria-label="Queue Kopia backup"
                            disabled={
                                kopia === undefined ||
                                controlsDisabled ||
                                mutationBusy !== undefined ||
                                providerUnavailable(kopia)
                            }
                            onClick={onRunKopia}
                            size="sm"
                        >
                            Queue backup
                        </Button>
                    </div>
                    <div className="mt-4">
                        {kopia === undefined && (
                            <MissingProviderCard
                                loading={loading}
                                onRetry={onRetryKopia ?? onRetry}
                                title="Kopia"
                            />
                        )}
                        {kopia !== undefined && kopia.state === "unavailable" && (
                            <ProviderCard
                                mutationBusy={mutationBusy === "kopia"}
                                onClearAttention={onClearKopiaAttention}
                                status={kopia}
                                title="Kopia"
                            />
                        )}
                        {kopia !== undefined && kopia.state !== "unavailable" && (
                            <section aria-label="Kopia backup">
                                {(kopia.state !== "fresh" ||
                                    kopia.activity.state !== "succeeded") && (
                                    <div className="mb-3 flex flex-wrap justify-end gap-2">
                                        {freshnessBadge(kopia)}
                                        {activityBadge(kopia)}
                                    </div>
                                )}
                                <ul className="max-h-112 min-h-88 space-y-4 overflow-y-auto pr-2">
                                    {kopia.payload.sources.map((source) => (
                                        <li
                                            className="border-primary-700 bg-primary-900/35 rounded-lg border p-3"
                                            key={source.id}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div>
                                                    <Text className="font-medium capitalize">
                                                        {source.id}
                                                    </Text>
                                                    <Text
                                                        className="mt-1"
                                                        size="sm"
                                                        tone="muted"
                                                    >
                                                        {source.snapshotCount} snapshot
                                                        {source.snapshotCount === 1
                                                            ? ""
                                                            : "s"}
                                                    </Text>
                                                </div>
                                                <div className="flex flex-wrap justify-end gap-2">
                                                    <Badge
                                                        variant={
                                                            source.health === "current"
                                                                ? "success"
                                                                : "warning"
                                                        }
                                                    >
                                                        {sourceHealthLabel(source.health)}
                                                    </Badge>
                                                    {source.health === "current" && (
                                                        <Badge variant="success">
                                                            Succeeded
                                                        </Badge>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="mt-3 space-y-2">
                                                {(
                                                    source.snapshots ??
                                                    (source.latestCompletedAtMs ===
                                                    undefined
                                                        ? []
                                                        : [
                                                              {
                                                                  completedAtMs:
                                                                      source.latestCompletedAtMs,
                                                                  fileCount:
                                                                      source.latestFileCount,
                                                                  retentionReasons: [],
                                                                  sizeBytes:
                                                                      source.latestSizeBytes,
                                                              },
                                                          ])
                                                ).map((snapshot) => (
                                                    <div
                                                        className="border-primary-700 bg-primary-900/35 rounded-md border p-2"
                                                        key={`${source.id}-${snapshot.completedAtMs}`}
                                                    >
                                                        <div className="flex flex-wrap items-start justify-between gap-3 text-sm">
                                                            <div className="min-w-0 flex-1">
                                                                <Text className="truncate">
                                                                    {snapshot.description ??
                                                                        "Unnamed snapshot"}
                                                                </Text>
                                                                <Text
                                                                    className="mt-1"
                                                                    size="sm"
                                                                    tone="muted"
                                                                >
                                                                    Finished:{" "}
                                                                    {formatDashboardDateTime(
                                                                        snapshot.completedAtMs
                                                                    )}
                                                                </Text>
                                                                {snapshot.retentionReasons
                                                                    .length > 0 && (
                                                                    <div className="mt-2 flex flex-wrap gap-1">
                                                                        {snapshot.retentionReasons.map(
                                                                            (reason) => (
                                                                                <Badge
                                                                                    key={
                                                                                        reason
                                                                                    }
                                                                                >
                                                                                    {
                                                                                        reason
                                                                                    }
                                                                                </Badge>
                                                                            )
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <div className="text-right">
                                                                <Text>
                                                                    {snapshot.sizeBytes ===
                                                                    undefined
                                                                        ? "Unknown"
                                                                        : formatByteCount(
                                                                              snapshot.sizeBytes
                                                                          )}
                                                                </Text>
                                                                <Text
                                                                    className="mt-1"
                                                                    size="sm"
                                                                    tone="muted"
                                                                >
                                                                    {snapshot.fileCount ??
                                                                        "Unknown"}{" "}
                                                                    files
                                                                </Text>
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                                {(kopia.activity.state === "needs-attention" ||
                                    kopia.activity.state !== "idle") && (
                                    <div className="mt-4 flex flex-wrap gap-2">
                                        {kopia.activity.state === "needs-attention" && (
                                            <Button
                                                busy={mutationBusy === "kopia"}
                                                busyLabel="Clearing Kopia attention…"
                                                disabled={
                                                    controlsDisabled ||
                                                    providerUnavailable(kopia) ||
                                                    mutationBusy !== undefined
                                                }
                                                onClick={onClearKopiaAttention}
                                                size="sm"
                                                variant="danger"
                                            >
                                                Clear attention
                                            </Button>
                                        )}
                                        <ActionLink
                                            search={{
                                                runId: kopia.activity.jobRunId,
                                                scheduleId: backupRunScheduleIds.kopia,
                                            }}
                                            size="sm"
                                            to="/jobs"
                                            variant="secondary"
                                        >
                                            View job
                                        </ActionLink>
                                    </div>
                                )}
                            </section>
                        )}
                    </div>
                </Card>
                <Card className="order-3 h-full">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex min-w-0 gap-2">
                            <DatabaseBackup
                                aria-hidden="true"
                                className="text-accent-300 mt-0.5 size-5 shrink-0"
                            />
                            <Heading level={3}>SQLite backup</Heading>
                        </div>
                        <Button
                            aria-label="Queue SQLite backup"
                            busy={sqliteBusy}
                            busyLabel="Queuing SQLite backup…"
                            disabled={
                                sqlite === undefined ||
                                sqlite.state === "unavailable" ||
                                controlsDisabled ||
                                sqliteBusy
                            }
                            onClick={onRunSqlite}
                            size="sm"
                        >
                            Queue backup
                        </Button>
                    </div>
                    <section
                        aria-label="SQLite backup"
                        className="border-primary-700 bg-primary-900/35 mt-4 rounded-lg border p-3"
                    >
                        <div className="flex items-start justify-between gap-3">
                            <Heading level={3}>SQLite backup</Heading>
                            <div className="flex flex-wrap justify-end gap-2">
                                <Badge
                                    variant={
                                        sqlite !== undefined && sqlite.state === "fresh"
                                            ? "success"
                                            : "warning"
                                    }
                                >
                                    {sqliteFreshnessLabel(sqlite)}
                                </Badge>
                                {latestSqliteRun !== undefined && (
                                    <Badge
                                        variant={jobRunStateBadgeVariant(
                                            latestSqliteRun.state
                                        )}
                                    >
                                        {jobRunStateLabel(latestSqliteRun.state)}
                                    </Badge>
                                )}
                            </div>
                        </div>
                        {sqliteInventory === undefined ? (
                            <Text className="mt-5" tone="warning">
                                SQLite backup inventory is unavailable.
                            </Text>
                        ) : (
                            <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                                <div>
                                    <Text
                                        className="text-xs uppercase"
                                        size="sm"
                                        tone="muted"
                                    >
                                        Latest SQLite backup
                                    </Text>
                                    <Text className="mt-1 capitalize">
                                        {latestSqliteBackup === undefined
                                            ? "No backup yet"
                                            : `${latestSqliteBackup.kind} snapshot`}
                                    </Text>
                                </div>
                                <div>
                                    <Text
                                        className="text-xs uppercase"
                                        size="sm"
                                        tone="muted"
                                    >
                                        Finished
                                    </Text>
                                    <Text className="mt-1">
                                        {latestSqliteBackup === undefined
                                            ? "No backup yet"
                                            : formatDashboardDateTime(
                                                  latestSqliteBackup.createdAtMs
                                              )}
                                    </Text>
                                </div>
                                <div>
                                    <Text
                                        className="text-xs uppercase"
                                        size="sm"
                                        tone="muted"
                                    >
                                        Verification
                                    </Text>
                                    <Text className="mt-1">
                                        {latestSqliteVerification}
                                    </Text>
                                </div>
                                <div>
                                    <Text
                                        className="text-xs uppercase"
                                        size="sm"
                                        tone="muted"
                                    >
                                        Size
                                    </Text>
                                    <Text className="mt-1">
                                        {latestSqliteBackup === undefined
                                            ? "Unknown"
                                            : formatByteCount(latestSqliteBackup.bytes)}
                                    </Text>
                                </div>
                            </div>
                        )}
                        <div className="mt-4 flex justify-end">
                            <ActionLink
                                search={{
                                    ...(latestSqliteRun === undefined
                                        ? {}
                                        : { runId: latestSqliteRun.runId }),
                                    scheduleId: sqliteMaintenanceScheduleId,
                                }}
                                size="sm"
                                to="/jobs"
                                variant="secondary"
                            >
                                View job
                            </ActionLink>
                        </div>
                    </section>
                </Card>
            </div>
            {controlsDisabled && (
                <Text className="mt-3" size="sm" tone="muted">
                    Backup controls are disabled for this session.
                </Text>
            )}
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
    const databaseQuery = useQuery(databaseOverviewQueryOptions(client));
    const sqliteRun = useRunScheduleMutation();
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

    const readError = kopiaQuery.error ?? walgQuery.error ?? databaseQuery.error;
    return (
        <BackupOverviewSectionView
            error={
                mutationError ??
                (readError === null
                    ? undefined
                    : dashboardBrowserFailureMessage(readError))
            }
            kopia={kopiaQuery.data}
            loading={
                kopiaQuery.isPending || walgQuery.isPending || databaseQuery.isPending
            }
            mutationBusy={mutationBusy}
            onClearKopiaAttention={() => void submit("kopia", "clear-attention")}
            onClearWalgAttention={() => void submit("walg", "clear-attention")}
            onRetry={() => {
                void Promise.allSettled([kopiaQuery.refetch(), walgQuery.refetch()]);
            }}
            onRetryKopia={() => void kopiaQuery.refetch()}
            onRetryWalg={() => void walgQuery.refetch()}
            onRunKopia={() => void submit("kopia", "run")}
            onRunSqlite={() =>
                sqliteRun.mutate(
                    { id: sqliteMaintenanceScheduleId },
                    {
                        onError: (error) =>
                            setMutationError(dashboardBrowserFailureMessage(error)),
                        onSuccess: () => {
                            setMutationError(undefined);
                            void databaseQuery.refetch();
                        },
                    }
                )
            }
            onRunWalg={() => void submit("walg", "run")}
            queued={queued}
            sqlite={databaseQuery.data?.sqlite}
            sqliteBusy={sqliteRun.isPending}
            walg={walgQuery.data}
        />
    );
}
