import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { DeploymentJob } from "../../../../../contracts/delivery/deployments";
import type { PullRequestSummary } from "../../../../../contracts/delivery/pullRequests";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card, CardTitle } from "../../ui/Card";
import { DeploymentCommitLabel } from "./DeliveryLabels";
import {
    authorLabel,
    deploymentStatusLabel,
    deploymentVariant,
    isMiraPullRequest,
    normalizePullRequestBody,
    reviewDecisionLabel,
    reviewDecisionVariant,
    statusVariant,
    summarizeChecks,
} from "./deliveryModel";

/**
 * Renders the pull request description UI.
 * @returns Rendered the pull request description UI.
 */
function PullRequestDescription({ body }: { body: string }) {
    const normalizedBody = normalizePullRequestBody(body);

    return (
        <div className="max-h-80 overflow-auto rounded border border-primary-700 bg-primary-900/50 p-3 sm:p-4">
            <div className="prose max-w-none text-sm wrap-break-word prose-invert prose-headings:my-3 prose-p:my-2 prose-code:before:content-none prose-code:after:content-none prose-ol:my-2 prose-ul:my-2 prose-li:my-0.5 prose-table:my-3 prose-th:border-primary-700 prose-th:p-2 prose-td:border-primary-700 prose-td:p-2">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeRaw, rehypeSanitize]}
                    components={{
                        a: ({ node, children, ...properties }) => {
                            void node;
                            return (
                                <a {...properties} target="_blank" rel="noreferrer">
                                    {children}
                                </a>
                            );
                        },
                        img: ({ node, alt, src }) => {
                            void node;
                            return src ? (
                                <a href={src} target="_blank" rel="noreferrer">
                                    {alt || "External image"}
                                </a>
                            ) : (
                                <span>{alt || "Image"}</span>
                            );
                        },
                    }}
                >
                    {normalizedBody}
                </ReactMarkdown>
            </div>
        </div>
    );
}

/**
 * Renders the pull request card UI.
 * @returns Rendered the pull request card UI.
 */
export function PullRequestCard({
    pr,
    actions,
}: {
    pr: PullRequestSummary;
    actions: ReactNode;
}) {
    const checks = summarizeChecks(pr.statusCheckRollup);

    return (
        <Card variant="bordered" className="space-y-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                    <div className="text-xs text-primary-400">
                        #{pr.number} · {pr.headRefName} → {pr.baseRefName}
                    </div>
                    <CardTitle className="mt-1 text-base">
                        <a
                            href={pr.url}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-primary-200"
                        >
                            {pr.title}
                        </a>
                    </CardTitle>
                    <div className="mt-1 text-xs text-primary-500">
                        {authorLabel(pr)} · Updated {formatDate(pr.updatedAt)} ·{" "}
                        <span className="text-green-400">+{pr.additions ?? 0}</span>{" "}
                        <span className="text-red-400">-{pr.deletions ?? 0}</span> across{" "}
                        {pr.changedFiles ?? 0} files
                    </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                    <Badge variant={isMiraPullRequest(pr) ? "info" : "default"}>
                        {authorLabel(pr)}
                    </Badge>
                    {pr.stack ? (
                        <>
                            <Badge variant="info">Stack #{pr.stack.number}</Badge>
                            <Badge variant="default">
                                {pr.stack.position}/{pr.stack.size}
                            </Badge>
                        </>
                    ) : undefined}
                    <Badge variant={statusVariant(pr.mergeable)}>
                        {pr.mergeable || "mergeable unknown"}
                    </Badge>
                    <Badge variant={statusVariant(pr.mergeStateStatus)}>
                        {pr.mergeStateStatus || "state unknown"}
                    </Badge>
                    <Badge variant={checks.variant}>{checks.label}</Badge>
                    {pr.isDraft ? <Badge variant="warning">Draft</Badge> : undefined}
                    <Badge variant={reviewDecisionVariant(pr)}>
                        {reviewDecisionLabel(pr)}
                    </Badge>
                </div>
            </div>

            {pr.body ? <PullRequestDescription body={pr.body} /> : undefined}

            <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">{actions}</div>
        </Card>
    );
}

/**
 * Renders recent dashboard deployment jobs.
 * @returns Rendered recent dashboard deployment jobs.
 */
export function RecentDeploysCard({ deployments }: { deployments: DeploymentJob[] }) {
    return (
        <Card variant="bordered" className="h-fit space-y-3">
            <CardTitle className="text-base">Recent release jobs</CardTitle>
            {deployments.length === 0 ? (
                <p className="text-sm text-primary-400">
                    No dashboard release jobs recorded yet.
                </p>
            ) : (
                <div className="space-y-2">
                    {deployments.map((deployment) => (
                        <div
                            key={deployment.id}
                            className="rounded border border-primary-700 bg-primary-900/40 p-3"
                        >
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium text-primary-300">
                                        {deployment.commitUrl ? (
                                            <a
                                                href={deployment.commitUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="flex max-w-full min-w-0 items-baseline gap-1 text-primary-400 hover:text-primary-100"
                                            >
                                                <DeploymentCommitLabel
                                                    deployment={deployment}
                                                />
                                            </a>
                                        ) : (
                                            <span className="flex max-w-full min-w-0 items-baseline gap-1 text-primary-400">
                                                <DeploymentCommitLabel
                                                    deployment={deployment}
                                                />
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-xs text-primary-500">
                                        {formatDate(deployment.updatedAt)}
                                    </div>
                                </div>
                                <Badge
                                    variant={deploymentVariant(deployment.status)}
                                    className="shrink-0 whitespace-nowrap"
                                >
                                    {deploymentStatusLabel(deployment.status)}
                                </Badge>
                            </div>
                            {deployment.note ? (
                                <p className="mt-2 text-xs text-primary-400">
                                    {deployment.note}
                                </p>
                            ) : undefined}
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
}
