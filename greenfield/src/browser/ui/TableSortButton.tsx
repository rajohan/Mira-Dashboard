import { ArrowDown, ArrowUp } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { nextTableSortDirection, type TableSortDirection } from "./tableSortState.ts";

interface TableSortButtonProps {
    readonly accessibleLabel?: string;
    readonly children: ReactNode;
    readonly direction: TableSortDirection;
    readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

function sortIcon(direction: TableSortDirection) {
    if (direction === "ascending") return ArrowUp;
    if (direction === "descending") return ArrowDown;
    return null;
}

/** @returns A shared desktop table sorting control and state indicator. */
export function TableSortButton({
    accessibleLabel,
    children,
    direction,
    onClick,
}: TableSortButtonProps) {
    const nextDirection = nextTableSortDirection(direction);
    const SortIcon = sortIcon(direction);
    return (
        <Button
            aria-label={accessibleLabel}
            className="hover:text-primary-50 focus-visible:ring-accent-300 inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm text-left"
            onClick={onClick}
            title={`Sort ${nextDirection}`}
            type="button"
            variant="unstyled"
        >
            <span className="min-w-0 whitespace-normal">{children}</span>
            {SortIcon === null ? null : (
                <Icon className="shrink-0" icon={SortIcon} size="sm" tone="inherit" />
            )}
        </Button>
    );
}
