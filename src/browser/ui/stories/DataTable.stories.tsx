import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { createColumnHelper, useTable } from "@tanstack/react-table";
import { expect, waitFor, within } from "storybook/test";

import {
    expectResponsiveTableCards,
    expectStickyTableHeaderContained,
} from "../../storySupport/virtualizationAssertions.ts";
import { dashboardTableFeatures } from "../dashboardTableFeatures.ts";
import { DataTable } from "../DataTable.tsx";
import { Virtualizer } from "../Virtualizer.tsx";

interface TableStoryRow {
    readonly id: string;
    readonly name: string;
    readonly owner: string;
    readonly status: string;
}

const storyTableFeatures = dashboardTableFeatures;
const columnHelper = createColumnHelper<typeof storyTableFeatures, TableStoryRow>();
const columns = columnHelper.columns([
    columnHelper.accessor("name", { header: "Name" }),
    columnHelper.accessor("owner", { header: "Owner" }),
    columnHelper.accessor("status", { header: "Status" }),
]);
const rows = Object.freeze(
    Array.from({ length: 40 }, (_, index) => ({
        id: `row-${index}`,
        name: `Dashboard item ${String(index + 1).padStart(2, "0")}`,
        owner: index % 2 === 0 ? "Mira" : "Raymond",
        status: index % 3 === 0 ? "Needs attention" : "Ready",
    }))
);

function DataTableStory() {
    const table = useTable({
        columns,
        data: rows,
        features: storyTableFeatures,
        getRowId: (row) => row.id,
    });
    const tableRows = table.getRowModel().rows;

    return (
        <div className="mx-auto w-[70rem] max-w-[calc(100vw-2rem)]">
            <Virtualizer<HTMLTableRowElement>
                count={tableRows.length}
                estimateSize={() => 41}
                getItemKey={(index) => tableRows[index]?.id ?? `missing-${index}`}
            >
                {(virtualization) => (
                    <DataTable
                        label="Dashboard items"
                        rowWindow={virtualization}
                        scrollClassName="max-h-72"
                        scrollContainerRef={virtualization.scrollContainerRef}
                        table={table}
                    />
                )}
            </Virtualizer>
        </div>
    );
}

const meta = {
    component: DataTableStory,
    parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DataTableStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const StickyHeaderContainment: Story = {
    globals: { viewport: { isRotated: false, value: "desktop1280" } },
    play: async ({ canvasElement }) => {
        await expectStickyTableHeaderContained({
            canvasElement,
            label: "Dashboard items",
        });
    },
};

export const ResponsiveCardsStayInsideTheScroller: Story = {
    globals: { viewport: { isRotated: false, value: "mobile1" } },
    play: async ({ canvasElement }) => {
        await expectResponsiveTableCards({
            canvasElement,
            label: "Dashboard items",
        });

        const canvas = within(canvasElement);
        const scrollRegion = canvas.getByRole("region", {
            name: "Dashboard items",
        });
        const table = within(scrollRegion).getByRole("table", {
            name: "Dashboard items",
        });
        const header = table.querySelector<HTMLElement>("thead");

        if (header === null) {
            throw new Error("The responsive table header is missing.");
        }

        scrollRegion.scrollTop = scrollRegion.scrollHeight / 2;
        scrollRegion.dispatchEvent(new Event("scroll", { bubbles: true }));

        await waitFor(async () => {
            await expect(scrollRegion.scrollTop).toBeGreaterThan(0);
            await expect(getComputedStyle(header).position).toBe("absolute");
            await expect(header.getBoundingClientRect().width).toBe(1);
            await expect(scrollRegion.scrollWidth).toBe(scrollRegion.clientWidth);
        });

        const scrollBounds = scrollRegion.getBoundingClientRect();
        const hitTarget = canvasElement.ownerDocument.elementFromPoint(
            scrollBounds.left + scrollBounds.width / 2,
            scrollBounds.top + 12
        );
        await expect(hitTarget?.closest("tbody")).not.toBeNull();
    },
};
