import { useState } from "react";

import { AutovacuumHealthTable } from "../components/features/database/AutovacuumHealthTable";
import { DatabaseOverviewCards } from "../components/features/database/DatabaseOverviewCards";
import { DatabasesTable } from "../components/features/database/DatabaseSizesTable";
import { SqliteDatabaseOverview } from "../components/features/database/SqliteDatabaseOverview";
import { TopQueriesTable } from "../components/features/database/TopQueriesTable";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { LoadingState } from "../components/ui/LoadingState";
import { useDatabaseOverview } from "../hooks/useDatabase";

type DatabaseSource = "postgresql" | "sqlite";

function initialDatabaseSource(): DatabaseSource {
    return new URLSearchParams(location.search).get("source") === "sqlite"
        ? "sqlite"
        : "postgresql";
}

/** Renders the database UI. */
export function Database() {
    const { data, isLoading, error } = useDatabaseOverview();
    const [source, setSource] = useState<DatabaseSource>(initialDatabaseSource);

    if (isLoading) {
        return <LoadingState message="Loading database metrics..." size="lg" />;
    }

    if (!data) {
        return (
            <div className="space-y-4 p-3 sm:p-4 lg:space-y-6 lg:p-6">
                <EmptyState message="Failed to load database metrics." />
            </div>
        );
    }

    const selectedSource =
        source === "sqlite" && !data.sqlite ? ("postgresql" as const) : source;

    return (
        <div className="space-y-4 p-3 sm:p-4 lg:space-y-6 lg:p-6">
            {error && (
                <Alert variant="warning">
                    Database refresh failed. Showing the last loaded metrics.{" "}
                    {error.message}
                </Alert>
            )}

            <Card variant="bordered" className="p-2">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Button
                        type="button"
                        variant={selectedSource === "postgresql" ? "primary" : "ghost"}
                        aria-pressed={selectedSource === "postgresql"}
                        onClick={() => setSource("postgresql")}
                        className="justify-center"
                    >
                        PostgreSQL ({data.databases.length})
                    </Button>
                    <Button
                        type="button"
                        variant={selectedSource === "sqlite" ? "primary" : "ghost"}
                        aria-pressed={selectedSource === "sqlite"}
                        onClick={() => setSource("sqlite")}
                        className="justify-center"
                        disabled={!data.sqlite}
                    >
                        Dashboard SQLite
                    </Button>
                </div>
            </Card>

            {selectedSource === "sqlite" && data.sqlite ? (
                <SqliteDatabaseOverview sqlite={data.sqlite} />
            ) : (
                <>
                    <DatabaseOverviewCards overview={data.overview} />

                    <div className="border-b border-primary-700 pb-2">
                        <h2 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                            Databases
                        </h2>
                    </div>
                    <DatabasesTable
                        databases={data.databases}
                        pools={data.pgbouncerPools}
                        stats={data.pgbouncerStats}
                    />

                    <div className="border-b border-primary-700 pb-2">
                        <h2 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                            Maintenance
                        </h2>
                    </div>
                    <AutovacuumHealthTable data={data.deadTuples} />

                    <div className="border-b border-primary-700 pb-2">
                        <h2 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                            Query performance
                        </h2>
                    </div>
                    <TopQueriesTable
                        enabled={data.overview.pgStatStatementsEnabled}
                        data={data.topQueries}
                    />
                </>
            )}
        </div>
    );
}

export default Database;
