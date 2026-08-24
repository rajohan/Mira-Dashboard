import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";

interface LoginPanelProps {
    readonly children: ReactNode;
    readonly description?: string;
    readonly footer: string;
    readonly icon: LucideIcon;
    readonly showStepHeading?: boolean;
    readonly title: string;
}

/**
 * Renders the common branded frame for every authentication step.
 * @returns A focused authentication card.
 */
export function LoginPanel({
    children,
    description,
    footer,
    icon,
    showStepHeading = true,
    title,
}: LoginPanelProps) {
    return (
        <Card
            aria-labelledby="login-heading"
            className="bg-primary-800 mx-auto w-full max-w-md rounded-lg p-4 shadow-none"
        >
            <div className="text-center">
                <span aria-hidden="true" className="block text-4xl">
                    👩‍💻
                </span>
                <p className="text-primary-50 mt-2 text-xl font-semibold">
                    Mira Dashboard
                </p>
                {showStepHeading ? (
                    <div className="text-accent-300 mt-4 flex items-center justify-center gap-2">
                        <Icon icon={icon} size="sm" tone="accent" />
                        <Heading id="login-heading" level={1} size="section">
                            {title}
                        </Heading>
                    </div>
                ) : (
                    <Heading className="sr-only" id="login-heading" level={1}>
                        {title}
                    </Heading>
                )}
                {description !== undefined && (
                    <Text className={showStepHeading ? "mt-2" : "mt-4"} tone="muted">
                        {description}
                    </Text>
                )}
            </div>
            <div className="mt-5">{children}</div>
            <Text className="mt-5 text-center" size="sm" tone="muted">
                {footer}
            </Text>
        </Card>
    );
}
