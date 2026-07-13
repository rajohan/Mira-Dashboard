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
    const { data, isError, isLoading } = useCacheEntry<DatabaseOverviewResponse>(
        "database.summary",
        60_000
    );
    const database = isDatabaseOverviewResponse(data?.data) ? data.data : undefined;
    const overview = database?.overview;
    const waitingClients = overview?.pgbouncer.waitingClients ?? 0;
    const maintenance = overview?.maintenance;

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                    Database
                </h3>
                <Database className="size-4 text-primary-400" />
            </div>

            {isLoading ? (
                <div className="text-sm text-primary-300">Loading database cache…</div>
            ) : isError || !database || !overview ? (
                <div className="text-sm text-rose-300">Database cache unavailable.</div>
            ) : (
                <div className="space-y-2 text-sm text-primary-200">
                    <div className="flex items-center justify-between">
                        <span>Databases</span>
                        <span className="font-semibold text-primary-50">
                            {database.databases.length}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Total size</span>
                        <span className="text-primary-100">
                            {formatBytes(overview.totalDatabaseSizeBytes)}
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
                    <div className="flex items-center justify-between">
                        <span>Maintenance</span>
                        <span
                            className={
                                maintenance?.status === "review"
                                    ? "text-yellow-300"
                                    : maintenance
                                      ? "text-green-300"
                                      : "text-primary-400"
                            }
                        >
                            {maintenance
                                ? maintenance.status === "review"
                                    ? `Review · ${formatBytes(maintenance.estimatedReclaimableBytes)}`
                                    : "Healthy"
                                : "Not assessed"}
                        </span>
                    </div>
                </div>
            )}
        </Card>
    );
}
