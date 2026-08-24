import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/classNames.ts";

const textSizes = Object.freeze({
    lg: "text-base leading-7",
    md: "text-sm leading-6",
    sm: "text-xs leading-5",
});

const textTones = Object.freeze({
    accent: "text-accent-300",
    danger: "text-red-300",
    default: "text-primary-300",
    inherit: "text-inherit",
    muted: "text-primary-400",
    success: "text-emerald-300",
    warning: "text-amber-200",
});

interface TextProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
    readonly as?: "p" | "span";
    readonly children: ReactNode;
    readonly size?: keyof typeof textSizes;
    readonly tone?: keyof typeof textTones;
}

/**
 * Renders shared Dashboard body or supporting text without hiding list semantics.
 * @returns A paragraph or inline span with the selected text treatment.
 */
export function Text({
    as: Component = "p",
    children,
    className,
    size = "md",
    tone = "default",
    ...properties
}: TextProps) {
    return (
        <Component
            {...properties}
            className={cn(textSizes[size], textTones[tone], className)}
        >
            {children}
        </Component>
    );
}
