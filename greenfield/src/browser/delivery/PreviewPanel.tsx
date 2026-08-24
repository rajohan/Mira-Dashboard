import { ExternalLink as ExternalLinkIcon, Play, Square } from "lucide-react";

import type { DeliveryPreview } from "../../contracts/delivery.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ExternalLink } from "../ui/ExternalLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";

interface PreviewPanelProps {
    readonly busy: boolean;
    readonly controlsFresh: boolean;
    readonly onStop: () => void;
    readonly preview: DeliveryPreview;
}

function previewBadgeVariant(
    status: DeliveryPreview["status"]
): "danger" | "success" | "warning" {
    if (status === "running") return "success";
    return status === "failed" ? "danger" : "warning";
}

const previewLabels: Readonly<Record<DeliveryPreview["status"], string>> = {
    failed: "Failed",
    running: "Running",
    starting: "Starting",
    stopped: "Available",
    stopping: "Stopping",
    "view-only": "View only",
};

/** @returns Global single-slot preview status, independent of pull request listing health. */
export function PreviewPanel({
    busy,
    controlsFresh,
    onStop,
    preview,
}: PreviewPanelProps) {
    const transitional = preview.status === "starting" || preview.status === "stopping";
    const stoppable =
        preview.controlsAvailable &&
        preview.number !== undefined &&
        preview.status !== "stopped" &&
        preview.status !== "view-only";
    return (
        <Card aria-label="Pull request preview slot">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={previewBadgeVariant(preview.status)}>
                            {previewLabels[preview.status]}
                        </Badge>
                        {preview.number === undefined ? null : (
                            <Text as="span">PR #{preview.number}</Text>
                        )}
                    </div>
                    <Text className="mt-2" tone="muted">
                        {preview.title ??
                            preview.reason ??
                            "The isolated preview slot is ready for one exact pull request scope."}
                    </Text>
                    {preview.headSha === undefined ? null : (
                        <code className="text-primary-400 mt-2 block text-xs wrap-anywhere">
                            {preview.headSha}
                        </code>
                    )}
                    {preview.startedAtMs === undefined ? null : (
                        <Text className="mt-1" size="sm" tone="muted">
                            Started {formatDashboardDateTime(preview.startedAtMs)} ·
                            maximum lifetime four hours
                        </Text>
                    )}
                </div>
                <div className="flex flex-wrap gap-2">
                    {preview.url === undefined ? null : (
                        <ExternalLink
                            className="border-primary-600 bg-primary-700/70 rounded-lg border px-3 py-2 text-sm no-underline"
                            href={preview.url}
                        >
                            <Icon icon={ExternalLinkIcon} size="sm" />
                            Open dev
                        </ExternalLink>
                    )}
                    {stoppable ? (
                        <Button
                            aria-describedby={
                                controlsFresh ? undefined : "delivery-preview-stop-reason"
                            }
                            busy={busy}
                            busyLabel="Queueing preview stop…"
                            disabled={!controlsFresh || transitional}
                            onClick={onStop}
                            variant="danger"
                        >
                            <Icon icon={Square} size="sm" />
                            Stop preview
                        </Button>
                    ) : null}
                </div>
            </div>
            {!controlsFresh && stoppable ? (
                <Text
                    className="mt-3"
                    id="delivery-preview-stop-reason"
                    size="sm"
                    tone="muted"
                >
                    A fresh preview-slot revision with no active Delivery action is
                    required to stop this exact owner.
                </Text>
            ) : null}
            {preview.status === "stopped" ? (
                <div className="mt-4 flex items-center gap-2">
                    <Icon icon={Play} size="sm" />
                    <Text size="sm" tone="muted">
                        Start or rebuild controls are attached to eligible pull request
                        cards.
                    </Text>
                </div>
            ) : null}
        </Card>
    );
}
