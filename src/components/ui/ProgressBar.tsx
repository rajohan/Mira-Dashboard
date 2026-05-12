import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Provides props for progress bar. */
interface ProgressBarProps {
    percent: number;
    color?: "green" | "blue" | "yellow" | "orange" | "red" | "purple";
    size?: "sm" | "md";
    className?: string;
}

const colorStyles = {
    green: "bg-green-500",
    blue: "bg-blue-500",
    yellow: "bg-yellow-500",
    orange: "bg-orange-500",
    red: "bg-red-500",
    purple: "bg-purple-500",
};

const sizeStyles = {
    sm: "h-1.5",
    md: "h-2",
};

/** Renders the progress bar UI. */
export function ProgressBar({
    percent,
    color,
    size = "md",
    className,
}: ProgressBarProps) {
    const effectiveColor = color || getProgressColor(percent);

    return (
        <div
            className={twMerge(
                clsx(
                    "bg-primary-700 overflow-hidden rounded-full",
                    sizeStyles[size],
                    className
                )
            )}
        >
            <div
                className={twMerge(
                    "h-full transition-all duration-500",
                    colorStyles[effectiveColor]
                )}
                style={{ width: Math.min(percent, 100) + "%" }}
            />
        </div>
    );
}

/** Returns progress color. */
export function getProgressColor(
    percent: number
): "green" | "blue" | "yellow" | "orange" | "red" {
    if (percent < 50) return "green";
    if (percent < 75) return "blue";
    if (percent < 90) return "orange";
    return "red";
}
