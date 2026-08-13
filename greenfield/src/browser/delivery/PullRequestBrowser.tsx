import { GitMerge, GitPullRequest, Play, ShieldCheck, XCircle } from "lucide-react";
import type { ComponentProps } from "react";

import type {
    DeliveryPullRequest,
    DeliveryPullRequestActionCapability,
    DeliveryPullRequestGroup,
} from "../../contracts/delivery.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ExternalLink } from "../ui/ExternalLink.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { Text } from "../ui/Text.tsx";
import {
    deliveryActionReason,
    deliveryChecksLabels,
    deliveryPullRequestGroupLabels,
    deliveryReviewLabels,
} from "./deliveryPresentation.ts";

interface PullRequestActionState {
    readonly enabled: boolean;
    readonly reason?: string;
}

interface PullRequestBrowserProps {
    readonly actionState: (
        pullRequest: DeliveryPullRequest,
        action: DeliveryPullRequestActionCapability
    ) => PullRequestActionState;
    readonly busy: boolean;
    readonly groups: readonly DeliveryPullRequestGroup[];
    readonly onAction: (
        group: DeliveryPullRequestGroup,
        pullRequest: DeliveryPullRequest,
        action: DeliveryPullRequestActionCapability
    ) => void;
}

const actionLabels: Readonly<
    Record<DeliveryPullRequestActionCapability["action"], string>
> = {
    "approve-review": "Approve review",
    "create-stack": "Create stack",
    merge: "Merge",
    "merge-and-deploy": "Merge + deploy",
    "preview-start": "Run / rebuild preview",
    reject: "Reject",
    "update-branch": "Update branch",
};

function actionIcon(action: DeliveryPullRequestActionCapability["action"]) {
    switch (action) {
        case "approve-review": {
            return ShieldCheck;
        }
        case "preview-start": {
            return Play;
        }
        case "reject": {
            return XCircle;
        }
        default: {
            return GitMerge;
        }
    }
}

function SafeMarkdownLink({ children, href }: ComponentProps<"a">) {
    return typeof href === "string" && href.startsWith("https://") ? (
        <ExternalLink href={href}>{children}</ExternalLink>
    ) : (
        <span>{children}</span>
    );
}

function SafeMarkdownImage({ alt, src }: ComponentProps<"img">) {
    return typeof src === "string" && src.startsWith("https://") ? (
        <ExternalLink href={src}>Image: {alt || "pull request attachment"}</ExternalLink>
    ) : (
        <span>{alt || "Image omitted"}</span>
    );
}

function PullRequestCard({
    actionState,
    busy,
    onAction,
    pullRequest,
    group,
}: Omit<PullRequestBrowserProps, "groups"> & {
    readonly group: DeliveryPullRequestGroup;
    readonly pullRequest: DeliveryPullRequest;
}) {
    return (
        <Card aria-labelledby={`delivery-pr-${pullRequest.number}-heading`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <Heading id={`delivery-pr-${pullRequest.number}-heading`} level={3}>
                        <ExternalLink href={pullRequest.url}>
                            #{pullRequest.number} {pullRequest.title}
                        </ExternalLink>
                    </Heading>
                    <Text className="mt-1" tone="muted">
                        {pullRequest.headRef} → {pullRequest.baseRef} ·{" "}
                        {pullRequest.author}
                        {pullRequest.isCrossRepository ? " · fork" : ""}
                    </Text>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Badge
                        variant={
                            pullRequest.checksState === "passed" ? "success" : "warning"
                        }
                    >
                        {deliveryChecksLabels[pullRequest.checksState]}
                    </Badge>
                    <Badge
                        variant={
                            pullRequest.reviewState === "approved" ? "success" : "warning"
                        }
                    >
                        {deliveryReviewLabels[pullRequest.reviewState]}
                    </Badge>
                    {pullRequest.isDraft ? <Badge variant="warning">Draft</Badge> : null}
                    <Badge>{pullRequest.mergeState}</Badge>
                </div>
            </div>
            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div>
                    <dt className="text-primary-400">Exact head</dt>
                    <dd className="text-primary-100 font-mono text-xs wrap-anywhere">
                        {pullRequest.headSha}
                    </dd>
                </div>
                <div>
                    <dt className="text-primary-400">Changes</dt>
                    <dd className="text-primary-100">
                        +{pullRequest.additions.toLocaleString()} / -
                        {pullRequest.deletions.toLocaleString()} ·{" "}
                        {pullRequest.changedFiles.toLocaleString()} files
                    </dd>
                </div>
                <div>
                    <dt className="text-primary-400">Mergeability</dt>
                    <dd className="text-primary-100">{pullRequest.mergeability}</dd>
                </div>
                <div>
                    <dt className="text-primary-400">Updated</dt>
                    <dd className="text-primary-100">
                        {formatDashboardDateTime(pullRequest.updatedAtMs)}
                    </dd>
                </div>
            </dl>
            {pullRequest.body === undefined || pullRequest.body.trim() === "" ? null : (
                <div className="border-primary-700 mt-4 max-h-64 overflow-auto rounded-lg border p-4">
                    <Markdown
                        components={{ a: SafeMarkdownLink, img: SafeMarkdownImage }}
                        source={pullRequest.body}
                    />
                </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
                {pullRequest.actions.map((action) => {
                    const state = actionState(pullRequest, action);
                    const reason =
                        state.reason ?? deliveryActionReason(action.reason) ?? undefined;
                    const reasonId = `delivery-pr-${pullRequest.number}-${action.action}-reason`;
                    return (
                        <div key={action.action}>
                            <Button
                                aria-describedby={
                                    reason === undefined ? undefined : reasonId
                                }
                                disabled={!state.enabled || busy}
                                onClick={() => onAction(group, pullRequest, action)}
                                size="sm"
                                variant={
                                    action.action === "reject" ||
                                    action.action === "merge-and-deploy"
                                        ? "danger"
                                        : "secondary"
                                }
                            >
                                <Icon icon={actionIcon(action.action)} size="sm" />
                                {actionLabels[action.action]}
                            </Button>
                            {reason === undefined ? null : (
                                <Text
                                    className="mt-1 max-w-64"
                                    id={reasonId}
                                    size="sm"
                                    tone="muted"
                                >
                                    {reason}
                                </Text>
                            )}
                        </div>
                    );
                })}
            </div>
        </Card>
    );
}

/** @returns Server-grouped pull requests with no browser-side chain or policy inference. */
export function PullRequestBrowser({
    actionState,
    busy,
    groups,
    onAction,
}: PullRequestBrowserProps) {
    if (groups.length === 0) {
        return (
            <Card>
                <Text>No open pull requests.</Text>
            </Card>
        );
    }
    return (
        <div className="space-y-6">
            {groups.map((group) => (
                <section aria-labelledby={`delivery-group-${group.id}`} key={group.id}>
                    <div className="mb-3 flex items-center gap-2">
                        <Icon icon={GitPullRequest} tone="accent" />
                        <Heading id={`delivery-group-${group.id}`} level={3}>
                            {deliveryPullRequestGroupLabels[group.kind]}
                        </Heading>
                        {group.members.length > 1 ? (
                            <Badge>{group.members.length} layers · bottom → top</Badge>
                        ) : null}
                    </div>
                    <ol className="space-y-3">
                        {group.members.map((pullRequest) => (
                            <li key={pullRequest.number}>
                                <PullRequestCard
                                    actionState={actionState}
                                    busy={busy}
                                    group={group}
                                    onAction={onAction}
                                    pullRequest={pullRequest}
                                />
                            </li>
                        ))}
                    </ol>
                </section>
            ))}
        </div>
    );
}
