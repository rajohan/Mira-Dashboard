import { Database } from "lucide-react";
import type { ReactNode } from "react";

import {
    type DatabaseOverviewResponse,
    parseDatabaseOverviewResponse,
} from "../../../../../contracts/database";
import { useCacheEntry } from "../../../hooks/useCache";
import { Card } from "../../ui/Card";
import { formatBytes, postgresMaintenanceAttention } from "../database/databaseUtilities";

/**
 * Renders the database overview card UI.
 * @returns Rendered the database overview card UI.
 */
export function DatabaseOverviewCard() {
    const { data, isLoading } = useCacheEntry<DatabaseOverviewResponse>(
        "database.summary",
        parseDatabaseOverviewResponse,
        60_000
    );
    const database = data?.data;
    const overview = database?.overview;
    const waitingClients = overview?.pgbouncer.waitingClients ?? 0;
    const maintenance = overview?.maintenance;
    const postgresAttention = postgresMaintenanceAttention(maintenance);
    const sqlite = database?.sqlite;
    let maintenanceClassName = "text-primary-400";
    let maintenanceLabel = "Not assessed";
    if (maintenance?.status === "review") {
        maintenanceClassName = "text-yellow-300";
        maintenanceLabel = "Review";
    } else if (maintenance?.status === "healthy") {
        maintenanceClassName = "text-green-300";
        maintenanceLabel = "Healthy";
    }

    let sqliteLabel = "Unavailable";
    if (sqlite) {
        sqliteLabel = sqlite.status === "healthy" ? "Healthy" : "Review";
    }

    let content: ReactNode;
    if (isLoading) {
        content = <div className="text-sm text-primary-300">Loading database cache…</div>;
    } else if (!database || !overview) {
        content = (
            <div className="text-sm text-rose-300">Database cache unavailable.</div>
        );
    } else {
        content = (
            <div className="space-y-4 text-sm text-primary-200">
                <section className="space-y-2 pb-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                        <h4 className="font-medium text-primary-100">PostgreSQL</h4>
                        <span className={maintenanceClassName}>{maintenanceLabel}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Size</span>
                        <span className="text-primary-100">
                            {formatBytes(overview.totalDatabaseSizeBytes)}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Databases</span>
                        <span className="font-semibold text-primary-50">
                            {database.databases.length}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Connections</span>
                        <span className="text-primary-100">{overview.totalBackends}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Cache hit</span>
                        <span className="text-primary-100">
                            {overview.averageCacheHitRatio.toFixed(1)}%
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Waiting clients</span>
                        <span
                            className={
                                waitingClients > 0 ? "text-yellow-300" : "text-green-300"
                            }
                        >
                            {waitingClients}
                        </span>
                    </div>
                    {postgresAttention.length > 0 ? (
                        <ul className="space-y-1 text-xs text-yellow-300">
                            {postgresAttention.map((reason) => (
                                <li key={reason}>{reason}</li>
                            ))}
                        </ul>
                    ) : undefined}
                </section>

                <section className="space-y-2 border-t border-primary-700 pt-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                        <h4 className="font-medium text-primary-100">Dashboard SQLite</h4>
                        <span
                            className={
                                sqlite?.status === "healthy"
                                    ? "text-green-300"
                                    : "text-yellow-300"
                            }
                        >
                            {sqliteLabel}
                        </span>
                    </div>
                    {sqlite ? (
                        <>
                            <div className="flex items-center justify-between">
                                <span>Size</span>
                                <span className="text-primary-100">
                                    {formatBytes(sqlite.databaseBytes)}
                                </span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span>WAL</span>
                                <span className="text-primary-100">
                                    {formatBytes(sqlite.walBytes)}
                                </span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span>Reusable space</span>
                                <span className="text-primary-100">
                                    {sqlite.freePercent.toFixed(1)}%
                                </span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span>Migrations</span>
                                <span
                                    className={
                                        sqlite.migrations.current
                                            ? "text-green-300"
                                            : "text-yellow-300"
                                    }
                                >
                                    {sqlite.migrations.applied}/{sqlite.migrations.latest}
                                </span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span>Verified backups</span>
                                <span
                                    className={
                                        sqlite.backup.current
                                            ? "text-primary-100"
                                            : "text-yellow-300"
                                    }
                                >
                                    {sqlite.backup.count}
                                </span>
                            </div>
                            {sqlite.attention.length > 0 ? (
                                <ul className="space-y-1 text-xs text-yellow-300">
                                    {sqlite.attention.map((reason) => (
                                        <li key={reason}>{reason}</li>
                                    ))}
                                </ul>
                            ) : undefined}
                        </>
                    ) : (
                        <div className="text-primary-400">
                            SQLite metrics are not available in this cache entry.
                        </div>
                    )}
                </section>
            </div>
        );
    }

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                    Database
                </h3>
                <Database className="size-4 text-primary-400" />
            </div>

            {content}
        </Card>
    );
}
