import { ArrowDown } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

const DETAIL_BOTTOM_THRESHOLD_PX = 8;

/** Provides props for a scrollable chat detail region. */
interface ScrollableDetailContentProperties {
    ariaLabel: string;
    children: ReactNode;
    className: string;
    contentKey: string;
    shouldFollowContent?: boolean;
}

/**
 * Keeps long detail output reachable without taking over the surrounding chat scroll.
 * @returns Rendered scrollable detail content.
 */
export function ScrollableDetailContent({
    ariaLabel,
    children,
    className,
    contentKey,
    shouldFollowContent = false,
}: ScrollableDetailContentProperties) {
    const containerRef = useRef<HTMLElement>(null);
    const shouldStickToBottomRef = useRef(shouldFollowContent);
    const [canScrollFurther, setCanScrollFurther] = useState(false);

    const synchronizeScrollState = (container: HTMLElement) => {
        const canScroll =
            container.scrollHeight - container.scrollTop - container.clientHeight >
            DETAIL_BOTTOM_THRESHOLD_PX;
        setCanScrollFurther((previous) =>
            previous === canScroll ? previous : canScroll
        );
        return canScroll;
    };

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        if (shouldFollowContent && shouldStickToBottomRef.current) {
            container.scrollTop = container.scrollHeight;
        }
        synchronizeScrollState(container);
    }, [contentKey, shouldFollowContent]);

    const scrollToBottom = () => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        container.scrollTop = container.scrollHeight;
        shouldStickToBottomRef.current = true;
        setCanScrollFurther(false);
    };

    return (
        <div className="relative min-w-0">
            {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Clipped output must be keyboard-scrollable. */}
            <section
                ref={containerRef}
                aria-label={`${ariaLabel} scroll area`}
                className={className}
                onScroll={(event) => {
                    const canScroll = synchronizeScrollState(event.currentTarget);
                    if (shouldFollowContent) {
                        shouldStickToBottomRef.current = !canScroll;
                    }
                }}
                tabIndex={0}
            >
                {children}
            </section>
            {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
            {canScrollFurther ? (
                <button
                    type="button"
                    aria-label={`Scroll ${ariaLabel.toLowerCase()} to bottom`}
                    className="absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-accent-500 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg transition-colors hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300"
                    onClick={scrollToBottom}
                >
                    <ArrowDown
                        aria-hidden="true"
                        className="size-4 shrink-0"
                        strokeWidth={2.5}
                    />
                    Bottom
                </button>
            ) : undefined}
        </div>
    );
}
