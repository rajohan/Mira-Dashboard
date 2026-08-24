import { Button as HeadlessButton } from "@headlessui/react";
import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import { buttonClassNames, type ButtonSize, type ButtonVariant } from "./buttonStyles.ts";
import { Icon } from "./Icon.tsx";
import { LoadingDots } from "./LoadingDots.tsx";

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
            aria-busy={busy || properties["aria-busy"] || undefined}
            aria-label={properties["aria-label"] ?? (busy ? busyLabel : undefined)}
            className={buttonClassNames({ className, fullWidth, size, variant })}
            disabled={unavailable}
            ref={ref}
            type={type}
        >
            {busy && (
                <Icon
                    className="animate-spin motion-reduce:animate-none"
                    icon={LoaderCircle}
                    size="sm"
                    tone="inherit"
                />
            )}
            {busy ? <LoadingDots label={busyLabel} /> : children}
        </HeadlessButton>
    );
}
