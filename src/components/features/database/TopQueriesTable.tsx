import { createColumnHelper } from "@tanstack/react-table";
import { Copy } from "lucide-react";
import { useState } from "react";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { Modal } from "../../ui/Modal";
import { DatabaseTableShell } from "./DatabaseTableShell";
import { truncateQuery } from "./databaseUtils";

const columnHelper = createColumnHelper<DatabaseOverviewResponse["topQueries"][number]>();

const columns = [
    columnHelper.accessor("query", {
        header: "Query",
        cell: (info) => (
            <span className="block max-w-3xl truncate" title={info.getValue()}>
                {truncateQuery(info.getValue())}
            </span>
        ),
    }),
    columnHelper.accessor((row) => Number(row.calls), {
        id: "calls",
        header: "Calls",
        cell: (info) => info.row.original.calls,
    }),
    columnHelper.accessor((row) => Number(row.total_exec_time), {
        id: "totalMs",
        header: "Total ms",
        cell: (info) => info.row.original.total_exec_time,
    }),
    columnHelper.accessor((row) => Number(row.mean_exec_time), {
        id: "meanMs",
        header: "Mean ms",
        cell: (info) => info.row.original.mean_exec_time,
    }),
    columnHelper.accessor((row) => Number(row.rows), {
        id: "rows",
        header: "Rows",
        cell: (info) => info.row.original.rows,
    }),
];

export function TopQueriesTable({
    enabled,
    data,
}: {
    enabled: boolean;
    data: DatabaseOverviewResponse["topQueries"];
}) {
    const [selectedQuery, setSelectedQuery] = useState<
        DatabaseOverviewResponse["topQueries"][number] | null
    >(null);
    const [copied, setCopied] = useState(false);

    if (!enabled) {
        return (
            <Card className="overflow-hidden">
                <EmptyState message="pg_stat_statements is not enabled." />
            </Card>
        );
    }

    const handleCopy = async () => {
        if (!selectedQuery) return;
        await navigator.clipboard.writeText(selectedQuery.query);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
    };

    return (
        <>
            <DatabaseTableShell
                data={data}
                columns={columns}
                maxHeight="520px"
                onRowClick={(row) => setSelectedQuery(row)}
            />

            <Modal
                isOpen={!!selectedQuery}
                onClose={() => {
                    setSelectedQuery(null);
                    setCopied(false);
                }}
                title="Query details"
                size="3xl"
            >
                {selectedQuery ? (
                    <div className="space-y-4">
                        <div className="flex flex-wrap gap-4 text-sm text-primary-400">
                            <span>Calls: {selectedQuery.calls}</span>
                            <span>Total ms: {selectedQuery.total_exec_time}</span>
                            <span>Mean ms: {selectedQuery.mean_exec_time}</span>
                            <span>Rows: {selectedQuery.rows}</span>
                        </div>

                        <div className="flex justify-end">
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => void handleCopy()}
                            >
                                <Copy className="mr-2 h-4 w-4" />
                                {copied ? "Copied" : "Copy query"}
                            </Button>
                        </div>

                        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-primary-700 bg-primary-900/50 p-4 text-sm text-primary-100">
                            <code>{selectedQuery.query}</code>
                        </pre>
                    </div>
                ) : null}
            </Modal>
        </>
    );
}
