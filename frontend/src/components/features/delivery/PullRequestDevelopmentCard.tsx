import { ExternalLink, MonitorPlay, Square } from "lucide-react";
import type { ReactNode } from "react";

import type { PullRequestPreviewStatus } from "../../../../../contracts/delivery";
import { messageFromError } from "../../../lib/errorMessage";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";

function previewVariant(status: PullRequestPreviewStatus["status"]) {
    switch (status) {
        case "running": {
            return "success" as const;
        }
        case "starting":
        case "stopping": {
            return "warning" as const;
        }
        case "failed": {
            return "error" as const;
        }
        case "stopped": {
            return "default" as const;
        }
    }
}

function previewLabel(status: PullRequestPreviewStatus["status"]): string {
    switch (status) {
        case "running": {
            return "Running";
        }
        case "starting": {
            return "Starting";
        }
        case "stopping": {
            return "Stopping";
        }
        case "failed": {
            return "Failed";
        }
        case "stopped": {
            return "Available";
        }
    }
}

/**
 * Renders the global single-slot trusted PR development status.
 * @returns Rendered the global single-slot trusted PR development status.
 */
export function PullRequestDevelopmentCard({
    error,
    isStopPending = false,
    onStop,
    preview,
}: {
    error?: Error;
    isStopPending?: boolean;
    onStop?: () => void;
    preview: PullRequestPreviewStatus | undefined;
}) {
    const status = preview?.status ?? "stopped";
    const hasPreview = preview?.number !== undefined;
    const areControlsAvailable = preview?.controlsAvailable !== false;
    let badgeVariant = previewVariant(status);
    let badgeLabel = previewLabel(status);
    if (error) {
        badgeVariant = "error";
        badgeLabel = "Status unavailable";
    } else if (!areControlsAvailable) {
        badgeVariant = "default";
        badgeLabel = "View only";
    }

    let content: ReactNode;
    if (error) {
        content = (
            <p className="text-sm text-red-300">
                {messageFromError(error, "PR dev status is unavailable")}
            </p>
        );
    } else if (preview?.number !== undefined) {
        content = (
            <div className="rounded border border-primary-700 bg-primary-900/40 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <p className="text-sm font-medium text-primary-200">
                            PR #{preview.number}:{" "}
                            {preview.title || "Untitled dev environment"}
                        </p>
                        <p className="mt-1 text-xs text-primary-500">
                            {preview.commitSha?.slice(0, 8) || "commit pending"}
                            {preview.updatedAt
                                ? ` · Updated ${formatDate(preview.updatedAt)}`
                                : ""}
                        </p>
                    </div>
                    {preview.status === "running" && preview.url ? (
                        <a
                            href={preview.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary-700 px-3 py-1.5 text-sm font-medium text-primary-100 transition-colors hover:bg-primary-600"
                        >
                            Open dev
                            <ExternalLink className="size-3.5" />
                        </a>
                    ) : undefined}
                </div>
                {preview.message ? (
                    <p className="mt-2 text-xs text-red-300">{preview.message}</p>
                ) : undefined}
            </div>
        );
    } else if (areControlsAvailable) {
        content = (
            <div className="space-y-1 text-sm text-primary-400">
                <p>Run an eligible trusted PR in dev from its card below.</p>
                <p className="text-xs text-primary-500">
                    Chat and session changes use production Gateway data. Host and backup
                    actions stay blocked.
                </p>
            </div>
        );
    } else {
        content = (
            <p className="text-sm text-primary-400">
                {preview?.message ??
                    "PR dev controls are available only from the production Dashboard."}
            </p>
        );
    }

    return (
        <Card variant="bordered" className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <MonitorPlay className="size-4" />
                        PR dev
                    </CardTitle>
                    <p className="mt-1 text-sm text-primary-400">
                        One prod-like HTTPS dev slot at a fixed PR commit, with isolated
                        Dashboard data and the live production Gateway.
                    </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                    <Badge variant={badgeVariant}>{badgeLabel}</Badge>
                    {hasPreview &&
                    areControlsAvailable &&
                    status !== "stopped" &&
                    onStop ? (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={onStop}
                            disabled={isStopPending || status === "stopping"}
                        >
                            <Square className="size-3.5" />
                            Stop dev
                        </Button>
                    ) : undefined}
                </div>
            </div>

            {content}
        </Card>
    );
}
