import type { ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import {
    type InfiniteScrollContinuation,
    InfiniteScrollTrigger,
} from "./InfiniteScrollTrigger.tsx";
import { Virtualizer } from "./Virtualizer.tsx";

interface VirtualizedListProps<TItem> {
    readonly className?: string;
    readonly estimateSize: (index: number) => number;
    readonly getKey: (item: TItem) => string;
    readonly itemClassName?: string;
    readonly itemRole?: "listitem" | "none" | "treeitem";
    readonly items: readonly TItem[];
    readonly label: string;
    readonly listRole?: "list" | "tree";
    readonly pagination?: InfiniteScrollContinuation;
    /** Keeps every row mounted when row-local unsaved state must survive scrolling. */
    readonly preserveItemState?: boolean;
    readonly renderItem: (item: TItem) => ReactNode;
}

/** @returns A dynamically measured accessible list with automatic continuation. */
export function VirtualizedList<TItem>({
    className,
    estimateSize,
    getKey,
    itemClassName,
    itemRole,
    items,
    label,
    listRole,
    pagination,
    preserveItemState = false,
    renderItem,
}: VirtualizedListProps<TItem>) {
    return (
        <Virtualizer<HTMLLIElement>
            count={items.length}
            estimateSize={estimateSize}
            getItemKey={(index) => {
                const item = items[index];
                return item === undefined ? `missing-list-item-${index}` : getKey(item);
            }}
        >
            {({ containerRef, measureElement, scrollContainerRef, virtualItems }) => {
                const virtualized = !preserveItemState && virtualItems.length > 0;
                // Preserve complete SSR/test semantics until a real scroll viewport is measured.
                const fallbackCount = items.length;
                let fallbackStart = 0;
                const fallbackItems: ReadonlyArray<{
                    index: number;
                    key: number | string;
                    start: number;
                }> = items.slice(0, fallbackCount).map((item, index) => {
                    const start = fallbackStart;
                    fallbackStart += estimateSize(index);
                    return { index, key: getKey(item), start };
                });
                const visibleItems: ReadonlyArray<{
                    index: number;
                    key: number | string;
                    start: number;
                }> = virtualized
                    ? virtualItems.map(({ index, key, start }) => ({
                          index,
                          key: String(key),
                          start,
                      }))
                    : fallbackItems;
                let estimatedTotalSize = 0;
                for (const [index] of items.entries()) {
                    estimatedTotalSize += estimateSize(index);
                }
                return (
                    <section
                        aria-label={`${label} scroll area`}
                        className={cn("max-h-128 overflow-y-auto", className)}
                        ref={scrollContainerRef}
                        tabIndex={0}
                    >
                        <ul
                            aria-label={label}
                            className="relative w-full"
                            ref={containerRef}
                            role={listRole}
                            style={
                                virtualized ? undefined : { height: estimatedTotalSize }
                            }
                        >
                            {visibleItems.map((virtualItem) => {
                                const item = items[virtualItem.index];
                                if (item === undefined) return null;
                                return (
                                    <li
                                        className={cn(
                                            "absolute top-0 left-0 w-full",
                                            itemClassName
                                        )}
                                        data-index={virtualItem.index}
                                        key={virtualItem.key}
                                        ref={virtualized ? measureElement : undefined}
                                        role={itemRole}
                                        style={
                                            virtualized
                                                ? undefined
                                                : {
                                                      transform: `translateY(${virtualItem.start}px)`,
                                                  }
                                        }
                                    >
                                        {renderItem(item)}
                                    </li>
                                );
                            })}
                        </ul>
                        {pagination !== undefined && (
                            <InfiniteScrollTrigger
                                className="py-2"
                                rootRef={scrollContainerRef}
                                {...pagination}
                            />
                        )}
                    </section>
                );
            }}
        </Virtualizer>
    );
}
