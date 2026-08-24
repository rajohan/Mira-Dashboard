import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "../lib/classNames.ts";
import { Icon } from "./Icon.tsx";
import { IconOnlyButton } from "./IconOnlyButton.tsx";

const alertStyle = Object.freeze({
    error: {
        container: "border-red-900/70 bg-red-950/50 text-red-200",
        icon: CircleAlert,
    },
    info: {
        container: "border-accent-900/70 bg-accent-950/45 text-accent-100",
        icon: Info,
    },
    success: {
        container: "border-emerald-900/70 bg-emerald-950/40 text-emerald-200",
        icon: CircleCheck,
    },
});

interface AlertProps {
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
    className,
    dismissLabel = "Dismiss message",
    focusOnError = true,
    message,
    onDismiss,
    variant = "error",
}: AlertProps) {
    const element = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (focusOnError && message !== undefined && variant === "error") {
            element.current?.focus();
        }
    }, [focusOnError, message, variant]);
    if (message === undefined) return null;
    const style = alertStyle[variant];
    return (
        <div
            className={cn(
                "flex items-start gap-2.5 rounded-lg border p-3 text-sm outline-none",
                style.container,
                className
            )}
            ref={element}
            role={variant === "error" ? "alert" : "status"}
            tabIndex={variant === "error" ? -1 : undefined}
        >
            <Icon
                className="mt-0.5 shrink-0"
                icon={style.icon}
                size="sm"
                tone="inherit"
            />
            <span className="min-w-0 flex-1">{message}</span>
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
