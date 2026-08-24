import { type ReactNode, type RefObject, useRef } from "react";

import { cn } from "../lib/classNames.ts";

interface ToolScrollRegionProps {
    readonly ariaLabel: string;
    readonly children: ReactNode;
    readonly className?: string;
    readonly scrollContainerRef?: RefObject<HTMLDivElement | null>;
}

/**
 * Owns one keyboard-accessible bounded tool-content scroller.
 * @param props Scroll-region content, identity, and optional virtualizer ref.
 * @returns Accessible nested scroll region.
 */
export function ToolScrollRegion({
    ariaLabel,
    children,
    className,
    scrollContainerRef,
}: ToolScrollRegionProps) {
    const internalScrollContainerRef = useRef<HTMLDivElement>(null);
    const resolvedScrollContainerRef = scrollContainerRef ?? internalScrollContainerRef;

    return (
        <section
            aria-label={ariaLabel}
            className={cn("min-w-0", className)}
            data-virtualizer-scroll-region
            ref={resolvedScrollContainerRef}
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Bounded tool source must remain keyboard-scrollable.
            tabIndex={0}
        >
            {children}
        </section>
    );
}
