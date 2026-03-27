import { Card } from "../../ui/Card";
import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { formatBytes } from "./databaseUtils";

interface Props {
    overview: DatabaseOverviewResponse["overview"];
}

export function DatabaseOverviewCards({ overview }: Props) {
    return (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card className="p-4">
                <div className="text-sm text-primary-400">Total DB size</div>
                <div className="mt-2 text-3xl font-semibold">{formatBytes(overview.totalDatabaseSizeBytes)}</div>
            </Card>
            <Card className="p-4">
                <div className="text-sm text-primary-400">Connections</div>
                <div className="mt-2 text-3xl font-semibold">{overview.totalBackends}</div>
                <div className="mt-2 text-xs text-primary-400">
                    active {overview.connections.active || 0} · idle {overview.connections.idle || 0}
                </div>
            </Card>
            <Card className="p-4">
                <div className="text-sm text-primary-400">Cache hit ratio</div>
                <div className="mt-2 text-3xl font-semibold">{overview.averageCacheHitRatio.toFixed(2)}%</div>
            </Card>
            <Card className="p-4">
                <div className="text-sm text-primary-400">PgBouncer waiting / maxwait</div>
                <div className="mt-2 text-3xl font-semibold">{overview.pgbouncer.waitingClients}</div>
                <div className="mt-2 text-xs text-primary-400">maxwait {overview.pgbouncer.maxWait}s</div>
            </Card>
        </div>
    );
}
