import { ExternalLink as ExternalLinkGlyph } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import { Icon } from "./Icon.tsx";
import { interactiveTapClassName } from "./interactionStyles.ts";

export interface ExternalLinkProps extends Omit<
    ComponentPropsWithRef<"a">,
    "children" | "href" | "rel" | "target"
> {
    readonly children: ReactNode;
    readonly href: string;
    readonly showIcon?: boolean;
}

/**
 * Renders an external link with one consistent visual and security contract.
 * @returns A link that opens in a separate, non-opener browser context.
 */
export function ExternalLink({
    children,
    className,
    href,
    showIcon = true,
    ...properties
}: ExternalLinkProps) {
    return (
        <a
            {...properties}
            className={cn(
                interactiveTapClassName,
                "text-accent-300 inline-flex items-center gap-1 underline-offset-4 transition-colors",
                "hover:text-accent-200 hover:underline",
                "focus-visible:ring-accent-300 focus-visible:ring-offset-primary-900 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
                className
            )}
            href={href}
            rel="noopener noreferrer"
            target="_blank"
        >
            {children}
            {showIcon && (
                <Icon
                    className="shrink-0"
                    icon={ExternalLinkGlyph}
                    size="sm"
                    tone="inherit"
                />
            )}
            <span className="sr-only"> (opens in a new tab)</span>
        </a>
    );
}
