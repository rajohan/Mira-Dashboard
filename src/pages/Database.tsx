import { AutovacuumHealthTable } from "../components/features/database/AutovacuumHealthTable";
import { DatabaseOverviewCards } from "../components/features/database/DatabaseOverviewCards";
import { DatabasesTable } from "../components/features/database/DatabaseSizesTable";
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
            <div className="space-y-4 p-3 sm:p-4 lg:space-y-6 lg:p-6">
                <EmptyState message="Failed to load database metrics." />
            </div>
        );
    }

    return (
        <div className="space-y-4 p-3 sm:p-4 lg:space-y-6 lg:p-6">
            <DatabaseOverviewCards overview={data.overview} />

            <div className="border-primary-700 border-b pb-2">
                <h2 className="text-primary-300 text-sm font-semibold tracking-wide uppercase">
                    Databases
                </h2>
            </div>
            <DatabasesTable
                databases={data.databases}
                pools={data.pgbouncerPools}
                stats={data.pgbouncerStats}
            />

            <div className="border-primary-700 border-b pb-2">
                <h2 className="text-primary-300 text-sm font-semibold tracking-wide uppercase">
                    Maintenance
                </h2>
            </div>
            <AutovacuumHealthTable data={data.deadTuples} />

            <div className="border-primary-700 border-b pb-2">
                <h2 className="text-primary-300 text-sm font-semibold tracking-wide uppercase">
                    Query performance
                </h2>
            </div>
            <TopQueriesTable
                enabled={data.overview.pgStatStatementsEnabled}
                data={data.topQueries}
            />
        </div>
    );
}

export default Database;
