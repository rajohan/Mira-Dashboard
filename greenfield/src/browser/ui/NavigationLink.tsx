import { Link } from "@tanstack/react-router";
import type { MouseEventHandler, ReactNode } from "react";

import { cn } from "../lib/classNames.ts";

interface NavigationLinkProps {
    readonly active: boolean;
    readonly children: ReactNode;
    readonly className?: string;
    readonly onClick?: MouseEventHandler<HTMLAnchorElement>;
    readonly to: "/" | "/account-security";
}

/**
 * Renders a router-aware navigation link with the shared active-state treatment.
 * @returns A semantic client-side navigation link.
 */
export function NavigationLink({
    active,
    children,
    className,
    onClick,
    to,
}: NavigationLinkProps) {
    return (
        <Link
            aria-current={active ? "page" : undefined}
            className={cn(
                "mb-1 flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                "focus-visible:ring-accent-300 focus-visible:ring-2 focus-visible:outline-none",
                active
                    ? "bg-accent-500/90 text-white"
                    : "text-primary-300 hover:bg-primary-800 hover:text-primary-50",
                className
            )}
            onClick={onClick}
            to={to}
        >
            {children}
        </Link>
    );
}
