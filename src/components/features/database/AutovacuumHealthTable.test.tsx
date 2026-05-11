import { render, screen } from "@testing-library/react";
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

    it("renders dead tuple metrics", () => {
        const { container } = render(<AutovacuumHealthTable data={rows} />);

        expect(screen.getAllByText("public.torrent_items")[0]).toBeInTheDocument();
        expect(container).toHaveTextContent("250");
        expect(container).toHaveTextContent("12.5%");
        expect(container).toHaveTextContent("Last autovacuum: —");
        expect(container).toHaveTextContent("Last autoanalyze: 2026-05-10 08:00:00");
    });
});
