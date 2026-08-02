import { AlertTriangle, CheckCircle2 } from "lucide-react";

import type { KopiaBackupCache, WalgBackupCache } from "../../../../../contracts/backups";
import type { CacheEnvelope } from "../../../../../contracts/cache";
import { formatDate, formatSize } from "../../../utils/format";

/**
 * Formats path for display.
 * @param path File or resource path.
 * @returns Formatted path for display.
 */
function formatPath(path: string | undefined) {
    if (!path) return "Unknown source";
    if (path === "/source/docker") return "Docker";
    if (path === "/source/projects") return "Projects";
    if (path === "/source/openclaw") return "OpenClaw";
    return path;
}
/**
 * Renders the WAL-G backup detail state.
 * @param properties Component properties.
 * @returns WAL-G detail content.
 */
export function WalgBackupDetails({
    entry,
}: {
    entry: CacheEnvelope<WalgBackupCache> | undefined;
}) {
    if (entry?.errorMessage) {
        return (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-sm text-rose-300">
                {entry.errorMessage}
            </div>
        );
    }

    const latest = entry?.data?.latest;
    if (!latest) {
        return (
            <div className="text-sm text-primary-400">
                No Postgres backup cache data yet
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 gap-2 text-sm text-primary-200 sm:grid-cols-2">
            <div>
                <div className="text-xs tracking-wide text-primary-400 uppercase">
                    Latest Postgres backup
                </div>
                <div className="mt-1 font-mono text-xs break-all">
                    {latest.backupName || "Unknown"}
                </div>
            </div>
            <div>
                <div className="text-xs tracking-wide text-primary-400 uppercase">
                    Finished
                </div>
                <div className="mt-1">
                    {latest.modified ? formatDate(latest.modified) : "Unknown"}
                </div>
            </div>
            <div>
                <div className="text-xs tracking-wide text-primary-400 uppercase">
                    WAL file
                </div>
                <div className="mt-1 font-mono text-xs break-all">
                    {latest.walFileName || "Unknown"}
                </div>
            </div>
            <div>
                <div className="text-xs tracking-wide text-primary-400 uppercase">
                    Backup count
                </div>
                <div className="mt-1">{entry.data?.backupCount ?? 0}</div>
            </div>
        </div>
    );
}

/**
 * Renders the Kopia snapshot list state.
 * @param properties Component properties.
 * @returns Snapshot loading, empty, or populated content.
 */
export function BackupSnapshotList({
    isLoading,
    snapshotGroups,
    stale,
}: {
    isLoading: boolean;
    snapshotGroups: KopiaBackupCache["snapshotsByPath"];
    stale: KopiaBackupCache["stale"];
}) {
    if (isLoading) {
        return (
            <div className="flex min-h-88 items-center justify-center text-primary-400">
                Loading backup status...
            </div>
        );
    }

    if (snapshotGroups.length === 0) {
        return (
            <div className="flex min-h-88 items-center justify-center text-primary-400">
                No backup cache data yet
            </div>
        );
    }

    return (
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
                                        <span className="text-yellow-300">Stale</span>
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
                                        snapshot.id || `${group.path}-${snapshot.endTime}`
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
                                            {snapshot.retentionReason.length > 0 ? (
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
                                                {typeof snapshot.totalSize === "number"
                                                    ? formatSize(snapshot.totalSize)
                                                    : "Unknown"}
                                            </div>
                                            <div className="mt-1 text-primary-400">
                                                {snapshot.fileCount ?? "Unknown"} files
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
    );
}
