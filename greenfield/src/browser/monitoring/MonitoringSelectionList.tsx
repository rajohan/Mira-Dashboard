import type { ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import { Virtualizer } from "../ui/Virtualizer.tsx";

const minimumVirtualizedItems = 50;

interface MonitoringSelectionListProps<TItem> {
    readonly className?: string;
    readonly getKey: (item: TItem) => string;
    readonly items: readonly TItem[];
    readonly label: string;
    readonly renderItem: (item: TItem) => ReactNode;
}

/**
 * Renders bounded catalog pages directly and switches to TanStack Virtual as pages accumulate.
 * @returns An accessible scrollable selection list.
 */
export function MonitoringSelectionList<TItem>({
    className,
    getKey,
    items,
    label,
    renderItem,
}: MonitoringSelectionListProps<TItem>) {
    const listClassName = cn("max-h-128 space-y-2 overflow-auto p-2", className);
    if (items.length < minimumVirtualizedItems) {
        return (
            <ul aria-label={label} className={listClassName}>
                {items.map((item) => (
                    <li key={getKey(item)}>{renderItem(item)}</li>
                ))}
            </ul>
        );
    }

    return (
        <Virtualizer<HTMLLIElement>
            count={items.length}
            estimateSize={() => 92}
            getItemKey={(index) => {
                const item = items[index];
                return item === undefined ? `missing-monitoring-${index}` : getKey(item);
            }}
            initialRect={{ height: 512, width: 384 }}
        >
            {({ measureElement, scrollContainerRef, totalSize, virtualItems }) => (
                <div
                    className={cn("max-h-128 overflow-auto p-2", className)}
                    ref={scrollContainerRef}
                >
                    <ul
                        aria-label={label}
                        className="relative w-full"
                        style={{ height: totalSize }}
                    >
                        {virtualItems.map((virtualItem) => {
                            const item = items[virtualItem.index];
                            if (item === undefined) return null;
                            return (
                                <li
                                    className="absolute top-0 left-0 w-full pb-2"
                                    data-index={virtualItem.index}
                                    key={virtualItem.key}
                                    ref={measureElement}
                                    style={{
                                        transform: `translateY(${virtualItem.start}px)`,
                                    }}
                                >
                                    {renderItem(item)}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
        </Virtualizer>
    );
}
