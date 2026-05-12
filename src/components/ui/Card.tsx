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
                    "bg-primary-800 rounded-lg p-4",
                    {
                        "border-primary-700 border": variant === "bordered",
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
            className={cn("text-primary-50 text-lg font-semibold", className)}
            {...props}
        >
            {children}
        </h3>
    );
});

CardTitle.displayName = "CardTitle";
