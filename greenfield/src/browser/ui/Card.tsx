import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/classNames.ts";

interface CardProps extends HTMLAttributes<HTMLElement> {
    readonly children: ReactNode;
}

/**
 * Renders a shared Dashboard content card.
 * @returns The styled card region.
 */
export function Card({ children, className, ...properties }: CardProps) {
    return (
        <section
            {...properties}
            className={cn(
                "border-primary-700 bg-primary-800/80 rounded-xl border p-5 shadow-sm shadow-black/10",
                className
            )}
        >
            {children}
        </section>
    );
}
