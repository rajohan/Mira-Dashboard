import { AutovacuumHealthTable } from "../components/features/database/AutovacuumHealthTable";
import { DatabaseOverviewCards } from "../components/features/database/DatabaseOverviewCards";
import { DatabasesTable } from "../components/features/database/DatabaseSizesTable";
import { PgBouncerStatsTable } from "../components/features/database/PgBouncerStatsTable";
import { TopQueriesTable } from "../components/features/database/TopQueriesTable";
import { EmptyState } from "../components/ui/EmptyState";
import { LoadingState } from "../components/ui/LoadingState";
import { useDatabaseOverview } from "../hooks/useDatabase";

export function Database() {
    const { data, isLoading, error } = useDatabaseOverview();

    if (isLoading) {
        return <LoadingState message="Loading database metrics..." size="lg" />;
    }

    if (error || !data) {
        return (
            <div className="space-y-6 p-6">
                <EmptyState message="Failed to load database metrics." />
            </div>
        );
    }

    return (
        <div className="space-y-6 p-6">
            <DatabaseOverviewCards overview={data.overview} />

            <div className="border-b border-primary-700 pb-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                    Databases
                </h2>
            </div>
            <DatabasesTable databases={data.databases} pools={data.pgbouncerPools} />

            <div className="border-b border-primary-700 pb-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                    Maintenance
                </h2>
            </div>
            <div className="grid gap-6 xl:grid-cols-2">
                <AutovacuumHealthTable data={data.deadTuples} />
                <PgBouncerStatsTable data={data.pgbouncerStats} />
            </div>

            <div className="border-b border-primary-700 pb-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                    Query performance
                </h2>
            </div>
            <TopQueriesTable enabled={data.overview.pgStatStatementsEnabled} data={data.topQueries} />
        </div>
    );
}

export default Database;
