import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import { Icon } from "./Icon.tsx";
import { IconOnlyButton } from "./IconOnlyButton.tsx";

const alertStyle = Object.freeze({
    error: {
        action: "[&_button]:border-red-600/50 [&_button]:bg-red-900/60 [&_button]:text-red-50 [&_button:hover]:bg-red-800/70",
        container: "border-red-900/70 bg-red-950/50 text-red-200",
        icon: CircleAlert,
    },
    info: {
        action: "[&_button]:border-accent-500/50 [&_button]:bg-accent-900/60 [&_button]:text-accent-50 [&_button:hover]:bg-accent-800/70",
        container: "border-accent-900/70 bg-accent-950/45 text-accent-100",
        icon: Info,
    },
    success: {
        action: "[&_button]:border-emerald-600/50 [&_button]:bg-emerald-900/60 [&_button]:text-emerald-50 [&_button:hover]:bg-emerald-800/70",
        container: "border-emerald-900/70 bg-emerald-950/40 text-emerald-200",
        icon: CircleCheck,
    },
    warning: {
        action: "[&_button]:border-amber-500/50 [&_button]:bg-amber-900/60 [&_button]:text-amber-50 [&_button:hover]:bg-amber-800/70",
        container: "border-amber-700/70 bg-amber-950/40 text-amber-100",
        icon: TriangleAlert,
    },
});

function focusElement(element: HTMLDivElement | null): void {
    element?.focus();
}

interface AlertProps {
    readonly action?: ReactNode;
    readonly className?: string;
    readonly dismissLabel?: string;
    readonly focusOnError?: boolean;
    readonly message: string | undefined;
    readonly onDismiss?: () => void;
    readonly variant?: keyof typeof alertStyle;
}

/**
 * Renders and focuses important asynchronous feedback.
 * @returns An alert/status region, or nothing when no message exists.
 */
export function Alert({
    action,
    className,
    dismissLabel = "Dismiss message",
    focusOnError = true,
    message,
    onDismiss,
    variant = "error",
}: AlertProps) {
    if (message === undefined) return null;
    const style = alertStyle[variant];
    return (
        <div
            className={cn(
                "flex items-center gap-2.5 rounded-lg border p-3 text-sm outline-none",
                style.container,
                className
            )}
            key={`${variant}:${message}`}
            ref={focusOnError && variant === "error" ? focusElement : undefined}
            role={variant === "error" ? "alert" : "status"}
            tabIndex={variant === "error" ? -1 : undefined}
        >
            <Icon className="shrink-0" icon={style.icon} size="sm" tone="inherit" />
            <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1">{message}</span>
                {action === undefined ? null : (
                    <div className={cn("shrink-0 self-center", style.action)}>
                        {action}
                    </div>
                )}
            </div>
            {onDismiss !== undefined && (
                <IconOnlyButton
                    className="-my-1 -mr-1 ml-auto shrink-0 text-current"
                    icon={X}
                    label={dismissLabel}
                    onClick={onDismiss}
                    size="sm"
                    variant="ghost"
                />
            )}
        </div>
    );
}
