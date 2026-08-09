import { expect, waitFor, within } from "storybook/test";

interface VirtualizedTableAssertions {
    readonly canvasElement: HTMLElement;
    readonly fillCanvas?: boolean;
    readonly label: string;
    readonly rowCount: number;
}

interface StickyTableHeaderAssertions {
    readonly canvasElement: HTMLElement;
    readonly label: string;
}

async function expectOpaqueBackground(element: HTMLElement): Promise<void> {
    const backgroundColor = getComputedStyle(element).backgroundColor;
    await expect(backgroundColor).not.toBe("transparent");
    await expect(backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
}

async function expectHeaderPaintsAboveBody(
    canvasElement: HTMLElement,
    header: HTMLTableSectionElement
): Promise<void> {
    const headerCells = [...header.querySelectorAll<HTMLTableCellElement>("th")];
    const headerBounds = header.getBoundingClientRect();
    const sampleYPositions = [
        headerBounds.top + 2,
        headerBounds.top + headerBounds.height / 2,
        headerBounds.bottom - 2,
    ];

    for (const headerCell of headerCells) {
        await expectOpaqueBackground(headerCell);
        const cellBounds = headerCell.getBoundingClientRect();
        const sampleX = cellBounds.left + cellBounds.width / 2;

        for (const sampleY of sampleYPositions) {
            const hitTarget = canvasElement.ownerDocument.elementFromPoint(
                sampleX,
                sampleY
            );
            await expect(hitTarget?.closest("thead")).toBe(header);
        }
    }
}

/**
 * Verifies that a vertically scrolled shared table keeps its opaque header
 * inside the bordered scroll region and above body rows that pass beneath it.
 */
export async function expectStickyTableHeaderContained({
    canvasElement,
    label,
}: StickyTableHeaderAssertions): Promise<void> {
    const canvas = within(canvasElement);
    const scrollRegion = canvas.getByRole("region", { name: label });
    const table = within(scrollRegion).getByRole("table", { name: label });
    const header = table.querySelector<HTMLTableSectionElement>("thead");
    const bodyRows = table.querySelectorAll<HTMLTableRowElement>("tbody tr");

    if (header === null || bodyRows.length === 0) {
        throw new Error("The sticky table fixture is incomplete.");
    }

    await waitFor(async () => {
        await expect(getComputedStyle(table).display).toBe("table");
        await expect(getComputedStyle(header).position).toBe("sticky");
        await expect(scrollRegion.scrollHeight).toBeGreaterThan(
            scrollRegion.clientHeight
        );
    });

    const initialHeaderTop = header.getBoundingClientRect().top;
    const overlapOffset = header.getBoundingClientRect().height + 12;
    scrollRegion.scrollTop = Math.min(
        overlapOffset,
        scrollRegion.scrollHeight - scrollRegion.clientHeight
    );
    scrollRegion.dispatchEvent(new Event("scroll", { bubbles: true }));

    await waitFor(async () => {
        const scrollBounds = scrollRegion.getBoundingClientRect();
        const headerBounds = header.getBoundingClientRect();
        const scrollContentTop = scrollBounds.top + scrollRegion.clientTop;
        const scrollContentRight =
            scrollBounds.left + scrollRegion.clientLeft + scrollRegion.clientWidth;
        const bodyPassesUnderHeader = [
            ...table.querySelectorAll<HTMLTableRowElement>("tbody tr[data-index]"),
        ].some((row) => {
            const rowBounds = row.getBoundingClientRect();
            return (
                rowBounds.top < headerBounds.bottom && rowBounds.bottom > headerBounds.top
            );
        });

        await expect(scrollRegion.scrollTop).toBeGreaterThan(0);
        await expect(Math.abs(headerBounds.top - initialHeaderTop)).toBeLessThanOrEqual(
            1
        );
        await expect(Math.abs(headerBounds.top - scrollContentTop)).toBeLessThanOrEqual(
            1
        );
        await expect(headerBounds.left).toBeGreaterThanOrEqual(
            scrollBounds.left + scrollRegion.clientLeft - 1
        );
        await expect(headerBounds.right).toBeLessThanOrEqual(scrollContentRight + 1);
        await expect(headerBounds.bottom).toBeLessThan(scrollBounds.bottom);
        await expect(bodyPassesUnderHeader).toBe(true);
    });

    await expectOpaqueBackground(header);
    await expectHeaderPaintsAboveBody(canvasElement, header);

    scrollRegion.scrollTop = scrollRegion.scrollHeight;
    scrollRegion.dispatchEvent(new Event("scroll", { bubbles: true }));

    await waitFor(async () => {
        const scrollBounds = scrollRegion.getBoundingClientRect();
        const headerBounds = header.getBoundingClientRect();
        await expect(scrollRegion.scrollTop).toBeGreaterThan(overlapOffset);
        await expect(
            Math.abs(headerBounds.top - (scrollBounds.top + scrollRegion.clientTop))
        ).toBeLessThanOrEqual(1);
    });

    await expectHeaderPaintsAboveBody(canvasElement, header);
}

function renderedVirtualIndexes(container: ParentNode): number[] {
    return [...container.querySelectorAll<HTMLElement>("[data-index]")].flatMap(
        (element) => {
            const index = Number(element.dataset.index);
            return Number.isSafeInteger(index) ? [index] : [];
        }
    );
}

function firstVisibleVirtualIndex(
    scrollContainer: HTMLElement,
    table: HTMLElement
): number | undefined {
    const scrollTop = scrollContainer.getBoundingClientRect().top;
    const index = [...table.querySelectorAll<HTMLElement>("[data-index]")].find(
        (row) => row.getBoundingClientRect().bottom > scrollTop
    )?.dataset.index;
    return index === undefined ? undefined : Number(index);
}

/** Verifies a virtual table's semantic inventory and independently scrollable window. */
export async function expectVirtualizedTable({
    canvasElement,
    fillCanvas = true,
    label,
    rowCount,
}: VirtualizedTableAssertions): Promise<void> {
    const canvas = within(canvasElement);
    const scrollRegion = canvas.getByRole("region", { name: label });
    const table = within(scrollRegion).getByRole("table", { name: label });
    const canvasStyles = getComputedStyle(canvasElement);
    const canvasContentWidth =
        canvasElement.clientWidth -
        Number.parseFloat(canvasStyles.paddingLeft) -
        Number.parseFloat(canvasStyles.paddingRight);

    await waitFor(() => {
        const indexes = renderedVirtualIndexes(table);
        expect(table).toHaveAttribute("aria-rowcount", String(rowCount + 1));
        expect(indexes.length).toBeGreaterThan(0);
        expect(indexes.length).toBeLessThan(rowCount);
        if (fillCanvas) {
            expect(scrollRegion.getBoundingClientRect().width).toBeGreaterThanOrEqual(
                canvasContentWidth - 1
            );
        }
        expect(scrollRegion.scrollWidth).toBe(scrollRegion.clientWidth);
        expect(scrollRegion.scrollHeight).toBeGreaterThan(scrollRegion.clientHeight);
        expect(canvasElement.ownerDocument.documentElement.scrollWidth).toBe(
            canvasElement.ownerDocument.documentElement.clientWidth
        );
    });

    const initialIndexes = renderedVirtualIndexes(table);
    const initialMaximumIndex = Math.max(...initialIndexes);
    scrollRegion.scrollTop = scrollRegion.scrollHeight;
    scrollRegion.dispatchEvent(new Event("scroll", { bubbles: true }));

    await waitFor(() => {
        const indexes = renderedVirtualIndexes(table);
        expect(scrollRegion.scrollTop).toBeGreaterThan(0);
        expect(Math.max(...indexes)).toBeGreaterThan(initialMaximumIndex);
        expect(indexes.length).toBeLessThan(rowCount);
    });

    scrollRegion.scrollTop = 0;
    scrollRegion.dispatchEvent(new Event("scroll", { bubbles: true }));

    await waitFor(() => {
        const indexes = renderedVirtualIndexes(table);
        expect(scrollRegion.scrollTop).toBe(0);
        expect(Math.min(...indexes)).toBe(0);
    });
}

/** Verifies the shared narrow-container table layout without horizontal scrolling. */
export async function expectResponsiveTableCards({
    canvasElement,
    label,
}: Readonly<{ canvasElement: HTMLElement; label: string }>): Promise<void> {
    const canvas = within(canvasElement);
    const scrollRegion = canvas.getByRole("region", { name: label });
    const table = within(scrollRegion).getByRole("table", { name: label });
    const firstRow = within(table).getAllByRole("row")[1];
    const firstLabel = table.querySelector<HTMLElement>(".dashboard-data-table-label");

    if (firstRow === undefined || firstLabel === null) {
        throw new Error("The responsive table card fixture is incomplete.");
    }

    await waitFor(() => {
        expect(getComputedStyle(table).display).toBe("block");
        expect(getComputedStyle(firstRow).display).toBe("block");
        expect(getComputedStyle(firstLabel).display).toBe("block");
        expect(scrollRegion.scrollWidth).toBe(scrollRegion.clientWidth);
        expect(table.getBoundingClientRect().width).toBeLessThanOrEqual(
            scrollRegion.clientWidth
        );
        expect(canvasElement.ownerDocument.documentElement.scrollWidth).toBe(
            canvasElement.ownerDocument.documentElement.clientWidth
        );
    });
}

/** Verifies row measurement and scroll anchoring across card/table transitions. */
export async function expectResponsiveVirtualizedTableTransition({
    canvasElement,
    container,
    label,
    rowCount,
}: Readonly<{
    canvasElement: HTMLElement;
    container: HTMLElement;
    label: string;
    rowCount: number;
}>): Promise<void> {
    const canvas = within(canvasElement);
    const scrollRegion = canvas.getByRole("region", { name: label });
    const table = within(scrollRegion).getByRole("table", { name: label });

    container.style.width = "70rem";
    container.style.maxWidth = "none";
    await waitFor(() => {
        expect(getComputedStyle(table).display).toBe("table");
        expect(scrollRegion.scrollWidth).toBe(scrollRegion.clientWidth);
        expect(scrollRegion.scrollHeight).toBeLessThan(rowCount * 80);
    });

    scrollRegion.scrollTop = scrollRegion.scrollHeight / 2;
    scrollRegion.dispatchEvent(new Event("scroll", { bubbles: true }));
    let wideAnchor: number | undefined;
    await waitFor(() => {
        wideAnchor = firstVisibleVirtualIndex(scrollRegion, table);
        expect(scrollRegion.scrollTop).toBeGreaterThan(0);
        expect(wideAnchor).toBeDefined();
    });

    container.style.width = "20rem";
    container.style.maxWidth = "20rem";
    await waitFor(() => {
        const narrowAnchor = firstVisibleVirtualIndex(scrollRegion, table);
        expect(getComputedStyle(table).display).toBe("block");
        expect(scrollRegion.scrollWidth).toBe(scrollRegion.clientWidth);
        expect(scrollRegion.scrollHeight).toBeGreaterThan(rowCount * 100);
        expect(Math.abs((narrowAnchor ?? -1) - (wideAnchor ?? -1))).toBeLessThanOrEqual(
            Math.ceil(rowCount / 4)
        );
    });

    scrollRegion.scrollTop = scrollRegion.scrollHeight;
    scrollRegion.dispatchEvent(new Event("scroll", { bubbles: true }));
    await waitFor(() => {
        expect(Math.max(...renderedVirtualIndexes(table))).toBe(rowCount - 1);
    });

    container.style.width = "70rem";
    container.style.maxWidth = "none";
    await waitFor(() => {
        expect(getComputedStyle(table).display).toBe("table");
        expect(scrollRegion.scrollHeight).toBeLessThan(rowCount * 80);
        expect(Math.max(...renderedVirtualIndexes(table))).toBe(rowCount - 1);
    });

    container.style.width = "20rem";
    container.style.maxWidth = "20rem";
    scrollRegion.scrollTop = 0;
    scrollRegion.dispatchEvent(new Event("scroll", { bubbles: true }));
    await waitFor(() => {
        expect(getComputedStyle(table).display).toBe("block");
        expect(Math.min(...renderedVirtualIndexes(table))).toBe(0);
    });
}

interface VirtualizedListAssertions {
    readonly canvasElement: HTMLElement;
    readonly itemCount: number;
    readonly label: string;
}

/** Verifies a virtual list's semantic inventory and independently scrollable window. */
export async function expectVirtualizedList({
    canvasElement,
    itemCount,
    label,
}: VirtualizedListAssertions): Promise<void> {
    const list = within(canvasElement).getByRole("list", { name: label });
    const scrollContainer = list.parentElement;
    if (scrollContainer === null) {
        throw new Error("The virtualized list scroll container is missing.");
    }

    await waitFor(() => {
        const indexes = renderedVirtualIndexes(list);
        expect(indexes.length).toBeGreaterThan(0);
        expect(indexes.length).toBeLessThan(itemCount);
        expect(scrollContainer.scrollHeight).toBeGreaterThan(
            scrollContainer.clientHeight
        );
    });

    const initialIndexes = renderedVirtualIndexes(list);
    const initialMaximumIndex = Math.max(...initialIndexes);
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));

    await waitFor(() => {
        const indexes = renderedVirtualIndexes(list);
        expect(scrollContainer.scrollTop).toBeGreaterThan(0);
        expect(Math.max(...indexes)).toBeGreaterThan(initialMaximumIndex);
        expect(indexes.length).toBeLessThan(itemCount);
    });
}
