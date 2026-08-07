import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "./classNames.ts";
import { Icon } from "./Icon.tsx";

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
    readonly message: string | undefined;
    readonly variant?: keyof typeof alertStyle;
}

/**
 * Renders and focuses important asynchronous feedback.
 * @returns An alert/status region, or nothing when no message exists.
 */
export function Alert({ className, message, variant = "error" }: AlertProps) {
    const element = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (message !== undefined && variant === "error") element.current?.focus();
    }, [message, variant]);
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
            <span>{message}</span>
        </div>
    );
}
