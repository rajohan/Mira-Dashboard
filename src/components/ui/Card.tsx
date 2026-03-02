import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
    variant?: "default" | "bordered";
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
    ({ className, variant = "default", children, ...props }, ref) => {
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
                {...props}
            >
                {children}
            </div>
        );
    }
);

Card.displayName = "Card";

export const CardTitle = forwardRef<
    HTMLHeadingElement,
    HTMLAttributes<HTMLHeadingElement>
>(({ className, children, ...props }, ref) => {
    return (
        <h3
            ref={ref}
            className={cn("text-lg font-semibold text-primary-50", className)}
            {...props}
        >
            {children}
        </h3>
    );
});

CardTitle.displayName = "CardTitle";
