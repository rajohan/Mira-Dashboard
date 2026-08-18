import type { HTMLAttributes, ReactNode, Ref } from "react";

import { cn } from "../lib/classNames.ts";

const headingSizes = Object.freeze({
    page: "text-3xl tracking-tight sm:text-4xl",
    panel: "text-2xl",
    section: "text-xl",
    subsection: "text-base",
});

const defaultHeadingSizes = Object.freeze({
    1: "page",
    2: "section",
    3: "subsection",
} satisfies Readonly<Record<1 | 2 | 3, keyof typeof headingSizes>>);

interface HeadingProps extends Omit<HTMLAttributes<HTMLHeadingElement>, "children"> {
    readonly children: ReactNode;
    readonly level: keyof typeof defaultHeadingSizes;
    readonly ref?: Ref<HTMLHeadingElement>;
    readonly size?: keyof typeof headingSizes;
}

/**
 * Renders a semantic Dashboard heading with the shared visual hierarchy.
 * @returns An h1, h2, or h3 matching its document-outline level.
 */
export function Heading({
    children,
    className,
    level,
    ref,
    size = defaultHeadingSizes[level],
    ...properties
}: HeadingProps) {
    const resolvedClassName = cn(
        "text-primary-50 font-semibold",
        headingSizes[size],
        className
    );
    switch (level) {
        case 1: {
            return (
                <h1 {...properties} className={resolvedClassName} ref={ref}>
                    {children}
                </h1>
            );
        }
        case 2: {
            return (
                <h2 {...properties} className={resolvedClassName} ref={ref}>
                    {children}
                </h2>
            );
        }
        case 3: {
            return (
                <h3 {...properties} className={resolvedClassName} ref={ref}>
                    {children}
                </h3>
            );
        }
    }
}
