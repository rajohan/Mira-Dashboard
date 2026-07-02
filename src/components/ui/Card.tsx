import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";

/** Provides props for card. */
interface CardProperties extends HTMLAttributes<HTMLDivElement> {
    variant?: "default" | "bordered";
}

/** Renders the card UI. */
export const Card = forwardRef<HTMLDivElement, CardProperties>(
    ({ className, variant = "default", children, ...properties }, reference) => {
        return (
            <div
                ref={reference}
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
);

Card.displayName = "Card";

/** Renders the card title UI. */
export const CardTitle = forwardRef<
    HTMLHeadingElement,
    HTMLAttributes<HTMLHeadingElement>
>(({ className, children, ...properties }, reference) => {
    return (
        <h3
            ref={reference}
            className={cn("text-lg font-semibold text-primary-50", className)}
            {...properties}
        >
            {children}
        </h3>
    );
});

CardTitle.displayName = "CardTitle";
