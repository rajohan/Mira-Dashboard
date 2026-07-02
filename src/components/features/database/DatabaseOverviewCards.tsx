import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { Card } from "../../ui/Card";
import { formatBytes, formatNumber } from "./databaseUtilities";

/** Represents props. */
interface Properties {
    overview: DatabaseOverviewResponse["overview"];
}

/** Renders the database overview cards UI. */
export function DatabaseOverviewCards({ overview }: Properties) {
    return (
        <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
            <Card className="p-3 sm:p-4">
                <div className="text-sm text-primary-400">Comet torrents</div>
                <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                    {formatNumber(overview.torrentCounts.comet)}
                </div>
            </Card>
            <Card className="p-3 sm:p-4">
                <div className="text-sm text-primary-400">Bitmagnet torrents</div>
                <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                    {formatNumber(overview.torrentCounts.bitmagnet)}
                </div>
            </Card>
            <Card className="p-3 sm:p-4">
                <div className="text-sm text-primary-400">Total DB size</div>
                <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                    {formatBytes(overview.totalDatabaseSizeBytes)}
                </div>
            </Card>
            <Card className="p-3 sm:p-4">
                <div className="text-sm text-primary-400">Connections</div>
                <div className="mt-2 text-2xl font-semibold sm:text-3xl">
                    {overview.totalBackends}
                </div>
                <div className="mt-2 text-xs text-primary-400">
                    active {overview.connections.active || 0} · idle{" "}
                    {overview.connections.idle || 0}
                </div>
            </Card>
        </div>
    );
}
