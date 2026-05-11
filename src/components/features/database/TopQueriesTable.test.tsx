import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { TopQueriesTable } from "./TopQueriesTable";

const topQueries: DatabaseOverviewResponse["topQueries"] = [
    {
        calls: "12",
        mean_exec_time: "3.5",
        query: "SELECT * FROM torrents WHERE id = $1",
        rows: "12",
        shared_blks_hit: "1",
        shared_blks_read: "0",
        total_exec_time: "42",
    },
    {
        calls: "2",
        mean_exec_time: "14.5",
        query: "UPDATE streams SET watched_at = now() WHERE user_id = $1 AND stream_id = $2",
        rows: "1",
        shared_blks_hit: "4",
        shared_blks_read: "2",
        total_exec_time: "29",
    },
];

function renderTable(props: Partial<React.ComponentProps<typeof TopQueriesTable>> = {}) {
    return render(<TopQueriesTable enabled data={topQueries} {...props} />);
}

describe("TopQueriesTable", () => {
    it("renders disabled state when pg_stat_statements is unavailable", () => {
        render(<TopQueriesTable enabled={false} data={[]} />);

        expect(
            screen.getByText("pg_stat_statements is not enabled.")
        ).toBeInTheDocument();
    });

    it("opens query details and copies the selected query", async () => {
        const writeText = vi.fn().mockImplementation(async () => {});
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });

        renderTable({ data: [topQueries[0]!] });

        await userEvent.click(
            screen.getAllByText("SELECT * FROM torrents WHERE id = $1")[0]!
        );

        expect(await screen.findByText("Query details")).toBeInTheDocument();
        expect(screen.getByText("Calls: 12")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: /Copy query/u }));

        expect(writeText).toHaveBeenCalledWith("SELECT * FROM torrents WHERE id = $1");
        expect(screen.getByRole("button", { name: /Copied/u })).toBeInTheDocument();
    });

    it("renders desktop columns, mobile summary cards, and sorted numeric data", async () => {
        renderTable();

        expect(screen.getByRole("button", { name: "Query" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Calls" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Total ms" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Mean ms" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Rows" })).toBeInTheDocument();
        expect(screen.getAllByText("Tap for full query")).toHaveLength(2);

        const table = screen.getByRole("table");
        const bodyRows = () => within(table).getAllByRole("row").slice(1);

        await userEvent.click(screen.getByRole("button", { name: "Calls" }));
        expect(within(bodyRows()[0]!).getAllByRole("cell")[1]).toHaveTextContent("12");

        await userEvent.click(screen.getByRole("button", { name: "Calls" }));
        expect(within(bodyRows()[0]!).getAllByRole("cell")[1]).toHaveTextContent("2");
    });

    it("opens details from a keyboard-activated mobile query card and closes cleanly", async () => {
        renderTable({ data: [topQueries[1]!] });

        const mobileCard = screen.getByRole("button", {
            name: /UPDATE streams SET watched_at/u,
        });
        mobileCard.focus();
        await userEvent.keyboard("{Enter}");

        expect(await screen.findByText("Query details")).toBeInTheDocument();
        expect(screen.getByText("Calls: 2")).toBeInTheDocument();
        expect(screen.getByText("Mean ms: 14.5")).toBeInTheDocument();
        expect(screen.getByText("Total ms: 29")).toBeInTheDocument();
        expect(screen.getByText("Rows: 1")).toBeInTheDocument();

        const dialog = screen.getByRole("dialog", { name: "Query details" });
        await userEvent.click(within(dialog).getAllByRole("button")[0]!);

        await waitFor(() => {
            expect(screen.queryByText("Query details")).not.toBeInTheDocument();
        });
    });
});
