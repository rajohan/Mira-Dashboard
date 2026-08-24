import type { LucideIcon } from "lucide-react";

import { cn } from "../lib/classNames.ts";

const iconSizes = Object.freeze({
    lg: "size-6",
    md: "size-5",
    sm: "size-4",
    xl: "size-8",
});

const iconTones = Object.freeze({
    accent: "text-accent-300",
    danger: "text-red-300",
    default: "text-primary-400",
    inherit: "text-inherit",
    success: "text-emerald-300",
    warning: "text-amber-300",
});

interface IconProps {
    readonly className?: string;
    readonly icon: LucideIcon;
    readonly label?: string;
    readonly size?: keyof typeof iconSizes;
    readonly strokeWidth?: number;
    readonly tone?: keyof typeof iconTones;
}

/**
 * Renders a consistently sized Lucide icon with explicit accessibility semantics.
 * @returns A decorative icon when unlabeled, or a named image when labelled.
 */
export function Icon({
    className,
    icon: Glyph,
    label,
    size = "md",
    strokeWidth,
    tone = "default",
}: IconProps) {
    return (
        <Glyph
            aria-hidden={label === undefined ? true : undefined}
            aria-label={label}
            className={cn(iconSizes[size], iconTones[tone], className)}
            role={label === undefined ? undefined : "img"}
            strokeWidth={strokeWidth}
        />
    );
}
