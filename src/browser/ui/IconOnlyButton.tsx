import type { LucideIcon } from "lucide-react";

import { Button, type ButtonProps } from "./Button.tsx";
import { Icon } from "./Icon.tsx";

interface IconOnlyButtonProps extends Omit<
    ButtonProps,
    "busy" | "busyLabel" | "children"
> {
    readonly icon: LucideIcon;
    readonly iconClassName?: string;
    readonly label: string;
}

/**
 * Renders an icon-only shared button with a mandatory accessible label.
 * @returns A consistently sized labelled icon button.
 */
export function IconOnlyButton({
    icon,
    iconClassName,
    label,
    size = "sm",
    title = label,
    ...properties
}: IconOnlyButtonProps) {
    return (
        <Button {...properties} aria-label={label} size={size} title={title}>
            <Icon
                className={iconClassName}
                icon={icon}
                size={size === "lg" ? "md" : "sm"}
                tone="inherit"
            />
        </Button>
    );
}
