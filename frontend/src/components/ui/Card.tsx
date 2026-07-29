import type { HTMLAttributes, Ref } from "react";

import { cn } from "../../utils/cn";

/** Provides props for card. */
interface CardProperties extends HTMLAttributes<HTMLDivElement> {
    ref?: Ref<HTMLDivElement>;
    variant?: "default" | "bordered";
}

/**
 * Renders the card UI.
 * @returns Rendered the card UI.
 */
export function Card({
    className,
    variant = "default",
    children,
    ref,
    ...properties
}: CardProperties) {
    return (
        <div
            ref={ref}
            className={cn(
                "rounded-lg bg-primary-800 p-4",
                {
                    "border border-primary-700": variant === "bordered",
                },
                className
            )}
            {...properties}
        >
            {children}
        </div>
    );
}

/**
 * Renders the card title UI.
 * @returns Rendered the card title UI.
 */
export function CardTitle({
    className,
    children,
    ref,
    ...properties
}: HTMLAttributes<HTMLHeadingElement> & { ref?: Ref<HTMLHeadingElement> }) {
    return (
        <h3
            ref={ref}
            className={cn("text-lg font-semibold text-primary-50", className)}
            {...properties}
        >
            {children}
        </h3>
    );
}
