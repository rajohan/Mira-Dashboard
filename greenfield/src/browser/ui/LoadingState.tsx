import { LoaderCircle } from "lucide-react";

import { cn } from "../lib/classNames.ts";
import { Icon } from "./Icon.tsx";

const loadingStateSizes = Object.freeze({
    lg: { container: "min-h-64", icon: "size-8" },
    md: { container: "min-h-40", icon: "size-6" },
    sm: { container: "min-h-24", icon: "size-5" },
});

interface LoadingStateProps {
    readonly className?: string;
    readonly label?: string;
    readonly size?: keyof typeof loadingStateSizes;
}

/**
 * Renders a consistent live loading state.
 * @returns A labelled busy status suitable for pages and sections.
 */
export function LoadingState({
    className,
    label = "Loading…",
    size = "md",
}: LoadingStateProps) {
    const styles = loadingStateSizes[size];
    return (
        <output
            aria-busy="true"
            className={cn(
                "text-primary-400 flex w-full flex-col items-center justify-center gap-2 text-sm",
                styles.container,
                className
            )}
        >
            <Icon className={cn("animate-spin", styles.icon)} icon={LoaderCircle} />
            <span>{label}</span>
        </output>
    );
}
