import type { LucideIcon } from "lucide-react";
import { type ReactNode, useId } from "react";

import { cn } from "../lib/classNames.ts";
import { Card } from "./Card.tsx";
import { Heading } from "./Heading.tsx";
import { Icon } from "./Icon.tsx";
import { Text } from "./Text.tsx";

interface MetricCardMeter {
    readonly label: string;
    readonly maximum: number;
    readonly value: number;
}

interface MetricCardProps {
    readonly className?: string;
    readonly description: ReactNode;
    readonly icon: LucideIcon;
    readonly meter?: MetricCardMeter;
    readonly title: string;
    readonly value: ReactNode;
}

/** @returns One accessible operational value card with an optional bounded meter. */
export function MetricCard({
    className,
    description,
    icon,
    meter,
    title,
    value,
}: MetricCardProps) {
    const headingId = useId();
    const maximum = Math.max(1, meter?.maximum ?? 1);
    const meterValue = Math.min(maximum, Math.max(0, meter?.value ?? 0));

    return (
        <Card aria-labelledby={headingId} className={cn("min-w-0", className)}>
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <Heading id={headingId} level={3}>
                        {title}
                    </Heading>
                    <p className="text-primary-50 mt-3 truncate text-2xl font-semibold tabular-nums">
                        {value}
                    </p>
                </div>
                <span className="bg-accent-500/10 shrink-0 rounded-lg p-2.5">
                    <Icon icon={icon} size="lg" tone="accent" />
                </span>
            </div>
            <Text className="mt-1" tone="muted">
                {description}
            </Text>
            {meter !== undefined && (
                <progress
                    aria-label={meter.label}
                    className="mt-4 h-2 w-full accent-emerald-400"
                    max={maximum}
                    value={meterValue}
                />
            )}
        </Card>
    );
}
