import { createColumnHelper } from "@tanstack/react-table";
import { render, screen, within } from "@testing-library/react";
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

const rows: Row[] = [
    { name: "Alpha", value: 1 },
    { name: "Beta", value: 2 },
];

function renderShell(
    props: Partial<React.ComponentProps<typeof DatabaseTableShell<Row>>> = {}
) {
    return render(<DatabaseTableShell data={rows} columns={columns} {...props} />);
}

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
        renderShell({
            onRowClick,
            renderMobileCard: (row) => <div>Mobile {row.name}</div>,
        });

        expect(screen.getByRole("button", { name: "Name" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Value" })).toBeInTheDocument();
        expect(screen.getByText("Mobile Alpha")).toBeInTheDocument();

        await userEvent.click(screen.getByText("Alpha"));

        expect(onRowClick).toHaveBeenCalledWith({ name: "Alpha", value: 1 });
    });

    it("uses the default empty message and max height when optional props are omitted", () => {
        render(<DatabaseTableShell data={[]} columns={columns} />);

        expect(screen.getByText("No data available.")).toBeInTheDocument();
    });

    it("renders a plain desktop-only table when no mobile renderer is provided", () => {
        renderShell({ maxHeight: "300px" });

        const scrollRegion = screen.getByRole("table").parentElement;
        expect(scrollRegion).toHaveStyle({ maxHeight: "300px" });
        expect(scrollRegion).not.toHaveClass("hidden");
        expect(screen.queryByText(/Mobile/u)).not.toBeInTheDocument();
    });

    it("activates mobile rows by keyboard when a row click handler is provided", async () => {
        const onRowClick = vi.fn();
        renderShell({
            onRowClick,
            renderMobileCard: (row) => <div>Mobile {row.name}</div>,
        });

        const mobileAlpha = screen.getByRole("button", { name: "Mobile Alpha" });
        mobileAlpha.focus();
        await userEvent.keyboard("{Enter}");
        await userEvent.keyboard(" ");

        expect(onRowClick).toHaveBeenNthCalledWith(1, { name: "Alpha", value: 1 });
        expect(onRowClick).toHaveBeenNthCalledWith(2, { name: "Alpha", value: 1 });
    });

    it("sorts rows from sortable column headers", async () => {
        renderShell();

        const table = screen.getByRole("table");
        const bodyRows = () => within(table).getAllByRole("row").slice(1);

        expect(within(bodyRows()[0]!).getByText("Alpha")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Name" }));
        expect(within(bodyRows()[0]!).getByText("Alpha")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Name" }));
        expect(within(bodyRows()[0]!).getByText("Beta")).toBeInTheDocument();
    });
});
