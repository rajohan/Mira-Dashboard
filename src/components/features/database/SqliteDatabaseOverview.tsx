import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";
import { formatBytes, formatNumber } from "./databaseUtilities";

interface Properties {
    sqlite: NonNullable<DatabaseOverviewResponse["sqlite"]>;
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-4 py-2">
            <dt className="text-primary-400">{label}</dt>
            <dd className="text-right text-primary-100">{value}</dd>
        </div>
    );
}

/** Renders Dashboard's local SQLite lifecycle metrics without PostgreSQL-only fields. */
export function SqliteDatabaseOverview({ sqlite }: Properties) {
    const latestBackup = sqlite.backup.latest;
    const maintenance = sqlite.lastMaintenance;

    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
                <Card className="p-3 sm:p-4">
                    <div className="text-sm text-primary-400">Database file</div>
                    <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                        {formatBytes(sqlite.databaseBytes)}
                    </div>
                    <div className="mt-2 truncate text-xs text-primary-400">
                        {sqlite.fileName}
                    </div>
                </Card>
                <Card className="p-3 sm:p-4">
                    <div className="text-sm text-primary-400">WAL</div>
                    <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                        {formatBytes(sqlite.walBytes)}
                    </div>
                    <div className="mt-2 text-xs text-primary-400">
                        passive checkpoint · {formatNumber(sqlite.walAutoCheckpointPages)}{" "}
                        pages
                    </div>
                </Card>
                <Card className="p-3 sm:p-4">
                    <div className="text-sm text-primary-400">Reusable space</div>
                    <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                        {formatBytes(sqlite.freeBytes)}
                    </div>
                    <div className="mt-2 text-xs text-primary-400">
                        {sqlite.freePercent.toFixed(1)}% · no automatic VACUUM
                    </div>
                </Card>
                <Card className="p-3 sm:p-4">
                    <div className="flex items-center justify-between gap-2">
                        <div className="text-sm text-primary-400">Lifecycle</div>
                        <Badge
                            variant={sqlite.status === "healthy" ? "success" : "warning"}
                        >
                            {sqlite.status === "healthy" ? "Healthy" : "Review"}
                        </Badge>
                    </div>
                    <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                        {sqlite.migrations.applied}/{sqlite.migrations.latest}
                    </div>
                    <div className="mt-2 text-xs text-primary-400">
                        migrations applied
                    </div>
                </Card>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
                <Card variant="bordered">
                    <div className="flex items-center justify-between gap-3">
                        <h3 className="font-semibold text-primary-100">SQLite runtime</h3>
                        <Badge
                            variant={sqlite.permissions.secure ? "success" : "warning"}
                        >
                            {sqlite.permissions.secure
                                ? "Permissions secure"
                                : "Check permissions"}
                        </Badge>
                    </div>
                    <dl className="mt-3 divide-y divide-primary-700 text-sm">
                        <DetailRow
                            label="Journal mode"
                            value={sqlite.journalMode.toUpperCase()}
                        />
                        <DetailRow
                            label="Foreign keys"
                            value={sqlite.foreignKeysEnabled ? "Enabled" : "Disabled"}
                        />
                        <DetailRow
                            label="Storage incl. WAL/SHM"
                            value={formatBytes(sqlite.storageBytes)}
                        />
                        <DetailRow
                            label="Pages"
                            value={`${formatNumber(sqlite.pageCount)} × ${formatBytes(sqlite.pageSize)}`}
                        />
                        <DetailRow
                            label="Modes"
                            value={`${sqlite.permissions.dataDirectory ?? "—"} / ${sqlite.permissions.database ?? "—"} / ${sqlite.permissions.wal ?? "—"}`}
                        />
                    </dl>
                </Card>

                <Card variant="bordered">
                    <h3 className="font-semibold text-primary-100">
                        Backup and maintenance
                    </h3>
                    <dl className="mt-3 divide-y divide-primary-700 text-sm">
                        <DetailRow
                            label="Verified backups"
                            value={formatNumber(sqlite.backup.count)}
                        />
                        <DetailRow
                            label="Latest backup"
                            value={
                                latestBackup
                                    ? `${formatDate(latestBackup.createdAt)} · ${formatBytes(latestBackup.bytes)}`
                                    : "Not run"
                            }
                        />
                        <DetailRow
                            label="Backup type"
                            value={latestBackup?.kind ?? "—"}
                        />
                        <DetailRow
                            label="Last maintenance"
                            value={
                                maintenance
                                    ? `${maintenance.status} · ${formatDate(
                                          maintenance.finishedAt ?? maintenance.startedAt
                                      )}`
                                    : "Not run"
                            }
                        />
                        <DetailRow
                            label="Restore verification"
                            value={latestBackup ? "Passed" : "Not run"}
                        />
                    </dl>
                </Card>
            </div>

            {sqlite.attention.length > 0 ? (
                <Card variant="bordered" className="border-amber-500/40">
                    <h3 className="font-semibold text-amber-200">
                        SQLite needs attention
                    </h3>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-primary-200">
                        {sqlite.attention.map((reason) => (
                            <li key={reason}>{reason}</li>
                        ))}
                    </ul>
                </Card>
            ) : undefined}
        </div>
    );
}
