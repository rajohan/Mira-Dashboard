import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createColumnHelper, useTable } from "@tanstack/react-table";
import { useState } from "react";

import { dashboardTableFeatures } from "./dashboardTableFeatures.ts";
import { DataTable } from "./DataTable.tsx";
import { VirtualizedList } from "./VirtualizedList.tsx";
import { Virtualizer } from "./Virtualizer.tsx";

const { fireEvent, render, screen, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight"
);
const originalOffsetWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth"
);
const hadOwnResizeObserver = Object.hasOwn(globalThis, "ResizeObserver");
const originalResizeObserver = Reflect.get(globalThis, "ResizeObserver");

beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get: () => 480,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
        configurable: true,
        get: () => 960,
    });
    Reflect.set(globalThis, "ResizeObserver", undefined);
});

afterAll(() => {
    if (originalOffsetHeight === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    } else {
        Object.defineProperty(
            HTMLElement.prototype,
            "offsetHeight",
            originalOffsetHeight
        );
    }
    if (originalOffsetWidth === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
    } else {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
    }
    if (hadOwnResizeObserver) {
        Reflect.set(globalThis, "ResizeObserver", originalResizeObserver);
    } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
});

interface FixtureRow {
    readonly id: string;
    readonly label: string;
    readonly rank: number;
}

const fixtureTableFeatures = dashboardTableFeatures;
const fixtureColumnHelper = createColumnHelper<typeof fixtureTableFeatures, FixtureRow>();
const fixtureColumns = fixtureColumnHelper.columns([
    fixtureColumnHelper.accessor("label", { header: "Label" }),
    fixtureColumnHelper.accessor("rank", { header: "Rank" }),
]);
const staticRows = Object.freeze([
    { id: "one", label: "First row", rank: 2 },
    { id: "two", label: "Second row", rank: 1 },
]);
const virtualRows = Object.freeze(
    Array.from({ length: 100 }, (_, index) => ({
        id: `row-${index}`,
        label: `Virtual row ${index}`,
        rank: index,
    }))
);

function StatefulRow({ id }: Readonly<{ id: string }>) {
    const [value, setValue] = useState(id);
    return (
        <input
            aria-label={id}
            onChange={(event) => setValue(event.currentTarget.value)}
            value={value}
        />
    );
}

interface TableFixtureProps {
    readonly data: readonly FixtureRow[];
    readonly virtualized: boolean;
}

function TableFixture({ data, virtualized }: TableFixtureProps) {
    const table = useTable({
        columns: fixtureColumns,
        data,
        features: fixtureTableFeatures,
        getRowId: (row) => row.id,
    });
    const rows = table.getRowModel().rows;

    if (!virtualized) {
        return <DataTable label="Fixture rows" table={table} />;
    }

    return (
        <Virtualizer<HTMLTableRowElement>
            count={rows.length}
            estimateSize={() => 36}
            getItemKey={(index) => rows[index]?.id ?? `missing-${index}`}
        >
            {(virtualization) => (
                <DataTable
                    label="Fixture rows"
                    rowWindow={virtualization}
                    scrollContainerRef={virtualization.scrollContainerRef}
                    table={table}
                />
            )}
        </Virtualizer>
    );
}

describe("Dashboard data table and virtualizer", () => {
    test("keeps stateful virtual-list rows mounted across scrolling", async () => {
        render(
            <VirtualizedList
                estimateSize={() => 36}
                getKey={(item) => item}
                items={virtualRows.map(({ id }) => id)}
                label="Stateful rows"
                preserveItemState
                renderItem={(item) => <StatefulRow id={item} />}
            />
        );
        const list = screen.getByRole("list", { name: "Stateful rows" });
        const scrollRegion = list.parentElement!;
        const firstInput = screen.getByRole("textbox", { name: "row-0" });
        fireEvent.change(firstInput, { target: { value: "unsaved draft" } });

        scrollRegion.scrollTop = 3000;
        fireEvent.scroll(scrollRegion);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

        expect(within(list).getAllByRole("listitem")).toHaveLength(virtualRows.length);
        expect(list).not.toHaveClass("relative");
        expect(list).not.toHaveAttribute("style");
        expect(within(list).getAllByRole("listitem")[0]).not.toHaveClass("absolute");
        expect(within(list).getAllByRole("listitem")[0]).not.toHaveAttribute("style");
        expect(screen.getByRole("textbox", { name: "row-0" })).toBe(firstInput);
        expect(firstInput).toHaveValue("unsaved draft");
    });

    test("renders a complete TanStack table without virtualization", () => {
        render(<TableFixture data={staticRows} virtualized={false} />);

        expect(screen.getByText("First row")).toBeTruthy();
        expect(screen.getByText("Second row")).toBeTruthy();
        const scrollRegion = screen.getByRole("region", { name: "Fixture rows" });
        expect(scrollRegion).not.toHaveAttribute("tabindex");
        expect(scrollRegion.parentElement).toHaveClass(
            "dashboard-data-table-query-container",
            "@container",
            "w-full",
            "max-w-full",
            "min-w-0"
        );
        expect(scrollRegion).toHaveClass(
            "dashboard-data-table-container",
            "w-full",
            "min-w-0",
            "max-w-full",
            "overflow-x-auto",
            "@max-[66rem]:overflow-x-hidden",
            "rounded-lg",
            "border"
        );
        expect(scrollRegion).not.toHaveAttribute("data-virtualized");
        const table = screen.getByRole("table", { name: "Fixture rows" });
        expect(table).toHaveClass(
            "dashboard-data-table",
            "w-full",
            "min-w-full",
            "bg-primary-950/40",
            "border-separate",
            "border-spacing-0"
        );
        expect(within(table).getByRole("columnheader", { name: "Label" })).toHaveClass(
            "bg-primary-950"
        );
        const firstCell = within(table).getByText("First row").closest("td");
        expect(firstCell).not.toBeNull();
        expect(firstCell).toHaveClass("border-b", "border-primary-700/60");
        const mobileLabel = firstCell?.querySelector(".dashboard-data-table-label");
        expect(mobileLabel).toHaveTextContent("Label");
        expect(mobileLabel).toHaveAttribute("aria-hidden", "true");
        expect(firstCell?.querySelector(".dashboard-data-table-value")).toHaveTextContent(
            "First row"
        );
        expect(scrollRegion).not.toHaveClass("max-h-128", "overflow-auto");
    });

    test("sorts rows through accessible desktop headers only", async () => {
        render(<TableFixture data={staticRows} virtualized={false} />);

        const table = screen.getByRole("table", { name: "Fixture rows" });
        const header = within(table).getByRole("columnheader", { name: "Label" });
        const rankHeader = within(table).getByRole("columnheader", { name: "Rank" });
        const sortButtons = screen.getAllByRole("button", { name: "Label" });
        expect(sortButtons).toHaveLength(1);
        expect(screen.queryByRole("toolbar")).toBeNull();
        expect(sortButtons[0]?.querySelector("svg")).toBeNull();
        expect(header).not.toHaveAttribute("aria-sort");
        expect(rankHeader).not.toHaveAttribute("aria-sort");

        await userEvent.click(sortButtons[0]!);
        expect(header).toHaveAttribute("aria-sort", "ascending");
        expect(sortButtons[0]?.querySelector(".lucide-arrow-up")).not.toBeNull();
        expect(within(table).getAllByRole("row")[1]).toHaveTextContent("First row");

        fireEvent.click(within(rankHeader).getByRole("button"), { shiftKey: true });
        expect(header).toHaveAttribute("aria-sort", "ascending");
        expect(rankHeader).not.toHaveAttribute("aria-sort");

        await userEvent.click(sortButtons[0]!);
        expect(header).toHaveAttribute("aria-sort", "descending");
        expect(sortButtons[0]?.querySelector(".lucide-arrow-down")).not.toBeNull();
        expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Second row");

        await userEvent.click(sortButtons[0]!);
        expect(header).not.toHaveAttribute("aria-sort");
        expect(sortButtons[0]?.querySelector("svg")).toBeNull();
        expect(within(table).getAllByRole("row")[1]).toHaveTextContent("First row");
    });

    test("starts numeric columns ascending before descending and clearing", async () => {
        render(<TableFixture data={staticRows} virtualized={false} />);

        const table = screen.getByRole("table", { name: "Fixture rows" });
        const header = within(table).getByRole("columnheader", { name: "Rank" });
        const sortButton = within(header).getByRole("button");

        await userEvent.click(sortButton);
        expect(header).toHaveAttribute("aria-sort", "ascending");
        expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Second row");

        await userEvent.click(sortButton);
        expect(header).toHaveAttribute("aria-sort", "descending");
        expect(within(table).getAllByRole("row")[1]).toHaveTextContent("First row");

        await userEvent.click(sortButton);
        expect(header).not.toHaveAttribute("aria-sort");
        expect(within(table).getAllByRole("row")[1]).toHaveTextContent("First row");
    });

    test("composes the table with a bounded virtual row window", () => {
        render(<TableFixture data={virtualRows} virtualized />);

        expect(screen.getByText("Virtual row 0")).toBeTruthy();
        expect(screen.queryByText("Virtual row 99")).toBeNull();
        const scrollRegion = screen.getByRole("region", { name: "Fixture rows" });
        expect(scrollRegion).toHaveAttribute("tabindex", "0");
        expect(scrollRegion).toHaveClass(
            "max-h-128",
            "overflow-x-auto",
            "@max-[66rem]:overflow-x-hidden",
            "overflow-y-auto",
            "[-webkit-overflow-scrolling:touch]",
            "focus-visible:ring-2"
        );
        expect(scrollRegion).toHaveAttribute("data-virtualized", "true");
        scrollRegion.focus();
        expect(scrollRegion).toHaveFocus();
        const table = screen.getByRole("table");
        const body = table.querySelector("tbody");
        expect(body?.style.height).not.toBe("");
        expect(table.querySelector("td[height]")).toBeNull();
        expect(within(table).getAllByRole("row")[1]).toHaveClass("absolute", "grid");
    });

    test("virtualizes non-table content independently", () => {
        render(
            <Virtualizer<HTMLDivElement> count={100} estimateSize={() => 36}>
                {(virtualization) => (
                    <div
                        ref={virtualization.scrollContainerRef}
                        style={{ height: 480, overflow: "auto" }}
                    >
                        <div
                            style={{
                                height: virtualization.totalSize,
                                position: "relative",
                            }}
                        >
                            {virtualization.virtualItems.map((item) => (
                                <div
                                    data-index={item.index}
                                    key={item.key}
                                    ref={virtualization.measureElement}
                                    style={{
                                        position: "absolute",
                                        transform: `translateY(${item.start}px)`,
                                    }}
                                >
                                    Virtual item {item.index}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </Virtualizer>
        );

        expect(screen.getByText("Virtual item 0")).toBeTruthy();
        expect(screen.queryByText("Virtual item 99")).toBeNull();
    });
});
