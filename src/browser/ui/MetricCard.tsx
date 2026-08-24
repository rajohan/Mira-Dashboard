import type { LucideIcon } from "lucide-react";
import { type ReactNode, useId } from "react";

import { cn } from "../lib/classNames.ts";
import { Card } from "./Card.tsx";
import { Heading } from "./Heading.tsx";
import { Icon } from "./Icon.tsx";
import { ProgressBar } from "./ProgressBar.tsx";
import { Text } from "./Text.tsx";

interface MetricCardMeter {
    readonly label: string;
    readonly maximum: number;
    readonly value: number;
}

interface MetricCardProps {
    readonly className?: string;
    readonly compact?: boolean;
    readonly compactSummary?: boolean;
    readonly description?: ReactNode;
    readonly icon: LucideIcon;
    readonly iconPosition?: "leading" | "trailing";
    readonly meter?: MetricCardMeter;
    readonly title: string;
    readonly value: ReactNode;
}

/** @returns One accessible operational value card with an optional bounded meter. */
export function MetricCard({
    className,
    compact = false,
    compactSummary = false,
    description,
    icon,
    iconPosition = "trailing",
    meter,
    title,
    value,
}: MetricCardProps) {
    const headingId = useId();
    return (
        <Card
            aria-labelledby={headingId}
            className={cn("min-w-0", compact && "p-4", className)}
        >
            <div
                className={cn(
                    iconPosition === "trailing" && "flex items-start justify-between",
                    compact ? "gap-3" : "gap-4"
                )}
            >
                <div className="min-w-0">
                    <div
                        className={cn(
                            iconPosition === "leading" && "flex items-center gap-2"
                        )}
                    >
                        {iconPosition === "leading" && (
                            <Icon icon={icon} size="md" tone="accent" />
                        )}
                        <Heading id={headingId} level={3}>
                            {title}
                        </Heading>
                    </div>
                    {!compactSummary && (
                        <p
                            className={cn(
                                "text-primary-50 truncate font-semibold tabular-nums",
                                compact ? "mt-1 text-xl" : "mt-3 text-2xl"
                            )}
                        >
                            {value}
                        </p>
                    )}
                </div>
                {iconPosition === "trailing" && (
                    <span
                        className={cn(
                            "bg-accent-500/10 shrink-0 rounded-lg",
                            compact ? "p-2" : "p-2.5"
                        )}
                    >
                        <Icon icon={icon} size={compact ? "md" : "lg"} tone="accent" />
                    </span>
                )}
            </div>
            {compactSummary && (
                <div className="mt-2 flex items-end justify-between gap-3">
                    <Text className="min-w-0" tone="muted">
                        {description}
                    </Text>
                    <p className="text-primary-300 shrink-0 text-lg font-semibold tabular-nums">
                        {value}
                    </p>
                </div>
            )}
            {!compactSummary && description !== undefined && (
                <Text className="mt-1" size={compact ? "sm" : "md"} tone="muted">
                    {description}
                </Text>
            )}
            {meter !== undefined && (
                <ProgressBar
                    className={cn(compact ? "mt-3" : "mt-4", "w-full")}
                    label={meter.label}
                    maximum={meter.maximum}
                    size={compact ? "sm" : "md"}
                    value={meter.value}
                />
            )}
        </Card>
    );
}
