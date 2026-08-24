import type { ReactNode } from "react";

import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Text } from "../ui/Text.tsx";
import { deliveryFailureMessage } from "./deliveryPresentation.ts";

interface DeliveryReadRegionProps {
    readonly children?: ReactNode;
    readonly checkedAtMs?: number;
    readonly error: unknown;
    readonly fetching: boolean;
    readonly headingId: string;
    readonly loading: boolean;
    readonly observedAtMs?: number;
    readonly onRetry: () => void;
    readonly state?: "fresh" | "last-known-good" | "unavailable";
    readonly title: string;
}

/** @returns One independently refreshable Delivery read boundary. */
export function DeliveryReadRegion({
    children,
    checkedAtMs,
    error,
    fetching,
    headingId,
    loading,
    observedAtMs,
    onRetry,
    state,
    title,
}: DeliveryReadRegionProps) {
    const browserRetained = error !== null && state !== undefined;
    return (
        <section aria-labelledby={headingId} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Heading id={headingId} level={2}>
                    {title}
                </Heading>
                <div className="flex flex-wrap items-center gap-2">
                    {state === "fresh" && !browserRetained ? (
                        <Badge variant="success">Fresh</Badge>
                    ) : null}
                    {state === "last-known-good" ? (
                        <Badge variant="warning">Server last-known-good</Badge>
                    ) : null}
                    {browserRetained ? (
                        <Badge variant="warning">Browser-retained</Badge>
                    ) : null}
                    {state === "unavailable" ? (
                        <Badge variant="danger">Unavailable</Badge>
                    ) : null}
                    <Button
                        busy={fetching}
                        busyLabel={`Refreshing ${title}…`}
                        onClick={onRetry}
                        size="sm"
                        variant="ghost"
                    >
                        Refresh
                    </Button>
                </div>
            </div>
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
            {browserRetained ? (
                <Alert
                    focusOnError={false}
                    message={`The latest ${title.toLowerCase()} refresh failed. Showing browser-retained data; consequential controls are disabled.`}
                    variant="warning"
                />
            ) : null}
            {state === "last-known-good" ? (
                <Alert
                    focusOnError={false}
                    message={`The worker retained the last verified ${title.toLowerCase()} snapshot. Consequential controls require fresh data.`}
                    variant="warning"
                />
            ) : null}
            {state === "unavailable" ? (
                <Card>
                    <Text>No verified {title.toLowerCase()} data is available yet.</Text>
                </Card>
            ) : null}
            {state !== undefined && state !== "unavailable" ? children : null}
            {checkedAtMs === undefined ? null : (
                <Text size="sm" tone="muted">
                    Checked {formatDashboardDateTime(checkedAtMs)}
                    {observedAtMs === undefined
                        ? ""
                        : ` · observed ${formatDashboardDateTime(observedAtMs)}`}
                </Text>
            )}
        </section>
    );
}
