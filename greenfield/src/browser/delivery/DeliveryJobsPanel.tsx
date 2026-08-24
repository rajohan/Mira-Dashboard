import { ExternalLink as ExternalLinkIcon } from "lucide-react";

import type { DeliveryDeployment } from "../../contracts/delivery.ts";
import type { DeliveryOperationWarningCode } from "../../shared/deliveryOperationWarnings.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { ExternalLink } from "../ui/ExternalLink.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import { deliveryDeploymentOperationLabels } from "./deliveryPresentation.ts";

interface DeliveryJobsPanelProps {
    readonly deployments: readonly DeliveryDeployment[];
}

const warningLabels: Readonly<Record<DeliveryOperationWarningCode, string>> = {
    "branch-cleanup-unconfirmed":
        "GitHub branch cleanup could not be confirmed after the merge.",
    "branch-retained": "The merged branch was retained.",
    "comment-failed": "The GitHub follow-up comment was not published.",
    "deployment-failed": "Deployment failed after the GitHub operation completed.",
    "deployment-not-started": "Deployment did not start.",
    "deployment-outcome-unknown": "The deployment outcome could not be confirmed.",
    "main-sync-failed": "The production main checkout did not synchronize.",
    "preview-cleanup-failed": "Retained preview cleanup did not complete.",
};

function deploymentWarnings(deployment: DeliveryDeployment): readonly string[] {
    const warnings =
        "warnings" in deployment
            ? deployment.warnings.map((warning) => warningLabels[warning])
            : [];
    return !("postSettlementWarnings" in deployment) ||
        deployment.postSettlementWarnings === undefined
        ? warnings
        : [...warnings, "The Delivery overview refresh is pending."];
}

function deploymentBadgeVariant(
    deployment: DeliveryDeployment
): "danger" | "success" | "warning" {
    if (
        deployment.state === "succeeded" &&
        deployment.outcome === "completed" &&
        deployment.postSettlementWarnings === undefined
    ) {
        return "success";
    }
    return deployment.state === "failed" || deployment.state === "cancelled"
        ? "danger"
        : "warning";
}

function deploymentStatusLabel(deployment: DeliveryDeployment): string {
    if (deployment.state !== "succeeded") return deployment.state;
    if (deployment.outcome === "enqueued") {
        return "Merge queued. Deploy not started";
    }
    if (deployment.outcome === "completed-with-warnings") {
        return "Completed with warnings";
    }
    if (deployment.outcome === "unknown-outcome") return "Outcome unknown";
    return deployment.postSettlementWarnings === undefined
        ? "Completed"
        : "Completed. Overview refresh pending";
}

/** @returns Latest ten production Delivery Jobs, with no raw output or diagnostics. */
export function DeliveryJobsPanel({ deployments }: DeliveryJobsPanelProps) {
    return (
        <Card className="h-fit space-y-3 p-3 sm:p-4">
            <Heading level={2} size="subsection">
                Recent Delivery jobs
            </Heading>
            {deployments.length === 0 ? (
                <Text tone="muted">No Delivery production jobs have been recorded.</Text>
            ) : (
                <ol className="space-y-2">
                    {deployments.map((deployment) => {
                        const warnings = deploymentWarnings(deployment);
                        return (
                            <li
                                aria-label={`Delivery job ${deployment.jobRunId}`}
                                className="border-primary-700 bg-primary-900/40 rounded border p-3"
                                key={deployment.jobRunId}
                            >
                                <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <Badge>
                                                {
                                                    deliveryDeploymentOperationLabels[
                                                        deployment.operation
                                                    ]
                                                }
                                            </Badge>
                                            <Badge
                                                variant={deploymentBadgeVariant(
                                                    deployment
                                                )}
                                            >
                                                {deploymentStatusLabel(deployment)}
                                            </Badge>
                                        </div>
                                        {deployment.commitUrl !== undefined &&
                                        deployment.commitTitle !== undefined ? (
                                            <ExternalLink
                                                className="mt-2"
                                                href={deployment.commitUrl}
                                            >
                                                {deployment.commitTitle}
                                            </ExternalLink>
                                        ) : null}
                                        {deployment.commitSha === undefined ? null : (
                                            <code className="text-primary-400 mt-1 block text-xs wrap-anywhere">
                                                {deployment.commitSha}
                                            </code>
                                        )}
                                        {deployment.note === undefined ? null : (
                                            <Text className="mt-2" tone="muted">
                                                {deployment.note}
                                            </Text>
                                        )}
                                        {warnings.length === 0 ? null : (
                                            <ul className="mt-2 list-disc pl-5">
                                                {warnings.map((warning) => (
                                                    <li key={warning}>
                                                        <Text size="sm" tone="muted">
                                                            {warning}
                                                        </Text>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                        <Text className="mt-2" size="sm" tone="muted">
                                            Updated{" "}
                                            {formatDashboardDateTime(
                                                deployment.updatedAtMs
                                            )}
                                        </Text>
                                    </div>
                                    <ActionLink
                                        className="w-full shrink-0 justify-center whitespace-nowrap sm:w-auto"
                                        search={{ runId: deployment.jobRunId }}
                                        size="sm"
                                        to="/jobs"
                                        variant="secondary"
                                    >
                                        <Icon icon={ExternalLinkIcon} size="sm" />
                                        View job
                                    </ActionLink>
                                </div>
                            </li>
                        );
                    })}
                </ol>
            )}
        </Card>
    );
}
