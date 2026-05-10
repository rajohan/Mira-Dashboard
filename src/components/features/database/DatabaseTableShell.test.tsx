import { createColumnHelper } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DatabaseTableShell } from "./DatabaseTableShell";

interface Row {
    name: string;
    value: number;
}

const columnHelper = createColumnHelper<Row>();
const columns = [
    columnHelper.accessor("name", { header: "Name" }),
    columnHelper.accessor("value", { header: "Value" }),
];

describe("DatabaseTableShell", () => {
    it("renders an empty state", () => {
        render(
            <DatabaseTableShell
                data={[]}
                columns={columns}
                emptyMessage="Nothing to show."
            />
        );

        expect(screen.getByText("Nothing to show.")).toBeInTheDocument();
    });

    it("renders table and mobile rows and forwards row clicks", async () => {
        const onRowClick = vi.fn();
        render(
            <DatabaseTableShell
                data={[
                    { name: "Alpha", value: 1 },
                    { name: "Beta", value: 2 },
                ]}
                columns={columns}
                onRowClick={onRowClick}
                renderMobileCard={(row) => <div>Mobile {row.name}</div>}
            />
        );

        expect(screen.getByRole("button", { name: "Name" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Value" })).toBeInTheDocument();
        expect(screen.getByText("Mobile Alpha")).toBeInTheDocument();

        await userEvent.click(screen.getByText("Alpha"));

        expect(onRowClick).toHaveBeenCalledWith({ name: "Alpha", value: 1 });
    });
});
