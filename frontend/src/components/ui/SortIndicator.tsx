import { ChevronDown } from "lucide-react";

/** Provides props for a table sort indicator. */
interface SortIndicatorProperties {
    direction: false | "asc" | "desc";
}

/**
 * Renders the active sort direction for a table column.
 * @param properties Component properties.
 * @returns A directional icon when the column is sorted.
 */
export function SortIndicator({ direction }: SortIndicatorProperties) {
    if (!direction) {
        return;
    }

    return (
        <ChevronDown className={direction === "desc" ? "size-3 rotate-180" : "size-3"} />
    );
}
