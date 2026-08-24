import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Text } from "../ui/Text.tsx";
import { deliveryFailureMessage } from "./deliveryPresentation.ts";
import { deliveryBrowserRetainedMessage } from "./deliveryRetainedMessage.ts";

interface DeliveryReadRegionProps {
    readonly children?: ReactNode;
    readonly error: unknown;
    readonly fetching: boolean;
    readonly headingId: string;
    readonly loading: boolean;
    readonly onRetry: () => void;
    readonly showRetainedFeedback?: boolean;
    readonly state?: "fresh" | "last-known-good" | "unavailable";
    readonly title: string;
    readonly titleIcon?: LucideIcon;
    readonly visuallyHiddenTitle?: boolean;
}

/** @returns One independently refreshable Delivery read boundary. */
export function DeliveryReadRegion({
    children,
    error,
    fetching,
    headingId,
    loading,
    onRetry,
    showRetainedFeedback = true,
    state,
    title,
    titleIcon,
    visuallyHiddenTitle = false,
}: DeliveryReadRegionProps) {
    const browserRetained = error !== null && state !== undefined;
    const hideTitle =
        visuallyHiddenTitle &&
        (!showRetainedFeedback || (state === "fresh" && !browserRetained));
    return (
        <section
            aria-label={hideTitle ? title : undefined}
            aria-labelledby={hideTitle ? undefined : headingId}
            className="space-y-2"
        >
            {hideTitle ? null : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        {titleIcon === undefined ? null : (
                            <Icon icon={titleIcon} tone="accent" />
                        )}
                        <Heading
                            className={visuallyHiddenTitle ? "sr-only" : undefined}
                            id={headingId}
                            level={2}
                            size="subsection"
                        >
                            {title}
                        </Heading>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {showRetainedFeedback && state === "last-known-good" ? (
                            <Badge variant="warning">Server last-known-good</Badge>
                        ) : null}
                        {showRetainedFeedback && browserRetained ? (
                            <Badge variant="warning">Browser-retained</Badge>
                        ) : null}
                    </div>
                </div>
            )}
            {loading && state === undefined ? (
                <PageState label={`Loading ${title}…`} status="loading" />
            ) : null}
            {!loading && state === undefined ? (
                <PageState
                    headingLevel={3}
                    message={deliveryFailureMessage(error)}
                    onRetry={onRetry}
                    retryBusy={fetching}
                    status="error"
                    title={`${title} unavailable`}
                />
            ) : null}
            {showRetainedFeedback && browserRetained ? (
                <Alert
                    focusOnError={false}
                    message={deliveryBrowserRetainedMessage(title)}
                    variant="warning"
                />
            ) : null}
            {showRetainedFeedback && state === "last-known-good" ? (
                <Alert
                    focusOnError={false}
                    message={`The worker retained the last verified ${title.toLowerCase()} snapshot. Consequential controls require fresh data.`}
                    variant="warning"
                />
            ) : null}
            {state === "unavailable" ? (
                <Card>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <Text>
                            No verified {title.toLowerCase()} data is available yet.
                        </Text>
                        <Badge variant="danger">Unavailable</Badge>
                    </div>
                </Card>
            ) : null}
            {showRetainedFeedback &&
            state !== undefined &&
            (state !== "fresh" || browserRetained) ? (
                <Button busy={fetching} onClick={onRetry} variant="secondary">
                    Try again
                </Button>
            ) : null}
            {state !== undefined && state !== "unavailable" ? children : null}
        </section>
    );
}
