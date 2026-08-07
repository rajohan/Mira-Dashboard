import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { buttonClassNames, type ButtonSize, type ButtonVariant } from "./buttonStyles.ts";

interface ActionLinkProps {
    readonly children: ReactNode;
    readonly className?: string;
    readonly fullWidth?: boolean;
    readonly size?: ButtonSize;
    readonly to: "/" | "/account-security" | "/login";
    readonly variant?: ButtonVariant;
}

/**
 * Renders a semantic router link with the shared Dashboard action styling.
 * @returns A client-side navigation action.
 */
export function ActionLink({
    children,
    className,
    fullWidth,
    size,
    to,
    variant,
}: ActionLinkProps) {
    return (
        <Link
            className={buttonClassNames({ className, fullWidth, size, variant })}
            to={to}
        >
            {children}
        </Link>
    );
}
