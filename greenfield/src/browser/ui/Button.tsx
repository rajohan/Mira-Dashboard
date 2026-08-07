import { Button as HeadlessButton } from "@headlessui/react";
import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import { buttonClassNames, type ButtonSize, type ButtonVariant } from "./buttonStyles.ts";
import { Icon } from "./Icon.tsx";

export interface ButtonProps extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "disabled"
> {
    readonly busy?: boolean;
    readonly busyLabel?: string;
    readonly children: ReactNode;
    readonly disabled?: boolean;
    readonly fullWidth?: boolean;
    readonly ref?: Ref<HTMLButtonElement>;
    readonly size?: ButtonSize;
    readonly variant?: ButtonVariant;
}

/**
 * Renders the shared Headless UI-backed Dashboard button.
 * @returns An accessible button with consistent interaction states.
 */
export function Button({
    busy = false,
    busyLabel = "Working…",
    children,
    className,
    disabled = false,
    fullWidth = false,
    ref,
    size = "md",
    type = "button",
    variant = "primary",
    ...properties
}: ButtonProps) {
    const unavailable = busy || disabled;
    return (
        <HeadlessButton
            {...properties}
            aria-busy={busy || undefined}
            className={buttonClassNames({ className, fullWidth, size, variant })}
            disabled={unavailable}
            ref={ref}
            type={type}
        >
            {busy && (
                <Icon
                    className="animate-spin"
                    icon={LoaderCircle}
                    size="sm"
                    tone="inherit"
                />
            )}
            {busy ? busyLabel : children}
        </HeadlessButton>
    );
}
