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
          onRetry?: () => void;
          retryBusy?: boolean;
          retryLabel?: string;
          status: "error";
          title?: ReactNode;
      }>
    | Readonly<{
          action?: ReactNode;
          description?: ReactNode;
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
                    icon={properties.icon}
                    title={properties.title}
                />
            );
        }
        case "error": {
            return (
                <Card
                    aria-labelledby={errorHeadingId}
                    className="mx-auto w-full max-w-xl border-red-900/60"
                    role="alert"
                >
                    <div className="flex items-start gap-3">
                        <Icon
                            className="mt-0.5 shrink-0"
                            icon={TriangleAlert}
                            tone="danger"
                        />
                        <div className="min-w-0">
                            <Heading id={errorHeadingId} level={1} size="subsection">
                                {properties.title ?? "Dashboard unavailable"}
                            </Heading>
                            <Text className="mt-2">{properties.message}</Text>
                            {properties.onRetry !== undefined && (
                                <Button
                                    busy={properties.retryBusy}
                                    busyLabel="Retrying…"
                                    className="mt-4"
                                    onClick={properties.onRetry}
                                    variant="secondary"
                                >
                                    <Icon icon={RotateCw} size="sm" tone="inherit" />
                                    {properties.retryLabel ?? "Try again"}
                                </Button>
                            )}
                        </div>
                    </div>
                </Card>
            );
        }
    }
}
