import type { ComponentPropsWithRef } from "react";

import { cn } from "../lib/classNames.ts";
import { buttonClassNames, type ButtonSize, type ButtonVariant } from "./buttonStyles.ts";

interface ActionAnchorProps extends ComponentPropsWithRef<"a"> {
    readonly fullWidth?: boolean;
    readonly size?: ButtonSize;
    readonly variant?: ButtonVariant;
}

/** @returns The shared styled anchor consumed by TanStack Router's link factory. */
export function ActionAnchor({
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
