import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { DatabasesTable } from "./DatabaseSizesTable";

const databases: DatabaseOverviewResponse["databases"] = [
    {
        blks_hit: "100",
        blks_read: "1",
        cache_hit_ratio: "99.0",
        datname: "comet",
        numbackends: "3",
        size_bytes: "1048576",
        size_pretty: "1 MB",
        xact_commit: "10",
        xact_rollback: "0",
    },
    {
        blks_hit: "0",
        blks_read: "0",
        cache_hit_ratio: "0",
        datname: "empty",
        numbackends: "0",
        size_bytes: "0",
        size_pretty: "0 bytes",
        xact_commit: "0",
        xact_rollback: "0",
    },
];

const pools: DatabaseOverviewResponse["pgbouncerPools"] = [
    {
        cl_active: "4",
        cl_waiting: "1",
        database: "comet",
        maxwait: "0",
        pool_mode: "transaction",
        sv_active: "2",
        sv_idle: "5",
        sv_used: "1",
        user: "postgres",
    },
];

const stats: DatabaseOverviewResponse["pgbouncerStats"] = [
    {
        avg_query_time: "3.25",
        avg_xact_time: "4.5",
        database: "comet",
        total_query_count: "1234",
        total_query_time: "4000",
        total_received: "10",
        total_sent: "20",
        total_xact_count: "100",
        total_xact_time: "450",
    },
];

describe("DatabasesTable", () => {
    it("merges database, pool, stats rows, and sorts numeric columns", async () => {
        const { container } = render(
            <DatabasesTable databases={databases} pools={pools} stats={stats} />
        );

        expect(screen.getAllByText("comet")[0]).toBeInTheDocument();
        expect(screen.getAllByText("empty")[0]).toBeInTheDocument();
        expect(container).toHaveTextContent("1 MB");
        expect(container).toHaveTextContent("99.0%");
        expect(container).toHaveTextContent("1,234");
        expect(container).toHaveTextContent("Clients: 4");
        expect(container).toHaveTextContent("Waiting: 1");
        expect(container).toHaveTextContent("Clients: —");

        const table = screen.getByRole("table");
        const bodyRows = () => within(table).getAllByRole("row").slice(1);
        for (const column of ["Size", "Connections", "Cache hit"]) {
            await userEvent.click(screen.getByRole("button", { name: column }));
            await userEvent.click(screen.getByRole("button", { name: column }));
        }
        expect(bodyRows()).toHaveLength(2);
    });
});
