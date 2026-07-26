import { ExternalLink, MonitorPlay } from "lucide-react";

import type { PullRequestPreviewStatus } from "../../../hooks";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
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

/** Renders the global single-slot trusted PR development status. */
export function PullRequestPreviewCard({
    error,
    preview,
}: {
    error?: Error;
    preview: PullRequestPreviewStatus | undefined;
}) {
    const status = preview?.status ?? "stopped";
    const hasPreview = preview?.number !== undefined;

    return (
        <Card variant="bordered" className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <MonitorPlay className="size-4" />
                        PR dev
                    </CardTitle>
                    <p className="mt-1 text-sm text-primary-400">
                        One prod-like HTTPS dev slot with hot reload, isolated Dashboard
                        data, and the live production Gateway.
                    </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                    <Badge variant={error ? "error" : previewVariant(status)}>
                        {error ? "Status unavailable" : previewLabel(status)}
                    </Badge>
                </div>
            </div>

            {error ? (
                <p className="text-sm text-red-300">{error.message}</p>
            ) : hasPreview ? (
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
            ) : (
                <div className="space-y-1 text-sm text-primary-400">
                    <p>Run an eligible trusted PR in dev from its card below.</p>
                    <p className="text-xs text-primary-500">
                        Chat and session changes use production Gateway data. Host and
                        backup actions stay blocked.
                    </p>
                </div>
            )}
        </Card>
    );
}
