import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { type ReactNode, type RefObject, useRef } from "react";

const defaultInitialRect = Object.freeze({ height: 480, width: 960 });

export interface VirtualizerRenderState<TItemElement extends Element> {
    readonly measureElement: (node: TItemElement | null) => void;
    readonly scrollContainerRef: RefObject<HTMLDivElement | null>;
    readonly totalSize: number;
    readonly virtualItems: readonly VirtualItem[];
}

interface VirtualizerProps<TItemElement extends Element> {
    readonly children: (state: VirtualizerRenderState<TItemElement>) => ReactNode;
    readonly count: number;
    readonly estimateSize: (index: number) => number;
    readonly getItemKey?: (index: number) => VirtualItem["key"];
    readonly initialRect?: Readonly<{ height: number; width: number }>;
    readonly overscan?: number;
}

/**
 * Exposes a shared TanStack Virtual window without imposing list or table markup.
 * @returns The caller's presentation composed with scroll and measurement state.
 */
export function Virtualizer<TItemElement extends Element = HTMLElement>({
    children,
    count,
    estimateSize,
    getItemKey,
    initialRect = defaultInitialRect,
    overscan = 6,
}: VirtualizerProps<TItemElement>) {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer<HTMLDivElement, TItemElement>({
        count,
        estimateSize,
        getItemKey,
        getScrollElement: () => scrollContainerRef.current,
        initialRect,
        overscan,
    });

    return children({
        measureElement: virtualizer.measureElement,
        scrollContainerRef,
        totalSize: virtualizer.getTotalSize(),
        virtualItems: virtualizer.getVirtualItems(),
    });
}
