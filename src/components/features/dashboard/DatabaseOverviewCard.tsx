import { Database } from "lucide-react";

import { useCacheEntry } from "../../../hooks/useCache";
import { type DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { Card } from "../../ui/Card";
import { formatBytes } from "../database/databaseUtilities";

const SLOW_QUERY_MEAN_MS = 500;
const HIGH_DEAD_TUPLE_PERCENT = 20;
const HIGH_DEAD_TUPLE_MINIMUM = 1000;

/** Renders the database overview card UI. */
export function DatabaseOverviewCard() {
    const { data, isError, isLoading } = useCacheEntry<DatabaseOverviewResponse>(
        "database.summary",
        60_000
    );
    const database = data?.data;
    const overview = database?.overview;
    const waitingClients = overview?.pgbouncer.waitingClients ?? 0;
    const slowQueries = database?.topQueries.filter(
        (query) => Number(query.mean_exec_time) >= SLOW_QUERY_MEAN_MS
    ).length;
    const highDeadTupleTables = database?.deadTuples.filter(
        (table) =>
            Number(table.dead_pct) >= HIGH_DEAD_TUPLE_PERCENT &&
            Number(table.n_dead_tup) >= HIGH_DEAD_TUPLE_MINIMUM
    ).length;
    const maintenanceHints = (slowQueries ?? 0) + (highDeadTupleTables ?? 0);

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
                        <span>Maintenance hints</span>
                        <span
                            className={
                                maintenanceHints > 0
                                    ? "text-yellow-300"
                                    : "text-green-300"
                            }
                        >
                            {maintenanceHints}
                        </span>
                    </div>
                </div>
            )}
        </Card>
    );
}
