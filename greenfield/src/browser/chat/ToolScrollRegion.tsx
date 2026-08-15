import { ArrowDown } from "lucide-react";
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";

import { cn } from "../lib/classNames.ts";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";

const endTolerancePx = 2;

interface ToolScrollRegionProps {
    readonly ariaLabel: string;
    readonly children: ReactNode;
    readonly className?: string;
    readonly contentRevision: number | string;
    readonly scrollContainerRef?: RefObject<HTMLDivElement | null>;
}

/**
 * Owns a bounded tool-content scroller and an explicit return-to-bottom control.
 * @param props Scroll-region content, identity, and optional virtualizer ref.
 * @returns Accessible nested scroll region with a contextual end control.
 */
export function ToolScrollRegion({
    ariaLabel,
    children,
    className,
    contentRevision,
    scrollContainerRef,
}: ToolScrollRegionProps) {
    const internalScrollContainerRef = useRef<HTMLDivElement>(null);
    const resolvedScrollContainerRef = scrollContainerRef ?? internalScrollContainerRef;
    const [awayFromBottom, setAwayFromBottom] = useState(false);

    useLayoutEffect(() => {
        const element = resolvedScrollContainerRef.current;
        if (element === null) return;
        const update = () => {
            const remaining =
                element.scrollHeight - element.clientHeight - element.scrollTop;
            setAwayFromBottom(
                element.scrollHeight > element.clientHeight + endTolerancePx &&
                    remaining > endTolerancePx
            );
        };
        update();
        element.addEventListener("scroll", update, { passive: true });
        const resizeObserver =
            typeof ResizeObserver === "undefined"
                ? undefined
                : new ResizeObserver(update);
        const mutationObserver =
            typeof MutationObserver === "undefined"
                ? undefined
                : new MutationObserver(update);
        resizeObserver?.observe(element);
        mutationObserver?.observe(element, {
            childList: true,
            subtree: true,
        });
        return () => {
            element.removeEventListener("scroll", update);
            mutationObserver?.disconnect();
            resizeObserver?.disconnect();
        };
    }, [contentRevision, resolvedScrollContainerRef]);

    return (
        <div className="relative min-w-0">
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
            {awayFromBottom && (
                <IconOnlyButton
                    className="border-primary-600 bg-primary-800/95 absolute bottom-3 left-1/2 z-10 -translate-x-1/2 border shadow-md"
                    icon={ArrowDown}
                    label={`${ariaLabel}: scroll to bottom`}
                    onClick={() => {
                        const element = resolvedScrollContainerRef.current;
                        if (element === null) return;
                        element.scrollTop = element.scrollHeight;
                        setAwayFromBottom(false);
                    }}
                    size="sm"
                    title="To bottom"
                    variant="ghost"
                />
            )}
        </div>
    );
}
