import { cn } from "../lib/classNames.ts";

interface TaskLabelBadgeProps {
    readonly className?: string;
    readonly label: string;
}

/** @returns One consistently styled task label for cards and task details. */
export function TaskLabelBadge({ className, label }: TaskLabelBadgeProps) {
    return (
        <span
            className={cn(
                "bg-primary-700/70 text-primary-300 max-w-full rounded px-1.5 py-0.5 text-xs wrap-anywhere",
                className
            )}
        >
            {label}
        </span>
    );
}
