import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { PgBouncerStatsTable } from "./PgBouncerStatsTable";

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
    {
        avg_query_time: "10.5",
        avg_xact_time: "2.5",
        database: "n8n",
        total_query_count: "42",
        total_query_time: "441",
        total_received: "5",
        total_sent: "8",
        total_xact_count: "12",
        total_xact_time: "30",
    },
];

describe("PgBouncerStatsTable", () => {
    it("renders PgBouncer timing and query stats", () => {
        render(<PgBouncerStatsTable data={stats} />);

        expect(screen.getByRole("button", { name: "Avg query" })).toBeInTheDocument();
        expect(screen.getByText("comet")).toBeInTheDocument();
        expect(screen.getByText("3.25")).toBeInTheDocument();
        expect(screen.getByText("4.5")).toBeInTheDocument();
        expect(screen.getByText("1234")).toBeInTheDocument();
    });

    it("sorts query counts numerically", async () => {
        render(<PgBouncerStatsTable data={stats} />);

        const table = screen.getByRole("table");
        const bodyRows = () => within(table).getAllByRole("row").slice(1);

        expect(within(bodyRows()[0]!).getByText("comet")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Queries" }));
        expect(within(bodyRows()[0]!).getByText("comet")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Queries" }));
        expect(within(bodyRows()[0]!).getByText("n8n")).toBeInTheDocument();
    });

    it("renders the shared empty state", () => {
        render(<PgBouncerStatsTable data={[]} />);

        expect(screen.getByText("No data available.")).toBeInTheDocument();
    });
});
