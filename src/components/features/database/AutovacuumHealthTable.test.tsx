import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { AutovacuumHealthTable } from "./AutovacuumHealthTable";

const rows: DatabaseOverviewResponse["deadTuples"] = [
    {
        dead_pct: "12.5",
        last_autoanalyze: "2026-05-10 08:00:00",
        last_autovacuum: "",
        n_dead_tup: "250",
        n_live_tup: "2000",
        relname: "torrent_items",
        schemaname: "public",
    },
];

describe("AutovacuumHealthTable", () => {
    it("renders empty autovacuum state", () => {
        render(<AutovacuumHealthTable data={[]} />);

        expect(
            screen.getByText("No autovacuum/dead tuple issues found right now.")
        ).toBeInTheDocument();
    });

    it("renders dead tuple metrics and sorts numeric columns", async () => {
        const { container } = render(
            <AutovacuumHealthTable
                data={[
                    ...rows,
                    {
                        ...rows[0]!,
                        dead_pct: "1.5",
                        n_dead_tup: "10",
                        relname: "small_table",
                    },
                ]}
            />
        );

        expect(screen.getAllByText("public.torrent_items")[0]).toBeInTheDocument();
        expect(container).toHaveTextContent("250");
        expect(container).toHaveTextContent("12.5%");
        expect(container).toHaveTextContent("Last autovacuum: —");
        expect(container).toHaveTextContent("Last autoanalyze: 2026-05-10 08:00:00");

        const table = screen.getByRole("table");
        const bodyRows = () => within(table).getAllByRole("row").slice(1);
        await userEvent.click(screen.getByRole("button", { name: "Dead %" }));
        await userEvent.click(screen.getByRole("button", { name: "Dead %" }));
        expect(
            within(bodyRows()[0]!).getByText("public.small_table")
        ).toBeInTheDocument();
    });
});
