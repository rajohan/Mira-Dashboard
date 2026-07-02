import { AlertCircle, CheckCircle, Info, XCircle } from "lucide-react";

import { cn } from "../../utils/cn";

/** Defines alert variant. */
type AlertVariant = "error" | "success" | "warning" | "info";

/** Provides props for alert. */
interface AlertProperties {
    variant?: AlertVariant;
    title?: string;
    children: React.ReactNode;
    className?: string;
}

const variants: Record<
    AlertVariant,
    { border: string; bg: string; text: string; icon: React.ReactNode }
> = {
    error: {
        border: "border-red-500",
        bg: "bg-red-500/20",
        text: "text-red-400",
        icon: <XCircle className="size-5" />,
    },
    success: {
        border: "border-green-500",
        bg: "bg-green-500/20",
        text: "text-green-400",
        icon: <CheckCircle className="size-5" />,
    },
    warning: {
        border: "border-yellow-500",
        bg: "bg-yellow-500/20",
        text: "text-yellow-400",
        icon: <AlertCircle className="size-5" />,
    },
    info: {
        border: "border-blue-500",
        bg: "bg-blue-500/20",
        text: "text-blue-400",
        icon: <Info className="size-5" />,
    },
};

/** Renders the alert UI. */
export function Alert({ variant = "info", title, children, className }: AlertProperties) {
    const { border, bg, text, icon } = variants[variant];

    return (
        <div
            className={cn(
                "flex items-start gap-3 rounded-lg border p-3",
                border,
                bg,
                text,
                className
            )}
        >
            <span className="mt-0.5 shrink-0">{icon}</span>
            <div className="flex-1">
                {title && <p className="font-medium">{title}</p>}
                <div className={title ? "text-sm opacity-90" : ""}>{children}</div>
            </div>
        </div>
    );
}
