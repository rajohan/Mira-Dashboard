import { AutovacuumHealthTable } from "../components/features/database/AutovacuumHealthTable";
import { DatabaseOverviewCards } from "../components/features/database/DatabaseOverviewCards";
import { DatabaseSizesTable } from "../components/features/database/DatabaseSizesTable";
import { PgBouncerPoolsTable } from "../components/features/database/PgBouncerPoolsTable";
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

            <div className="grid gap-6 xl:grid-cols-2">
                <DatabaseSizesTable data={data.databases} />
                <PgBouncerPoolsTable data={data.pgbouncerPools} />
            </div>

            <div className="grid gap-6 xl:grid-cols-2">
                <AutovacuumHealthTable data={data.deadTuples} />
                <PgBouncerStatsTable data={data.pgbouncerStats} />
            </div>

            <TopQueriesTable enabled={data.overview.pgStatStatementsEnabled} data={data.topQueries} />
        </div>
    );
}

export default Database;
