import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

interface BadgeProps {
    children: React.ReactNode;
    variant?: "default" | "success" | "warning" | "error" | "info" | "main" | "hook" | "cron" | "subagent";
    className?: string;
}

const variantStyles: Record<string, string> = {
    default: "bg-slate-500/20 text-slate-400 border-slate-500/30",
    success: "bg-green-500/20 text-green-400 border-green-500/30",
    warning: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    error: "bg-red-500/20 text-red-400 border-red-500/30",
    info: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    main: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    hook: "bg-green-500/20 text-green-400 border-green-500/30",
    cron: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    subagent: "bg-orange-500/20 text-orange-400 border-orange-500/30",
};

export function Badge({ children, variant = "default", className }: BadgeProps) {
    const combined = twMerge(
        clsx(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
            variantStyles[variant],
            className
        )
    );
    return <span className={combined}>{children}</span>;
}

export function getSessionTypeVariant(type: string | null | undefined): BadgeProps["variant"] {
    const t = (type || "unknown").toUpperCase();
    switch (t) {
        case "MAIN":
            return "main";
        case "HOOK":
            return "hook";
        case "CRON":
            return "cron";
        case "SUBAGENT":
            return "subagent";
        default:
            return "default";
    }
}
