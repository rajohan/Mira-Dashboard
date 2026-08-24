import { RotateCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { type ReactNode, useId } from "react";

import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Heading } from "./Heading.tsx";
import { Icon } from "./Icon.tsx";
import { LoadingState } from "./LoadingState.tsx";
import { Text } from "./Text.tsx";

type PageStateProps =
    | Readonly<{
          children: ReactNode;
          status: "ready";
      }>
    | Readonly<{
          label?: string;
          size?: "lg" | "md" | "sm";
          status: "loading";
      }>
    | Readonly<{
          message: ReactNode;
          headingLevel?: 1 | 2 | 3;
          onRetry?: () => void;
          retryBusy?: boolean;
          retryLabel?: string;
          status: "error";
          title?: ReactNode;
      }>
    | Readonly<{
          action?: ReactNode;
          description?: ReactNode;
          headingLevel?: 1 | 2 | 3;
          icon?: LucideIcon;
          status: "empty";
          title: ReactNode;
      }>;

/**
 * Renders exactly one explicit page or section state.
 * @returns Ready content or a standard loading, error, or empty presentation.
 */
export function PageState(properties: PageStateProps) {
    const errorHeadingId = useId();
    switch (properties.status) {
        case "ready": {
            return <>{properties.children}</>;
        }
        case "loading": {
            return <LoadingState label={properties.label} size={properties.size} />;
        }
        case "empty": {
            return (
                <EmptyState
                    action={properties.action}
                    description={properties.description}
                    headingLevel={properties.headingLevel}
                    icon={properties.icon}
                    title={properties.title}
                />
            );
        }
        case "error": {
            return (
                <Card
                    aria-labelledby={errorHeadingId}
                    className="w-full py-10 text-center"
                    role="alert"
                >
                    <span className="mx-auto flex size-12 items-center justify-center rounded-full border border-red-900/70 bg-red-950/50">
                        <Icon icon={TriangleAlert} size="lg" tone="danger" />
                    </span>
                    <Heading
                        className="text-primary-100 mt-4"
                        id={errorHeadingId}
                        level={properties.headingLevel ?? 1}
                        size="subsection"
                    >
                        {properties.title ?? "Dashboard unavailable"}
                    </Heading>
                    <Text className="mx-auto mt-2 max-w-md" tone="muted">
                        {properties.message}
                    </Text>
                    {properties.onRetry !== undefined && (
                        <Button
                            busy={properties.retryBusy}
                            busyLabel="Retrying…"
                            className="mt-5"
                            onClick={properties.onRetry}
                            variant="secondary"
                        >
                            <Icon icon={RotateCw} size="sm" tone="inherit" />
                            {properties.retryLabel ?? "Try again"}
                        </Button>
                    )}
                </Card>
            );
        }
    }
}
