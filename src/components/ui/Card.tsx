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
                    "bg-primary-800 rounded-lg p-4",
                    {
                        "border-primary-700 border": variant === "bordered",
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
            className={cn("text-primary-50 text-lg font-semibold", className)}
            {...properties}
        >
            {children}
        </h3>
    );
});

CardTitle.displayName = "CardTitle";
