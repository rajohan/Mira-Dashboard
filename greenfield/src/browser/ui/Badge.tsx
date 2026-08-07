import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "./classNames.ts";

const badgeStyles = Object.freeze({
    danger: "border-red-500/30 bg-red-500/15 text-red-300",
    default: "border-primary-500/30 bg-primary-500/15 text-primary-300",
    info: "border-accent-500/30 bg-accent-500/15 text-accent-300",
    success: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
    warning: "border-amber-500/30 bg-amber-500/15 text-amber-300",
});

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
    readonly children: ReactNode;
    readonly variant?: keyof typeof badgeStyles;
}

/**
 * Renders compact shared status metadata.
 * @returns A consistently styled status badge.
 */
export function Badge({
    children,
    className,
    variant = "default",
    ...properties
}: BadgeProps) {
    return (
        <span
            {...properties}
            className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
                badgeStyles[variant],
                className
            )}
        >
            {children}
        </span>
    );
}
