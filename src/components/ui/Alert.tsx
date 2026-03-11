import { AlertCircle, CheckCircle, Info, XCircle } from "lucide-react";

import { cn } from "../../utils/cn";

type AlertVariant = "error" | "success" | "warning" | "info";

interface AlertProps {
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
        icon: <XCircle className="h-5 w-5" />,
    },
    success: {
        border: "border-green-500",
        bg: "bg-green-500/20",
        text: "text-green-400",
        icon: <CheckCircle className="h-5 w-5" />,
    },
    warning: {
        border: "border-yellow-500",
        bg: "bg-yellow-500/20",
        text: "text-yellow-400",
        icon: <AlertCircle className="h-5 w-5" />,
    },
    info: {
        border: "border-blue-500",
        bg: "bg-blue-500/20",
        text: "text-blue-400",
        icon: <Info className="h-5 w-5" />,
    },
};

export function Alert({ variant = "info", title, children, className }: AlertProps) {
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
            <span className="mt-0.5 flex-shrink-0">{icon}</span>
            <div className="flex-1">
                {title && <p className="font-medium">{title}</p>}
                <div className={title ? "text-sm opacity-90" : ""}>{children}</div>
            </div>
        </div>
    );
}
