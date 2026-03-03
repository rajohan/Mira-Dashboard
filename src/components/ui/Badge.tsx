import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

interface BadgeProps {
    children: React.ReactNode;
    variant?: "default" | "success" | "warning" | "error" | "info";
    color?: string;
    className?: string;
}

export function Badge({ children, variant = "default", color, className }: BadgeProps) {
    const variantStyles = {
        default: "bg-slate-500/20 text-slate-400 border-slate-500/30",
        success: "bg-green-500/20 text-green-400 border-green-500/30",
        warning: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
        error: "bg-red-500/20 text-red-400 border-red-500/30",
        info: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    };

    return (
        <span
            className={twMerge(
                clsx(
                    "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                    color || variantStyles[variant],
                    className
                )
            )}
        >
            {children}
        </span>
    );
}