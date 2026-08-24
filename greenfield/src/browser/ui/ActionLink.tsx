import { createLink } from "@tanstack/react-router";
import type { ComponentPropsWithRef } from "react";

import { cn } from "../lib/classNames.ts";
import { buttonClassNames, type ButtonSize, type ButtonVariant } from "./buttonStyles.ts";

/* oxlint-disable react/only-export-components -- TanStack createLink returns the exported typed component from this local anchor. */

interface ActionAnchorProps extends ComponentPropsWithRef<"a"> {
    readonly fullWidth?: boolean;
    readonly size?: ButtonSize;
    readonly variant?: ButtonVariant;
}

function ActionAnchor({
    children,
    className,
    fullWidth,
    size,
    variant = "unstyled",
    ...properties
}: ActionAnchorProps) {
    return (
        <a
            {...properties}
            className={buttonClassNames({
                className: cn(variant === "unstyled" && "rounded-sm", className),
                fullWidth,
                size,
                variant,
            })}
        >
            {children}
        </a>
    );
}

/**
 * Renders a typed same-origin router link with shared interaction styling.
 * @returns A TanStack Router link supporting route params, search, hash, and action variants.
 */
export const ActionLink = createLink(ActionAnchor);
