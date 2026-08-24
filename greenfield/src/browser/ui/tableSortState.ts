export type TableSortDirection = false | "ascending" | "descending";

/** @returns The next state in the ascending, descending, off sort cycle. */
export function nextTableSortDirection(
    direction: TableSortDirection
): "ascending" | "descending" | "off" {
    if (direction === "ascending") return "descending";
    if (direction === "descending") return "off";
    return "ascending";
}
