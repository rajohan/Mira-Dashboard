import { Database } from "lucide-react";

import { useCacheEntry } from "../../../hooks/useCache";
import { type DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { Card } from "../../ui/Card";
import { formatBytes } from "../database/databaseUtilities";

function isDatabaseOverviewResponse(value: unknown): value is DatabaseOverviewResponse {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<DatabaseOverviewResponse>;
    return (
        !!candidate.overview &&
        typeof candidate.overview === "object" &&
        Array.isArray(candidate.databases) &&
        Array.isArray(candidate.deadTuples) &&
        Array.isArray(candidate.topQueries)
    );
}

/** Renders the database overview card UI. */
export function DatabaseOverviewCard() {
    const { data, isLoading } = useCacheEntry<DatabaseOverviewResponse>(
        "database.summary",
        60_000
    );
    const database = isDatabaseOverviewResponse(data?.data) ? data.data : undefined;
    const overview = database?.overview;
    const waitingClients = overview?.pgbouncer.waitingClients ?? 0;
    const maintenance = overview?.maintenance;
    const maintenanceHintCount =
        maintenance?.hintCount ?? (maintenance?.status === "review" ? 1 : 0);
    const sqlite = database?.sqlite;

    return (
        <Card className="xl:col-span-2">
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                    Database
                </h3>
                <Database className="size-4 text-primary-400" />
            </div>

            {isLoading ? (
                <div className="text-sm text-primary-300">Loading database cache…</div>
            ) : !database || !overview ? (
                <div className="text-sm text-rose-300">Database cache unavailable.</div>
            ) : (
                <div className="grid gap-4 text-sm text-primary-200 xl:grid-cols-2 xl:divide-x xl:divide-primary-700">
                    <section className="space-y-2 xl:pr-4">
                        <div className="mb-3 flex items-center justify-between gap-2">
                            <h4 className="font-medium text-primary-100">PostgreSQL</h4>
                            <span
                                className={
                                    maintenance?.status === "review"
                                        ? "text-yellow-300"
                                        : maintenance?.status === "healthy"
                                          ? "text-green-300"
                                          : "text-primary-400"
                                }
                            >
                                {maintenance?.status === "review"
                                    ? "Review"
                                    : maintenance?.status === "healthy"
                                      ? "Healthy"
                                      : "Not assessed"}
                            </span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span>Databases</span>
                            <span className="font-semibold text-primary-50">
                                {database.databases.length}
                            </span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span>Size</span>
                            <span className="text-primary-100">
                                {formatBytes(overview.totalDatabaseSizeBytes)}
                            </span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span>Connections</span>
                            <span className="text-primary-100">
                                {overview.totalBackends}
                            </span>
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
                                    waitingClients > 0
                                        ? "text-yellow-300"
                                        : "text-green-300"
                                }
                            >
                                {waitingClients}
                            </span>
                        </div>
                        {maintenance?.status === "review" ? (
                            <div className="text-xs text-primary-400">
                                {maintenanceHintCount}{" "}
                                {maintenanceHintCount === 1 ? "hint" : "hints"}
                            </div>
                        ) : undefined}
                    </section>

                    <section className="space-y-2 border-t border-primary-700 pt-4 xl:border-t-0 xl:pt-0 xl:pl-4">
                        <div className="mb-3 flex items-center justify-between gap-2">
                            <h4 className="font-medium text-primary-100">
                                Dashboard SQLite
                            </h4>
                            <span
                                className={
                                    sqlite?.status === "healthy"
                                        ? "text-green-300"
                                        : "text-yellow-300"
                                }
                            >
                                {sqlite
                                    ? sqlite.status === "healthy"
                                        ? "Healthy"
                                        : "Review"
                                    : "Unavailable"}
                            </span>
                        </div>
                        {sqlite ? (
                            <>
                                <div className="flex items-center justify-between">
                                    <span>Database</span>
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
                                        {sqlite.migrations.applied}/
                                        {sqlite.migrations.latest}
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
                                {sqlite.attention[0] ? (
                                    <div className="text-xs text-yellow-300">
                                        {sqlite.attention[0]}
                                    </div>
                                ) : undefined}
                            </>
                        ) : (
                            <div className="text-primary-400">
                                SQLite metrics are not available in this cache entry.
                            </div>
                        )}
                    </section>
                </div>
            )}
        </Card>
    );
}
