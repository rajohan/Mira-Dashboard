import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";

import { DataTable } from "./DataTable.tsx";
import { Virtualizer } from "./Virtualizer.tsx";

const { render, screen, within } = await import("@testing-library/react");

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
}

const fixtureTableFeatures = tableFeatures({});
const fixtureColumnHelper = createColumnHelper<typeof fixtureTableFeatures, FixtureRow>();
const fixtureColumns = fixtureColumnHelper.columns([
    fixtureColumnHelper.accessor("label", { header: "Label" }),
]);
const staticRows = Object.freeze([
    { id: "one", label: "First row" },
    { id: "two", label: "Second row" },
]);
const virtualRows = Object.freeze(
    Array.from({ length: 100 }, (_, index) => ({
        id: `row-${index}`,
        label: `Virtual row ${index}`,
    }))
);

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
    test("renders a complete TanStack table without virtualization", () => {
        render(<TableFixture data={staticRows} virtualized={false} />);

        expect(screen.getByText("First row")).toBeTruthy();
        expect(screen.getByText("Second row")).toBeTruthy();
        const scrollRegion = screen.getByRole("region", { name: "Fixture rows" });
        expect(scrollRegion).not.toHaveAttribute("tabindex");
        expect(scrollRegion.parentElement).toHaveClass(
            "dashboard-data-table-query-container",
            "w-full",
            "max-w-full",
            "min-w-0"
        );
        expect(scrollRegion).toHaveClass(
            "dashboard-data-table-container",
            "w-full",
            "min-w-0",
            "max-w-full"
        );
        expect(scrollRegion).not.toHaveAttribute("data-virtualized");
        const table = screen.getByRole("table", { name: "Fixture rows" });
        expect(table).toHaveClass("dashboard-data-table", "w-full", "min-w-full");
        const firstCell = within(table).getByText("First row").closest("td");
        expect(firstCell).not.toBeNull();
        const mobileLabel = firstCell?.querySelector(".dashboard-data-table-label");
        expect(mobileLabel).toHaveTextContent("Label");
        expect(mobileLabel).toHaveAttribute("aria-hidden", "true");
        expect(firstCell?.querySelector(".dashboard-data-table-value")).toHaveTextContent(
            "First row"
        );
        expect(scrollRegion).not.toHaveClass("max-h-128", "overflow-auto");
    });

    test("composes the table with a bounded virtual row window", () => {
        render(<TableFixture data={virtualRows} virtualized />);

        expect(screen.getByText("Virtual row 0")).toBeTruthy();
        expect(screen.queryByText("Virtual row 99")).toBeNull();
        const scrollRegion = screen.getByRole("region", { name: "Fixture rows" });
        expect(scrollRegion).toHaveAttribute("tabindex", "0");
        expect(scrollRegion).toHaveClass(
            "max-h-128",
            "overflow-auto",
            "overscroll-x-contain",
            "[-webkit-overflow-scrolling:touch]",
            "focus-visible:ring-2"
        );
        expect(scrollRegion).toHaveAttribute("data-virtualized", "true");
        scrollRegion.focus();
        expect(scrollRegion).toHaveFocus();
        const table = screen.getByRole("table");
        expect(table.querySelector("[style]")).toBeNull();
        expect(table.querySelector("td[height]")).toHaveClass(
            "dashboard-data-table-spacer-cell"
        );
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
