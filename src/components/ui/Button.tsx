import { Button as HeadlessButton } from "@headlessui/react";
import { type ButtonHTMLAttributes, forwardRef } from "react";

import { cn } from "../../utils/cn";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "primary" | "secondary" | "danger" | "ghost";
    size?: "sm" | "md" | "lg";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = "primary", size = "md", children, ...props }, ref) => {
        return (
            <HeadlessButton
                ref={ref}
                className={cn(
                    "inline-flex items-center justify-center rounded-lg font-medium transition-colors",
                    "outline-none",
                    {
                        "bg-accent-500 text-white data-hover:bg-accent-600 data-active:bg-accent-700":
                            variant === "primary",
                        "bg-primary-700 text-primary-100 data-hover:bg-primary-600 data-active:bg-primary-500":
                            variant === "secondary",
                        "bg-red-500 text-white data-hover:bg-red-600 data-active:bg-red-700": variant === "danger",
                        "bg-transparent text-primary-300 data-hover:bg-primary-700 data-active:bg-primary-600":
                            variant === "ghost",
                    },
                    {
                        "px-2 py-1 text-sm": size === "sm",
                        "px-4 py-2 text-sm": size === "md",
                        "px-6 py-3 text-base": size === "lg",
                    },
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50",
                    className
                )}
                {...props}
            >
                {children}
            </HeadlessButton>
        );
    }
);

Button.displayName = "Button";