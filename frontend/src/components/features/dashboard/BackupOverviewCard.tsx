import { AlertTriangle, Loader2, Play } from "lucide-react";
import { useState } from "react";

import {
    parseKopiaBackupCache,
    parseWalgBackupCache,
} from "../../../../../contracts/backups";
import {
    useCacheEntry,
    useClearKopiaBackupAttention,
    useClearWalgBackupAttention,
    useKopiaBackup,
    useRunKopiaBackup,
    useRunWalgBackup,
    useWalgBackup,
} from "../../../hooks";
import { formatDuration } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";
import { ConfirmModal } from "../../ui/ConfirmModal";
import { BackupSnapshotList, WalgBackupDetails } from "./BackupOverviewDetails";

/**
 * Returns variant.
 * @param status Status value.
 * @param isOk Whether is ok.
 * @returns variant.
 */
function getVariant(status?: string, isOk?: boolean) {
    if (status === "error") return "error" as const;
    if (isOk === true) return "success" as const;
    if (isOk === false) return "warning" as const;
    return "default" as const;
}
/**
 * Returns the summary status label for a backup cache entry.
 * @param status Cache refresh status.
 * @param isOk Whether the underlying backup check passed.
 * @param hasData Whether backup data exists.
 * @returns Human-readable backup status.
 */
function backupStatusLabel(
    status: string | undefined,
    isOk: boolean | undefined,
    hasData: boolean
): string {
    if (status === "error") return "error";
    if (isOk) return "healthy";
    return hasData ? "attention" : "missing";
}
/**
 * Renders the backup overview card UI.
 * @returns Rendered the backup overview card UI.
 */
export function BackupOverviewCard() {
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const { data, isLoading } = useCacheEntry(
        "backup.kopia.status",
        parseKopiaBackupCache,
        30_000
    );
    const { data: walgData } = useCacheEntry(
        "backup.walg.status",
        parseWalgBackupCache,
        30_000
    );
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
                    {backupStatusLabel(
                        entry?.status,
                        entry?.data?.isOk,
                        snapshotGroups.length > 0
                    )}
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
                        {backupStatusLabel(
                            walgEntry?.status,
                            walgEntry?.data?.isOk,
                            Boolean(walgEntry?.data?.latest)
                        )}
                    </Badge>
                </div>

                <WalgBackupDetails entry={walgEntry} />
            </div>

            {entry?.errorMessage ? (
                <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
                    {entry.errorMessage}
                </div>
            ) : undefined}

            <BackupSnapshotList
                isLoading={isLoading}
                snapshotGroups={snapshotGroups}
                stale={stale}
            />

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
