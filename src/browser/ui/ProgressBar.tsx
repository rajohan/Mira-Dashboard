import { cn } from "../lib/classNames.ts";

export type ProgressBarTone = "accent" | "danger" | "success" | "warning";

interface ProgressBarProps {
    readonly className?: string;
    readonly label: string;
    readonly maximum?: number;
    readonly size?: "md" | "sm";
    readonly tone?: ProgressBarTone;
    readonly value: number;
}

interface ProgressBarToneClassNames {
    readonly fallback: string;
    readonly native: string;
}

const toneClassNames: Readonly<Record<ProgressBarTone, ProgressBarToneClassNames>> =
    Object.freeze({
        accent: Object.freeze({
            fallback: "bg-accent-500",
            native: "[&::-moz-progress-bar]:bg-accent-500 [&::-webkit-progress-value]:bg-accent-500",
        }),
        danger: Object.freeze({
            fallback: "bg-red-500",
            native: "[&::-moz-progress-bar]:bg-red-500 [&::-webkit-progress-value]:bg-red-500",
        }),
        success: Object.freeze({
            fallback: "bg-emerald-500",
            native: "[&::-moz-progress-bar]:bg-emerald-500 [&::-webkit-progress-value]:bg-emerald-500",
        }),
        warning: Object.freeze({
            fallback: "bg-amber-500",
            native: "[&::-moz-progress-bar]:bg-amber-500 [&::-webkit-progress-value]:bg-amber-500",
        }),
    });

function automaticTone(percent: number): ProgressBarTone {
    if (percent < 50) return "success";
    if (percent < 75) return "accent";
    if (percent < 90) return "warning";
    return "danger";
}

/**
 * Renders a compact accessible meter for bounded operational progress.
 * @returns A labelled progress bar with clamped visual and semantic values.
 */
export function ProgressBar({
    className,
    label,
    maximum = 100,
    size = "md",
    tone,
    value,
}: ProgressBarProps) {
    const safeMaximum = Number.isFinite(maximum) && maximum > 0 ? maximum : 1;
    const safeValue = Number.isFinite(value)
        ? Math.min(safeMaximum, Math.max(0, value))
        : 0;
    const percent = (safeValue / safeMaximum) * 100;
    const effectiveTone = tone ?? automaticTone(percent);

    return (
        <progress
            aria-label={label}
            aria-valuemax={safeMaximum}
            aria-valuemin={0}
            aria-valuenow={safeValue}
            className={cn(
                "bg-primary-700 [&::-webkit-progress-bar]:bg-primary-700 appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:transition-[width] motion-reduce:[&::-moz-progress-bar]:transition-none [&::-webkit-progress-bar]:h-full [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:transition-[width] motion-reduce:[&::-webkit-progress-value]:transition-none",
                size === "sm" ? "h-1.5" : "h-2",
                toneClassNames[effectiveTone].native,
                className
            )}
            max={safeMaximum}
            value={safeValue}
        >
            <span
                aria-hidden="true"
                className={cn(
                    "h-full transition-[width] duration-500 motion-reduce:transition-none",
                    toneClassNames[effectiveTone].fallback
                )}
                style={{ width: `${percent}%` }}
            />
        </progress>
    );
}
