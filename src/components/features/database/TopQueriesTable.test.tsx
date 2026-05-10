import { render, screen } from "@testing-library/react";
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
];

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

        render(<TopQueriesTable enabled data={topQueries} />);

        await userEvent.click(
            screen.getAllByText("SELECT * FROM torrents WHERE id = $1")[0]
        );

        expect(await screen.findByText("Query details")).toBeInTheDocument();
        expect(screen.getByText("Calls: 12")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: /Copy query/u }));

        expect(writeText).toHaveBeenCalledWith("SELECT * FROM torrents WHERE id = $1");
        expect(screen.getByRole("button", { name: /Copied/u })).toBeInTheDocument();
    });
});
