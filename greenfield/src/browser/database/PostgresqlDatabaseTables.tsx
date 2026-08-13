import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import type { ReactNode } from "react";

import type {
    DatabaseObservabilityDatabase,
    DatabaseObservabilityStatement,
    DatabaseObservabilityTableHealth,
} from "../../contracts/database.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { formatByteCount, formatPercent } from "../lib/formatMeasurements.ts";
import { Card } from "../ui/Card.tsx";
import { DataTable } from "../ui/DataTable.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Text } from "../ui/Text.tsx";

const countFormatter = new Intl.NumberFormat();
const durationFormatter = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
});

function formatCount(value: number): string {
    return countFormatter.format(value);
}

function formatDuration(value: number): string {
    return `${durationFormatter.format(value)} ms`;
}

function optionalDuration(value: number | undefined): string {
    return value === undefined ? "—" : formatDuration(value);
}

function optionalTimestamp(value: number | undefined): ReactNode {
    return value === undefined ? (
        "—"
    ) : (
        <time dateTime={new Date(value).toISOString()}>
            {formatDashboardDateTime(value)}
        </time>
    );
}

interface DatabaseTableSectionProps {
    readonly children: ReactNode;
    readonly description: string;
    readonly empty: boolean;
    readonly emptyMessage: string;
    readonly headingId: string;
    readonly title: string;
}

function DatabaseTableSection({
    children,
    description,
    empty,
    emptyMessage,
    headingId,
    title,
}: DatabaseTableSectionProps) {
    return (
        <Card aria-labelledby={headingId} className="min-w-0">
            <Heading id={headingId} level={2} size="section">
                {title}
            </Heading>
            <Text className="mt-1" tone="muted">
                {description}
            </Text>
            {empty ? (
                <Text className="mt-4">{emptyMessage}</Text>
            ) : (
                <div className="mt-4">{children}</div>
            )}
        </Card>
    );
}

const databaseTableFeatures = tableFeatures({});
const databaseColumnHelper = createColumnHelper<
    typeof databaseTableFeatures,
    DatabaseObservabilityDatabase
>();
const databaseColumns = databaseColumnHelper.columns([
    databaseColumnHelper.accessor("name", {
        cell: ({ getValue }) => (
            <span className="font-medium wrap-break-word">{getValue()}</span>
        ),
        header: "Database",
    }),
    databaseColumnHelper.accessor("detailsState", {
        cell: ({ getValue }) =>
            getValue() === "available" ? "Available" : "Unavailable",
        header: "Details",
    }),
    databaseColumnHelper.accessor("sizeBytes", {
        cell: ({ getValue }) => formatByteCount(getValue()),
        header: "Size",
    }),
    databaseColumnHelper.accessor("connections", {
        cell: ({ getValue }) => formatCount(getValue()),
        header: "Connections",
    }),
    databaseColumnHelper.accessor("cacheHitRatio", {
        cell: ({ getValue }) => formatPercent(getValue()),
        header: "Cache hit",
    }),
    databaseColumnHelper.accessor("committedTransactions", {
        cell: ({ getValue }) => formatCount(getValue()),
        header: "Committed",
    }),
    databaseColumnHelper.accessor("rolledBackTransactions", {
        cell: ({ getValue }) => formatCount(getValue()),
        header: "Rolled back",
    }),
    databaseColumnHelper.accessor((row) => row.pool?.activeClients, {
        cell: ({ row }) => {
            const pool = row.original.pool;
            return pool === undefined
                ? "—"
                : `${formatCount(pool.activeClients)} active · ${formatCount(pool.waitingClients)} waiting`;
        },
        header: "Pool clients",
        id: "poolClients",
    }),
    databaseColumnHelper.accessor((row) => row.pool?.activeServers, {
        cell: ({ row }) => {
            const pool = row.original.pool;
            return pool === undefined
                ? "—"
                : `${formatCount(pool.activeServers)} active · ${formatCount(pool.idleServers)} idle · ${formatCount(pool.usedServers)} used`;
        },
        header: "Pool servers",
        id: "poolServers",
    }),
    databaseColumnHelper.accessor((row) => row.pool?.averageQueryMs, {
        cell: ({ getValue }) => optionalDuration(getValue()),
        header: "Pool avg query",
        id: "poolAverageQuery",
    }),
    databaseColumnHelper.accessor((row) => row.pool?.averageTransactionMs, {
        cell: ({ getValue }) => optionalDuration(getValue()),
        header: "Pool avg transaction",
        id: "poolAverageTransaction",
    }),
    databaseColumnHelper.accessor((row) => row.pool?.totalQueries, {
        cell: ({ getValue }) => {
            const value = getValue();
            return value === undefined ? "—" : formatCount(value);
        },
        header: "Pool queries",
        id: "poolQueries",
    }),
]);

function PostgresqlDatabasesTable({
    databases,
}: {
    readonly databases: readonly DatabaseObservabilityDatabase[];
}) {
    const table = useTable({
        columns: databaseColumns,
        data: databases,
        features: databaseTableFeatures,
        getRowId: ({ name }) => name,
    });
    return (
        <DataTable
            label="PostgreSQL databases"
            table={table}
            tableClassName="min-w-320"
        />
    );
}

const tableHealthFeatures = tableFeatures({});
const tableHealthColumnHelper = createColumnHelper<
    typeof tableHealthFeatures,
    DatabaseObservabilityTableHealth
>();
const tableHealthColumns = tableHealthColumnHelper.columns([
    tableHealthColumnHelper.accessor("database", { header: "Database" }),
    tableHealthColumnHelper.accessor("schema", { header: "Schema" }),
    tableHealthColumnHelper.accessor("table", {
        cell: ({ getValue }) => <span className="wrap-break-word">{getValue()}</span>,
        header: "Table",
    }),
    tableHealthColumnHelper.accessor("assessment", {
        cell: ({ getValue }) => (getValue() === "assessed" ? "Assessed" : "Not assessed"),
        header: "Bloat assessment",
    }),
    tableHealthColumnHelper.accessor("physicalBytes", {
        cell: ({ getValue }) => formatByteCount(getValue()),
        header: "Physical size",
    }),
    tableHealthColumnHelper.accessor("estimatedReclaimableBytes", {
        cell: ({ getValue }) => {
            const value = getValue();
            return value === undefined ? "—" : formatByteCount(value);
        },
        header: "Estimated reclaimable",
    }),
    tableHealthColumnHelper.accessor("liveTuples", {
        cell: ({ getValue }) => formatCount(getValue()),
        header: "Live tuples",
    }),
    tableHealthColumnHelper.accessor("deadTuples", {
        cell: ({ getValue }) => formatCount(getValue()),
        header: "Dead tuples",
    }),
    tableHealthColumnHelper.accessor("deadTuplePercent", {
        cell: ({ getValue }) => formatPercent(getValue()),
        header: "Dead tuples %",
    }),
    tableHealthColumnHelper.accessor("lastAutovacuumAtMs", {
        cell: ({ getValue }) => optionalTimestamp(getValue()),
        header: "Last autovacuum",
    }),
    tableHealthColumnHelper.accessor("lastAutoanalyzeAtMs", {
        cell: ({ getValue }) => optionalTimestamp(getValue()),
        header: "Last autoanalyze",
    }),
]);

function PostgresqlTableHealthTable({
    tableHealth,
}: {
    readonly tableHealth: readonly DatabaseObservabilityTableHealth[];
}) {
    const table = useTable({
        columns: tableHealthColumns,
        data: tableHealth,
        features: tableHealthFeatures,
        getRowId: (row) => `${row.database}\u0000${row.schema}\u0000${row.table}`,
    });
    return (
        <DataTable
            label="PostgreSQL table health"
            table={table}
            tableClassName="min-w-288"
        />
    );
}

const statementTableFeatures = tableFeatures({});
const statementColumnHelper = createColumnHelper<
    typeof statementTableFeatures,
    DatabaseObservabilityStatement
>();
const statementColumns = statementColumnHelper.columns([
    statementColumnHelper.accessor("rank", { header: "Rank" }),
    statementColumnHelper.accessor("calls", {
        cell: ({ getValue }) => formatCount(getValue()),
        header: "Calls",
    }),
    statementColumnHelper.accessor("totalExecutionMs", {
        cell: ({ getValue }) => formatDuration(getValue()),
        header: "Total execution",
    }),
    statementColumnHelper.accessor("meanExecutionMs", {
        cell: ({ getValue }) => formatDuration(getValue()),
        header: "Mean execution",
    }),
    statementColumnHelper.accessor("rows", {
        cell: ({ getValue }) => formatCount(getValue()),
        header: "Rows",
    }),
    statementColumnHelper.accessor("sharedBlocksHit", {
        cell: ({ getValue }) => formatCount(getValue()),
        header: "Shared blocks hit",
    }),
    statementColumnHelper.accessor("sharedBlocksRead", {
        cell: ({ getValue }) => formatCount(getValue()),
        header: "Shared blocks read",
    }),
]);

function PostgresqlStatementsTable({
    statements,
}: {
    readonly statements: readonly DatabaseObservabilityStatement[];
}) {
    const table = useTable({
        columns: statementColumns,
        data: statements,
        features: statementTableFeatures,
        getRowId: ({ rank }) => String(rank),
    });
    return (
        <DataTable
            label="PostgreSQL statement metrics"
            table={table}
            tableClassName="min-w-224"
        />
    );
}

interface PostgresqlDatabaseTablesProps {
    readonly databases: readonly DatabaseObservabilityDatabase[];
    readonly statements: readonly DatabaseObservabilityStatement[];
    readonly statementsEnabled: boolean;
    readonly tableHealth: readonly DatabaseObservabilityTableHealth[];
}

/** @returns Bounded responsive tables containing only reviewed aggregate fields. */
export function PostgresqlDatabaseTables({
    databases,
    statements,
    statementsEnabled,
    tableHealth,
}: PostgresqlDatabaseTablesProps) {
    return (
        <div className="space-y-6">
            <DatabaseTableSection
                description="Bounded database-level storage, connection, cache, and transaction counters."
                empty={databases.length === 0}
                emptyMessage="No reviewed PostgreSQL databases were observed."
                headingId="postgresql-databases-heading"
                title="Databases"
            >
                <PostgresqlDatabasesTable databases={databases} />
            </DatabaseTableSection>
            <DatabaseTableSection
                description="Tables ranked for maintenance review using aggregate tuple counts."
                empty={tableHealth.length === 0}
                emptyMessage="No table-health rows require presentation."
                headingId="postgresql-table-health-heading"
                title="Table health"
            >
                <PostgresqlTableHealthTable tableHealth={tableHealth} />
            </DatabaseTableSection>
            <DatabaseTableSection
                description="Ranked execution aggregates. SQL text and database identities are not collected."
                empty={statements.length === 0}
                emptyMessage={
                    statementsEnabled
                        ? "No aggregate statement metrics were observed."
                        : "Statement metrics are unavailable because pg_stat_statements is not enabled."
                }
                headingId="postgresql-statements-heading"
                title="Statement performance"
            >
                <PostgresqlStatementsTable statements={statements} />
            </DatabaseTableSection>
        </div>
    );
}
