import {
    Popover as HeadlessPopover,
    PopoverButton as HeadlessPopoverButton,
    PopoverPanel as HeadlessPopoverPanel,
} from "@headlessui/react";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import { Button, type ButtonProps } from "./Button.tsx";

interface PopoverProps {
    readonly children: ReactNode;
    readonly className?: string;
}

/** @returns One shared Headless UI popover interaction boundary. */
export function Popover({ children, className }: PopoverProps) {
    return (
        <HeadlessPopover className={cn("relative", className)}>
            {children}
        </HeadlessPopover>
    );
}

/** @returns Shared trigger retaining the Dashboard button and focus contract. */
export function PopoverTrigger(properties: ButtonProps) {
    return <HeadlessPopoverButton as={Button} {...properties} />;
}

interface PopoverContentProps extends HTMLAttributes<HTMLDivElement> {
    readonly align?: "end" | "start";
    readonly anchored?: boolean;
    readonly children: ReactNode;
    readonly gap?: number;
    readonly transition?: boolean;
}

/**
 * Renders an anchored, focus-managed Dashboard popover surface.
 * @returns Shared panel styling with keyboard dismissal and focus restoration.
 */
export function PopoverContent({
    align = "end",
    anchored = true,
    children,
    className,
    gap = 8,
    transition = true,
    ...properties
}: PopoverContentProps) {
    return (
        <HeadlessPopoverPanel
            {...properties}
            anchor={anchored ? { gap, to: `bottom ${align}` } : false}
            className={cn(
                "border-primary-700 bg-primary-950 z-60 w-[min(24rem,calc(100vw-1rem))] rounded-xl border p-4 shadow-2xl shadow-black/50",
                "transition duration-150 data-closed:scale-95 data-closed:opacity-0 motion-reduce:transition-none",
                align === "end" ? "origin-top-right" : "origin-top-left",
                className
            )}
            transition={transition}
        >
            {children}
        </HeadlessPopoverPanel>
    );
}
