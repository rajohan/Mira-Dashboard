import { Card } from "../../ui/Card";
import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { formatBytes, formatNumber } from "./databaseUtils";

interface Props {
    overview: DatabaseOverviewResponse["overview"];
}

export function DatabaseOverviewCards({ overview }: Props) {
    return (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card className="p-4">
                <div className="text-sm text-primary-400">Comet torrents</div>
                <div className="mt-2 text-3xl font-semibold">{formatNumber(overview.torrentCounts.comet)}</div>
            </Card>
            <Card className="p-4">
                <div className="text-sm text-primary-400">Bitmagnet torrents</div>
                <div className="mt-2 text-3xl font-semibold">{formatNumber(overview.torrentCounts.bitmagnet)}</div>
            </Card>
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

        </div>
    );
}
