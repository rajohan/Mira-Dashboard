import type { MouseEventHandler, ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import type { DashboardNavigationPath } from "../lib/dashboardRoutes.ts";
import { ActionLink } from "./ActionLink.tsx";

interface NavigationLinkProps {
    readonly active: boolean;
    readonly children: ReactNode;
    readonly className?: string;
    readonly current: boolean;
    readonly onClick?: MouseEventHandler<HTMLAnchorElement>;
    readonly to: DashboardNavigationPath;
}

/**
 * Renders a router-aware navigation link with the shared active-state treatment.
 * @returns A semantic client-side navigation link.
 */
export function NavigationLink({
    active,
    children,
    className,
    current,
    onClick,
    to,
}: NavigationLinkProps) {
    return (
        <ActionLink
            aria-current={current ? "page" : undefined}
            className={cn(
                "mb-1 flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                "focus-visible:ring-accent-300 focus-visible:ring-2 focus-visible:outline-none",
                active
                    ? "bg-accent-500/90 text-primary-950"
                    : "text-primary-300 hover:bg-primary-800 hover:text-primary-50",
                className
            )}
            onClick={onClick}
            to={to}
            variant="unstyled"
        >
            {children}
        </ActionLink>
    );
}
