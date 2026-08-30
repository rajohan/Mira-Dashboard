import { MonitorPlay, Play, Square } from "lucide-react";

import type { DeliveryPreview } from "../../contracts/delivery.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ExternalLink } from "../ui/ExternalLink.tsx";
import { Heading } from "../ui/Heading.tsx";
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
): "danger" | "default" | "success" | "warning" {
    if (status === "running" || status === "stopped") return "success";
    if (status === "failed") return "danger";
    return status === "view-only" ? "default" : "warning";
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
        <Card aria-label="Pull request preview slot" className="space-y-3 p-3 sm:p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <Heading className="flex items-center gap-2" level={3}>
                        <Icon icon={MonitorPlay} size="sm" />
                        PR dev
                    </Heading>
                    <Text className="mt-1" size="sm" tone="muted">
                        One prod-like HTTPS dev slot at a fixed PR commit, with isolated
                        Dashboard data and the live production Gateway.
                    </Text>
                </div>
                <div className="grid grid-cols-1 justify-items-start gap-1.5 sm:flex sm:flex-wrap">
                    <Badge variant={previewBadgeVariant(preview.status)}>
                        {previewLabels[preview.status]}
                    </Badge>
                    {stoppable ? (
                        <Button
                            aria-describedby={
                                controlsFresh ? undefined : "delivery-preview-stop-reason"
                            }
                            busy={busy}
                            busyLabel="Preview delivery in progress…"
                            className="w-full sm:w-auto"
                            disabled={!controlsFresh || transitional}
                            onClick={onStop}
                            size="sm"
                            title={
                                controlsFresh
                                    ? undefined
                                    : "Fresh preview authority is required."
                            }
                            variant="secondary"
                        >
                            <Icon icon={Square} size="sm" />
                            Stop dev
                        </Button>
                    ) : null}
                </div>
            </div>
            {preview.number === undefined ? (
                <div className="space-y-1">
                    <Text tone="muted">
                        {preview.reason ??
                            "Run an eligible trusted pull request from its card below."}
                    </Text>
                    {preview.status === "stopped" ? (
                        <div className="flex items-center gap-2">
                            <Icon icon={Play} size="sm" />
                            <Text size="sm" tone="muted">
                                Start or rebuild controls are attached to eligible pull
                                request cards.
                            </Text>
                        </div>
                    ) : null}
                </div>
            ) : (
                <div className="border-primary-700 bg-primary-900/40 rounded-lg border p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                            <Text className="font-medium" tone="default">
                                PR #{preview.number}:{" "}
                                {preview.title ?? "Untitled preview"}
                            </Text>
                            <Text className="mt-1" size="sm" tone="muted">
                                {preview.headSha?.slice(0, 8) ?? "commit pending"}
                                {preview.startedAtMs === undefined
                                    ? ""
                                    : ` · Started ${formatDashboardDateTime(preview.startedAtMs)}`}
                            </Text>
                        </div>
                        {preview.url === undefined ? null : (
                            <ExternalLink
                                className="border-primary-600 bg-primary-700/70 w-full shrink-0 justify-center rounded-lg border px-3 py-1.5 text-sm no-underline sm:w-auto"
                                href={preview.url}
                            >
                                Open dev
                            </ExternalLink>
                        )}
                    </div>
                    {preview.reason === undefined ? null : (
                        <Text className="mt-2" size="sm" tone="muted">
                            {preview.reason}
                        </Text>
                    )}
                </div>
            )}
            {!controlsFresh && stoppable ? (
                <Text
                    className="sr-only"
                    id="delivery-preview-stop-reason"
                    size="sm"
                    tone="muted"
                >
                    A fresh preview-slot revision with no active Delivery action is
                    required to stop this exact owner.
                </Text>
            ) : null}
        </Card>
    );
}
