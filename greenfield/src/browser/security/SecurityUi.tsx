import type { ReactNode } from "react";

import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Text } from "../ui/Text.tsx";

interface SecuritySectionProps {
    readonly children: ReactNode;
    readonly description: string;
    readonly id: string;
    readonly title: string;
}

export function SecuritySection({
    children,
    description,
    id,
    title,
}: SecuritySectionProps) {
    return (
        <Card aria-labelledby={id}>
            <Heading id={id} level={2}>
                {title}
            </Heading>
            <Text className="mt-2" tone="muted">
                {description}
            </Text>
            <div className="mt-5">{children}</div>
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
