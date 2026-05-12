import { Button as HeadlessButton } from "@headlessui/react";
import { type ButtonHTMLAttributes, forwardRef } from "react";

import { cn } from "../../utils/cn";

/** Describes button props. */
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "primary" | "secondary" | "danger" | "ghost";
    size?: "sm" | "md" | "lg";
}

/** Renders the button UI. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = "primary", size = "md", children, ...props }, ref) => {
        return (
            <HeadlessButton
                ref={ref}
                className={cn(
                    "inline-flex items-center justify-center rounded-lg font-medium transition-colors",
                    "cursor-pointer outline-none",
                    {
                        "bg-accent-500 hover:bg-accent-600 active:bg-accent-700 data-[active]:bg-accent-700 data-[hover]:bg-accent-600 text-white":
                            variant === "primary",
                        "bg-primary-700 text-primary-100 hover:bg-primary-600 active:bg-primary-500 data-[active]:bg-primary-500 data-[hover]:bg-primary-600":
                            variant === "secondary",
                        "bg-red-500 text-white hover:bg-red-600 active:bg-red-700 data-[active]:bg-red-700 data-[hover]:bg-red-600":
                            variant === "danger",
                        "text-primary-300 hover:bg-primary-700 active:bg-primary-600 data-[active]:bg-primary-600 data-[hover]:bg-primary-700 bg-transparent":
                            variant === "ghost",
                    },
                    {
                        "px-2 py-1 text-sm": size === "sm",
                        "px-4 py-2 text-sm": size === "md",
                        "px-6 py-3 text-base": size === "lg",
                    },
                    "disabled:cursor-not-allowed disabled:opacity-50 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
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
