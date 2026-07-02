import { AlertTriangle, CheckCircle2, Loader2, Play } from "lucide-react";
import { useState } from "react";

import {
    useCacheEntry,
    useClearKopiaBackupAttention,
    useClearWalgBackupAttention,
    useKopiaBackup,
    useRunKopiaBackup,
    useRunWalgBackup,
    useWalgBackup,
} from "../../../hooks";
import { formatDate, formatDuration, formatSize } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";
import { ConfirmModal } from "../../ui/ConfirmModal";

/** Defines backup snapshot. */
type BackupSnapshot = {
    id: string | undefined;
    path: string | undefined;
    description: string | undefined;
    startTime: string | undefined;
    endTime: string | undefined;
    fileCount: number | undefined;
    totalSize: number | undefined;
    errorCount: number | undefined;
    ignoredErrorCount: number | undefined;
    retentionReason: string[];
};

/** Defines backup snapshot group. */
type BackupSnapshotGroup = {
    path: string | undefined;
    latest: BackupSnapshot | undefined;
    snapshots: BackupSnapshot[];
    snapshotCount: number;
};

/** Defines backup cache data. */
type BackupCacheData = {
    checkedAt?: string;
    tool?: string;
    latest?: BackupSnapshot[];
    snapshotsByPath?: BackupSnapshotGroup[];
    stale?: Array<{ path?: string; endTime?: string; missing?: boolean }>;
    isOk?: boolean;
};

/** Defines walg backup. */
type WalgBackup = {
    backupName?: string | undefined;
    modified?: string | undefined;
    time?: string | undefined;
    startTime?: string | undefined;
    finishTime?: string | undefined;
    walFileName?: string | undefined;
    storageName?: string | undefined;
};

/** Defines walg cache data. */
type WalgCacheData = {
    checkedAt?: string;
    tool?: string;
    latest?: WalgBackup | undefined;
    backupCount?: number;
    latestAgeHours?: number | undefined;
    stale?: boolean;
    isOk?: boolean;
};

/** Returns variant. */
function getVariant(status?: string, isOk?: boolean) {
    if (status === "error") return "error" as const;
    if (isOk === true) return "success" as const;
    if (isOk === false) return "warning" as const;
    return "default" as const;
}

/** Formats path for display. */
function formatPath(path: string | undefined) {
    if (!path) return "Unknown source";
    if (path === "/source/docker") return "Docker";
    if (path === "/source/projects") return "Projects";
    if (path === "/source/openclaw") return "OpenClaw";
    return path;
}

/** Renders the backup overview card UI. */
export function BackupOverviewCard() {
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const { data, isLoading } = useCacheEntry<BackupCacheData>(
        "backup.kopia.status",
        30_000
    );
    const { data: walgData } = useCacheEntry<WalgCacheData>("backup.walg.status", 30_000);
    const { data: backupState } = useKopiaBackup();
    const { data: walgState } = useWalgBackup();
    const runBackup = useRunKopiaBackup();
    const runWalgBackup = useRunWalgBackup();
    const clearKopiaAttention = useClearKopiaBackupAttention();
    const clearWalgAttention = useClearWalgBackupAttention();

    const entry = data;
    const walgEntry = walgData;
    const snapshotGroups = entry?.data?.snapshotsByPath || [];
    const stale = entry?.data?.stale || [];
    const totalSnapshots = snapshotGroups.reduce(
        (sum, group) => sum + group.snapshotCount,
        0
    );
    const runningJob =
        backupState?.job?.status === "running" ? backupState.job : undefined;
    const runningWalgJob =
        walgState?.job?.status === "running" ? walgState.job : undefined;
    const attentionJob =
        backupState?.job?.status === "needs_attention" ? backupState.job : undefined;
    const attentionWalgJob =
        walgState?.job?.status === "needs_attention" ? walgState.job : undefined;
    const isRunning = Boolean(runningJob);
    const isWalgRunning = Boolean(runningWalgJob);
    const isBlocked = isRunning || Boolean(attentionJob);
    const isWalgBlocked = isWalgRunning || Boolean(attentionWalgJob);

    /** Responds to run backup events. */
    const handleRunBackup = async () => {
        await runBackup.mutateAsync();
        setIsConfirmOpen(false);
    };

    /** Responds to run walg backup events. */
    const handleRunWalgBackup = async () => {
        await runWalgBackup.mutateAsync();
    };

    return (
        <Card variant="bordered" className="h-full">
            <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                    <CardTitle>Backups</CardTitle>
                    <div className="mt-1 text-sm text-primary-400">
                        Kopia snapshots grouped by source
                    </div>
                </div>
                <Badge variant={getVariant(entry?.status, entry?.data?.isOk)}>
                    {entry?.status === "error"
                        ? "error"
                        : entry?.data?.isOk
                          ? "healthy"
                          : snapshotGroups.length > 0
                            ? "attention"
                            : "missing"}
                </Badge>
            </div>

            <div className="mb-4 space-y-3">
                <div className="rounded-lg border border-primary-700 bg-primary-900/30 p-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                            <div className="text-sm font-medium text-primary-100">
                                Run Postgres backup
                            </div>
                            <div className="mt-1 text-xs text-primary-400">
                                Creates a new Postgres backup and prunes older backup data
                                kept by WAL-G.
                            </div>
                        </div>
                        <Button
                            type="button"
                            size="sm"
                            disabled={isWalgBlocked || runWalgBackup.isPending}
                            onClick={() => {
                                void handleRunWalgBackup();
                            }}
                            className="w-full sm:w-auto"
                        >
                            {isWalgRunning ? (
                                <>
                                    <Loader2 className="size-4 animate-spin" />
                                    Running...
                                </>
                            ) : (
                                <>
                                    <Play className="size-4" />
                                    Run Postgres backup
                                </>
                            )}
                        </Button>
                    </div>
                </div>

                <div className="rounded-lg border border-primary-700 bg-primary-900/30 p-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                            <div className="text-sm font-medium text-primary-100">
                                Run Kopia filesystem backup
                            </div>
                            <div className="mt-1 text-xs text-primary-400">
                                Snapshots Docker, Projects, and OpenClaw files. Postgres
                                data is not included here.
                            </div>
                        </div>
                        <Button
                            type="button"
                            size="sm"
                            disabled={isBlocked || runBackup.isPending}
                            onClick={() => setIsConfirmOpen(true)}
                            className="w-full sm:w-auto"
                        >
                            {isRunning ? (
                                <>
                                    <Loader2 className="size-4 animate-spin" />
                                    Running...
                                </>
                            ) : (
                                <>
                                    <Play className="size-4" />
                                    Run filesystem backup
                                </>
                            )}
                        </Button>
                    </div>
                </div>
            </div>

            {runningWalgJob ? (
                <div className="mb-4 rounded-lg border border-accent-500/30 bg-accent-500/10 p-3 text-sm text-accent-100">
                    <div className="flex items-center gap-2 font-medium">
                        <Loader2 className="size-4 animate-spin" />
                        Postgres backup is running
                    </div>
                    <div className="mt-1 text-accent-100/80">
                        Started {formatDuration(runningWalgJob.startedAt)}
                    </div>
                    {runningWalgJob.stdout ? (
                        <div className="mt-2 max-h-24 overflow-y-auto rounded bg-primary-950/50 p-2 font-mono text-xs text-primary-200">
                            <pre className="whitespace-pre-wrap">
                                {runningWalgJob.stdout}
                            </pre>
                        </div>
                    ) : undefined}
                </div>
            ) : undefined}

            {attentionWalgJob ? (
                <div className="mb-4 rounded-lg border border-yellow-400/40 bg-yellow-400/10 p-3 text-sm text-yellow-100">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 font-medium">
                                <AlertTriangle className="size-4" />
                                Postgres backup needs attention
                            </div>
                            <div className="mt-1 text-yellow-100/80">
                                Verify no WAL-G backup is still running before clearing.
                            </div>
                        </div>
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={clearWalgAttention.isPending}
                            onClick={() => {
                                void clearWalgAttention.mutateAsync();
                            }}
                            className="w-full sm:w-auto"
                        >
                            Clear attention
                        </Button>
                    </div>
                    {attentionWalgJob.stderr ? (
                        <div className="mt-2 max-h-24 overflow-y-auto rounded bg-primary-950/50 p-2 font-mono text-xs text-primary-200">
                            <pre className="whitespace-pre-wrap">
                                {attentionWalgJob.stderr}
                            </pre>
                        </div>
                    ) : undefined}
                </div>
            ) : undefined}

            {runningJob ? (
                <div className="mb-4 rounded-lg border border-accent-500/30 bg-accent-500/10 p-3 text-sm text-accent-100">
                    <div className="flex items-center gap-2 font-medium">
                        <Loader2 className="size-4 animate-spin" />
                        Backup is running
                    </div>
                    <div className="mt-1 text-accent-100/80">
                        Started {formatDuration(runningJob.startedAt)}
                    </div>
                    {runningJob.stdout ? (
                        <div className="mt-2 max-h-24 overflow-y-auto rounded bg-primary-950/50 p-2 font-mono text-xs text-primary-200">
                            <pre className="whitespace-pre-wrap">{runningJob.stdout}</pre>
                        </div>
                    ) : undefined}
                </div>
            ) : undefined}

            {attentionJob ? (
                <div className="mb-4 rounded-lg border border-yellow-400/40 bg-yellow-400/10 p-3 text-sm text-yellow-100">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 font-medium">
                                <AlertTriangle className="size-4" />
                                Backup needs attention
                            </div>
                            <div className="mt-1 text-yellow-100/80">
                                Verify the backup process is stopped before clearing.
                            </div>
                        </div>
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={clearKopiaAttention.isPending}
                            onClick={() => {
                                void clearKopiaAttention.mutateAsync();
                            }}
                            className="w-full sm:w-auto"
                        >
                            Clear attention
                        </Button>
                    </div>
                    {attentionJob.stderr ? (
                        <div className="mt-2 max-h-24 overflow-y-auto rounded bg-primary-950/50 p-2 font-mono text-xs text-primary-200">
                            <pre className="whitespace-pre-wrap">
                                {attentionJob.stderr}
                            </pre>
                        </div>
                    ) : undefined}
                </div>
            ) : undefined}

            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-primary-700 bg-primary-900/30 p-3">
                    <div className="text-xs tracking-wide text-primary-400 uppercase">
                        Sources
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-primary-50">
                        {snapshotGroups.length}
                    </div>
                </div>
                <div className="rounded-lg border border-primary-700 bg-primary-900/30 p-3">
                    <div className="text-xs tracking-wide text-primary-400 uppercase">
                        Snapshots
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-primary-50">
                        {totalSnapshots}
                    </div>
                </div>
            </div>

            <div className="mb-4 rounded-lg border border-primary-700 bg-primary-900/30 p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                        <div className="text-sm font-medium text-primary-100">
                            Postgres backup
                        </div>
                        <div className="mt-1 text-xs text-primary-400">
                            Daily Postgres backup status stored through WAL-G.
                        </div>
                    </div>
                    <Badge variant={getVariant(walgEntry?.status, walgEntry?.data?.isOk)}>
                        {walgEntry?.status === "error"
                            ? "error"
                            : walgEntry?.data?.isOk
                              ? "healthy"
                              : walgEntry?.data?.latest
                                ? "attention"
                                : "missing"}
                    </Badge>
                </div>

                {walgEntry?.errorMessage ? (
                    <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-sm text-rose-300">
                        {walgEntry.errorMessage}
                    </div>
                ) : walgEntry?.data?.latest ? (
                    <div className="grid grid-cols-1 gap-2 text-sm text-primary-200 sm:grid-cols-2">
                        <div>
                            <div className="text-xs tracking-wide text-primary-400 uppercase">
                                Latest Postgres backup
                            </div>
                            <div className="mt-1 font-mono text-xs break-all">
                                {walgEntry.data.latest.backupName || "Unknown"}
                            </div>
                        </div>
                        <div>
                            <div className="text-xs tracking-wide text-primary-400 uppercase">
                                Finished
                            </div>
                            <div className="mt-1">
                                {walgEntry.data.latest.modified
                                    ? formatDate(walgEntry.data.latest.modified)
                                    : "Unknown"}
                            </div>
                        </div>
                        <div>
                            <div className="text-xs tracking-wide text-primary-400 uppercase">
                                WAL file
                            </div>
                            <div className="mt-1 font-mono text-xs break-all">
                                {walgEntry.data.latest.walFileName || "Unknown"}
                            </div>
                        </div>
                        <div>
                            <div className="text-xs tracking-wide text-primary-400 uppercase">
                                Backup count
                            </div>
                            <div className="mt-1">{walgEntry.data.backupCount ?? 0}</div>
                        </div>
                    </div>
                ) : (
                    <div className="text-sm text-primary-400">
                        No Postgres backup cache data yet
                    </div>
                )}
            </div>

            {entry?.errorMessage ? (
                <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
                    {entry.errorMessage}
                </div>
            ) : undefined}

            {isLoading ? (
                <div className="flex min-h-88 items-center justify-center text-primary-400">
                    Loading backup status...
                </div>
            ) : snapshotGroups.length > 0 ? (
                <div className="max-h-112 min-h-88 space-y-4 overflow-y-auto pr-2">
                    {snapshotGroups.map((group) => {
                        const isStale = stale.some((item) => item.path === group.path);

                        return (
                            <div
                                key={group.path || "unknown-source"}
                                className="rounded-lg border border-primary-700 bg-primary-900/30 p-3"
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-medium text-primary-100">
                                            {formatPath(group.path)}
                                        </div>
                                        <div className="mt-1 text-xs text-primary-400">
                                            {group.snapshotCount} snapshot
                                            {group.snapshotCount === 1 ? "" : "s"}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 text-xs">
                                        {isStale ? (
                                            <>
                                                <AlertTriangle className="size-3.5 text-yellow-300" />
                                                <span className="text-yellow-300">
                                                    Stale
                                                </span>
                                            </>
                                        ) : (
                                            <>
                                                <CheckCircle2 className="size-3.5 text-green-300" />
                                                <span className="text-green-300">OK</span>
                                            </>
                                        )}
                                    </div>
                                </div>

                                <div className="mt-3 space-y-2">
                                    {group.snapshots.map((snapshot) => (
                                        <div
                                            key={
                                                snapshot.id ||
                                                `${group.path}-${snapshot.endTime}`
                                            }
                                            className="rounded-md border border-primary-800/80 bg-primary-950/40 p-2"
                                        >
                                            <div className="flex items-start justify-between gap-3 text-xs">
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-primary-100">
                                                        {snapshot.description ||
                                                            snapshot.id ||
                                                            "Unnamed snapshot"}
                                                    </div>
                                                    <div className="mt-1 text-primary-400">
                                                        Finished:{" "}
                                                        {snapshot.endTime
                                                            ? formatDate(snapshot.endTime)
                                                            : "Unknown"}
                                                    </div>
                                                    {snapshot.retentionReason.length >
                                                    0 ? (
                                                        <div className="mt-2 flex flex-wrap gap-1">
                                                            {snapshot.retentionReason.map(
                                                                (reason) => (
                                                                    <span
                                                                        key={`${snapshot.id || snapshot.endTime}-${reason}`}
                                                                        className="rounded-full border border-primary-700 bg-primary-900/60 px-2 py-0.5 text-[11px] text-primary-200"
                                                                    >
                                                                        {reason}
                                                                    </span>
                                                                )
                                                            )}
                                                        </div>
                                                    ) : undefined}
                                                </div>
                                                <div className="text-right text-primary-300">
                                                    <div>
                                                        {typeof snapshot.totalSize ===
                                                        "number"
                                                            ? formatSize(
                                                                  snapshot.totalSize
                                                              )
                                                            : "Unknown"}
                                                    </div>
                                                    <div className="mt-1 text-primary-400">
                                                        {snapshot.fileCount ?? "Unknown"}{" "}
                                                        files
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="flex min-h-88 items-center justify-center text-primary-400">
                    No backup cache data yet
                </div>
            )}

            <ConfirmModal
                isOpen={isConfirmOpen}
                title="Run backup now"
                message="Start a Kopia backup now? This can take a while, and the button will stay disabled while the backup is running."
                confirmLabel="Run backup"
                confirmLoadingLabel="Starting backup..."
                loading={runBackup.isPending}
                onConfirm={() => {
                    void handleRunBackup();
                }}
                onCancel={() => setIsConfirmOpen(false)}
            />
        </Card>
    );
}
