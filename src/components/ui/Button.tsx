import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../utils/cn";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "primary" | "secondary" | "danger" | "ghost";
    size?: "sm" | "md" | "lg";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = "primary", size = "md", children, ...props }, ref) => {
        return (
            <button
                ref={ref}
                className={cn(
                    "inline-flex items-center justify-center font-medium rounded-lg transition-colors",
                    "outline-none ring-0",
                    {
                        "bg-accent-500 text-white hover:bg-accent-600":
                            variant === "primary",
                        "bg-primary-700 text-primary-100 hover:bg-primary-600":
                            variant === "secondary",
                        "bg-red-500 text-white hover:bg-red-600": variant === "danger",
                        "bg-transparent text-primary-300 hover:bg-primary-700":
                            variant === "ghost",
                    },
                    {
                        "px-2 py-1 text-sm": size === "sm",
                        "px-4 py-2 text-sm": size === "md",
                        "px-6 py-3 text-base": size === "lg",
                    },
                    className,
                )}
                {...props}
            >
                {children}
            </button>
        );
    },
);

Button.displayName = "Button";
