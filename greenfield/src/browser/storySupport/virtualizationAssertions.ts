import { expect, waitFor, within } from "storybook/test";

interface VirtualizedTableAssertions {
    readonly canvasElement: HTMLElement;
    readonly fillCanvas?: boolean;
    readonly label: string;
    readonly rowCount: number;
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
