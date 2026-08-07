import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";

interface LoginPanelProps {
    readonly children: ReactNode;
    readonly description: string;
    readonly icon: LucideIcon;
    readonly title: string;
}

/**
 * Renders the common branded frame for every authentication step.
 * @returns A focused authentication card.
 */
export function LoginPanel({ children, description, icon, title }: LoginPanelProps) {
    return (
        <Card
            aria-labelledby="login-heading"
            className="bg-primary-900/80 mx-auto w-full max-w-md p-6 shadow-2xl shadow-black/25"
        >
            <div className="text-accent-300 flex items-center gap-2 text-sm font-medium">
                <Icon icon={icon} size="sm" tone="accent" />
                <span>Mira Dashboard</span>
            </div>
            <Heading className="mt-2" id="login-heading" level={1} size="panel">
                {title}
            </Heading>
            <Text className="mt-2" tone="muted">
                {description}
            </Text>
            <div className="mt-6">{children}</div>
        </Card>
    );
}
