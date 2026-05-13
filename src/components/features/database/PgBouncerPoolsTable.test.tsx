import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { PgBouncerPoolsTable } from "./PgBouncerPoolsTable";

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
    {
        cl_active: "1",
        cl_waiting: "3",
        database: "n8n",
        maxwait: "9",
        pool_mode: "session",
        sv_active: "1",
        sv_idle: "0",
        sv_used: "2",
        user: "n8n",
    },
];

describe("PgBouncerPoolsTable", () => {
    it("renders pool rows and calculated server totals", () => {
        render(<PgBouncerPoolsTable data={pools} />);

        expect(screen.getByRole("button", { name: "Database" })).toBeInTheDocument();
        expect(screen.getByText("comet")).toBeInTheDocument();
        expect(screen.getByText("postgres")).toBeInTheDocument();
        expect(screen.getByText("8")).toBeInTheDocument();
        expect(screen.getAllByText("n8n")).toHaveLength(2);
        expect(screen.getAllByText("3")).not.toHaveLength(0);
    });

    it("sorts numeric pool columns", async () => {
        render(<PgBouncerPoolsTable data={pools} />);

        const table = screen.getByRole("table");
        const bodyRows = () => within(table).getAllByRole("row").slice(1);

        expect(within(bodyRows()[0]!).getByText("comet")).toBeInTheDocument();

        for (const column of ["Clients", "Waiting", "Servers", "Maxwait"]) {
            await userEvent.click(screen.getByRole("button", { name: column }));
            await userEvent.click(screen.getByRole("button", { name: column }));
        }

        expect(bodyRows()).toHaveLength(2);
    });

    it("renders the shared empty state", () => {
        render(<PgBouncerPoolsTable data={[]} />);

        expect(screen.getByText("No data available.")).toBeInTheDocument();
    });
});
