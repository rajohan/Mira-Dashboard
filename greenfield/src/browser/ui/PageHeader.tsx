import type { ReactNode } from "react";

import { Heading } from "./Heading.tsx";
import { Text } from "./Text.tsx";

interface PageHeaderProps {
    readonly actions?: ReactNode;
    readonly description: ReactNode;
    readonly eyebrow?: ReactNode;
    readonly title: ReactNode;
}

/**
 * Renders the shared hierarchy for one Dashboard route heading.
 * @returns The route heading and description.
 */
export function PageHeader({ actions, description, eyebrow, title }: PageHeaderProps) {
    return (
        <header className="flex flex-col items-start justify-between gap-4 sm:flex-row">
            <div className="max-w-3xl">
                {eyebrow !== undefined && (
                    <Text className="font-medium" tone="accent">
                        {eyebrow}
                    </Text>
                )}
                <Heading className="mt-1" level={1}>
                    {title}
                </Heading>
                <Text className="mt-3" size="lg">
                    {description}
                </Text>
            </div>
            {actions !== undefined && <div className="shrink-0">{actions}</div>}
        </header>
    );
}
