import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";

interface SecuritySectionProps {
    readonly actions?: ReactNode;
    readonly badge?: ReactNode;
    readonly children?: ReactNode;
    readonly className?: string;
    readonly description: string;
    readonly id: string;
    readonly icon: LucideIcon;
    readonly title: string;
}

export function SecuritySection({
    actions,
    badge,
    children,
    className,
    description,
    id,
    icon,
    title,
}: SecuritySectionProps) {
    return (
        <Card
            aria-labelledby={id}
            className={cn(
                "bg-primary-800 rounded-lg p-4 wrap-anywhere shadow-none",
                className
            )}
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <Icon icon={icon} tone="accent" />
                        <Heading id={id} level={2} size="subsection">
                            {title}
                        </Heading>
                        {badge}
                    </div>
                    <Text className="mt-1" tone="muted">
                        {description}
                    </Text>
                </div>
                {actions}
            </div>
            {children !== undefined && children !== null && children !== false && (
                <div className="mt-4">{children}</div>
            )}
        </Card>
    );
}

interface OneTimeSecretPanelProps {
    readonly children: ReactNode;
    readonly id: string;
    readonly onDismiss: () => void;
    readonly title: string;
}

export function OneTimeSecretPanel({
    children,
    id,
    onDismiss,
    title,
}: OneTimeSecretPanelProps) {
    return (
        <section
            aria-labelledby={`${id}-heading`}
            className="mt-4 rounded-md border border-amber-700/70 bg-amber-950/40 p-4"
        >
            <Heading className="text-amber-100" id={`${id}-heading`} level={3}>
                {title}
            </Heading>
            <Text className="mt-1" tone="warning">
                Save this now. For your security, it disappears when you dismiss it and
                cannot be shown again.
            </Text>
            <div className="mt-3 font-mono text-sm break-all text-amber-50">
                {children}
            </div>
            <Button
                className="mt-4 border-amber-700 text-amber-100"
                onClick={onDismiss}
                size="sm"
                variant="secondary"
            >
                Dismiss
            </Button>
        </section>
    );
}
