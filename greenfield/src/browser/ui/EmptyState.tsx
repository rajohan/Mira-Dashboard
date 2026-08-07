import { Inbox, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import { Card } from "./Card.tsx";
import { Heading } from "./Heading.tsx";
import { Icon } from "./Icon.tsx";
import { Text } from "./Text.tsx";

interface EmptyStateProps {
    readonly action?: ReactNode;
    readonly className?: string;
    readonly description?: ReactNode;
    readonly icon?: LucideIcon;
    readonly title: ReactNode;
}

/**
 * Renders a shared no-results or no-content state.
 * @returns A clear empty-state card with an optional next action.
 */
export function EmptyState({
    action,
    className,
    description,
    icon = Inbox,
    title,
}: EmptyStateProps) {
    return (
        <Card className={cn("py-10 text-center", className)}>
            <Icon className="mx-auto" icon={icon} size="xl" />
            <Heading className="text-primary-100 mt-3" level={2} size="subsection">
                {title}
            </Heading>
            {description !== undefined && (
                <Text className="mx-auto mt-1 max-w-xl" tone="muted">
                    {description}
                </Text>
            )}
            {action !== undefined && <div className="mt-4">{action}</div>}
        </Card>
    );
}
