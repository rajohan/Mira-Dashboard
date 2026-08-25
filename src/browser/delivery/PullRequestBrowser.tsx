import {
    GitMerge,
    GitPullRequest,
    Play,
    RefreshCw,
    ShieldCheck,
    XCircle,
} from "lucide-react";
import type { ComponentProps } from "react";

import type {
    DeliveryPullRequest,
    DeliveryPullRequestActionCapability,
    DeliveryPullRequestGroup,
    DeliveryPreview,
} from "../../contracts/delivery.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
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

type BadgeVariant = "danger" | "default" | "success" | "warning";

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
    readonly preview?: DeliveryPreview;
}

const actionLabels: Readonly<
    Record<
        Exclude<DeliveryPullRequestActionCapability["action"], "preview-start">,
        string
    >
> = {
    "approve-review": "Approve PR",
    "create-stack": "Create stack",
    merge: "Merge only",
    reject: "Reject",
    "update-branch": "Update branch",
};

const actionOrder: Readonly<
    Record<DeliveryPullRequestActionCapability["action"], number>
> = {
    "preview-start": 0,
    "approve-review": 1,
    "update-branch": 2,
    merge: 3,
    reject: 4,
    "create-stack": 5,
};

const groupOrder: Readonly<Record<DeliveryPullRequestGroup["kind"], number>> = {
    "standalone-mira": 0,
    "native-stack": 1,
    "candidate-stack": 2,
    "read-only-chain": 3,
    "standalone-external": 4,
};

function pullRequestOwnsActivePreview(
    pullRequest: DeliveryPullRequest,
    preview: DeliveryPreview | undefined
): boolean {
    return (
        preview?.number === pullRequest.number &&
        preview.status !== "failed" &&
        preview.status !== "stopped" &&
        preview.status !== "view-only"
    );
}

function actionIsVisible(
    group: DeliveryPullRequestGroup,
    pullRequest: DeliveryPullRequest,
    action: DeliveryPullRequestActionCapability
): boolean {
    if (action.action === "approve-review") {
        return (
            pullRequest.reviewState !== "approved" && action.reason !== "already-approved"
        );
    }
    if (action.action === "update-branch" && action.reason === "not-behind") return false;
    if (action.action === "reject" && action.reason === "head-guard-unavailable") {
        return false;
    }
    if (
        group.kind === "native-stack" &&
        (action.action === "update-branch" || action.action === "reject")
    )
        return false;
    return true;
}

function actionLabel(
    group: DeliveryPullRequestGroup,
    pullRequest: DeliveryPullRequest,
    action: DeliveryPullRequestActionCapability,
    preview: DeliveryPreview | undefined
): string {
    if (action.action === "merge" && group.kind === "native-stack") {
        return `Merge stack through #${pullRequest.number}`;
    }
    if (action.action !== "preview-start") return actionLabels[action.action];
    return pullRequestOwnsActivePreview(pullRequest, preview)
        ? "Rebuild preview"
        : "Run preview";
}

function actionIcon(
    pullRequest: DeliveryPullRequest,
    action: DeliveryPullRequestActionCapability["action"],
    preview: DeliveryPreview | undefined
) {
    switch (action) {
        case "approve-review": {
            return ShieldCheck;
        }
        case "preview-start": {
            return pullRequestOwnsActivePreview(pullRequest, preview) ? RefreshCw : Play;
        }
        case "reject": {
            return XCircle;
        }
        default: {
            return GitMerge;
        }
    }
}

function actionVariant(
    action: DeliveryPullRequestActionCapability["action"]
): "danger" | "primary" | "secondary" {
    if (action === "reject") return "danger";
    return "secondary";
}

function checksVariant(state: DeliveryPullRequest["checksState"]): BadgeVariant {
    if (state === "passed") return "success";
    if (state === "failed") return "danger";
    return state === "none" || state === "skipped" ? "default" : "warning";
}

function reviewVariant(state: DeliveryPullRequest["reviewState"]): BadgeVariant {
    if (state === "approved") return "success";
    if (state === "changes-requested") return "danger";
    return state === "unknown" ? "default" : "warning";
}

function mergeVariant(state: string): BadgeVariant {
    const normalized = state.toUpperCase();
    if (normalized === "CLEAN" || normalized === "MERGEABLE") return "success";
    if (
        normalized.includes("BLOCK") ||
        normalized.includes("CONFLICT") ||
        normalized === "DIRTY"
    ) {
        return "danger";
    }
    return normalized === "UNKNOWN" ? "default" : "warning";
}

function groupDescription(kind: DeliveryPullRequestGroup["kind"]): string {
    switch (kind) {
        case "native-stack": {
            return "Choose a layer to merge it and every open pull request below it as one group.";
        }
        case "standalone-mira": {
            return "Standalone Dashboard changes use the standard review and merge flow.";
        }
        case "standalone-external": {
            return "Dependency and external changes use the same review and merge gates.";
        }
        case "candidate-stack": {
            return "Linear pull request chains that can be linked as a GitHub stack.";
        }
        case "read-only-chain": {
            return "Dependent pull requests remain read-only until their chain is resolved.";
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
    preview,
    group,
}: Omit<PullRequestBrowserProps, "groups"> & {
    readonly group: DeliveryPullRequestGroup;
    readonly pullRequest: DeliveryPullRequest;
}) {
    const actions = pullRequest.actions
        .filter((action) => actionIsVisible(group, pullRequest, action))
        .toSorted((left, right) => actionOrder[left.action] - actionOrder[right.action])
        .map((action) => {
            const state = actionState(pullRequest, action);
            return {
                action,
                reason:
                    state.reason ??
                    deliveryActionReason(action.action, action.reason) ??
                    undefined,
                state,
            };
        });
    const disabledReasons = [
        ...new Set(
            actions.flatMap(({ reason, state }) =>
                !state.enabled && reason !== undefined ? [reason] : []
            )
        ),
    ];
    return (
        <Card
            aria-labelledby={`delivery-pr-${pullRequest.number}-heading`}
            className="p-3 sm:p-4"
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <Text size="sm" tone="muted">
                        #{pullRequest.number} · {pullRequest.headRef} →{" "}
                        {pullRequest.baseRef}
                    </Text>
                    <Heading
                        className="mt-1"
                        id={`delivery-pr-${pullRequest.number}-heading`}
                        level={3}
                    >
                        <ExternalLink href={pullRequest.url}>
                            {pullRequest.title}
                        </ExternalLink>
                    </Heading>
                    <Text className="mt-1" size="sm" tone="muted">
                        {pullRequest.author}
                        {pullRequest.isCrossRepository ? " · fork" : ""} · Updated{" "}
                        {formatDashboardDateTime(pullRequest.updatedAtMs)} ·{" "}
                        <span className="text-emerald-400">
                            +{pullRequest.additions.toLocaleString()}
                        </span>{" "}
                        <span className="text-red-400">
                            -{pullRequest.deletions.toLocaleString()}
                        </span>{" "}
                        across {pullRequest.changedFiles.toLocaleString()} files
                    </Text>
                </div>
                <div className="flex flex-wrap gap-1.5">
                    <Badge variant={checksVariant(pullRequest.checksState)}>
                        {deliveryChecksLabels[pullRequest.checksState]}
                    </Badge>
                    <Badge variant={reviewVariant(pullRequest.reviewState)}>
                        {deliveryReviewLabels[pullRequest.reviewState]}
                    </Badge>
                    {pullRequest.isDraft ? <Badge variant="warning">Draft</Badge> : null}
                    <Badge variant={mergeVariant(pullRequest.mergeState)}>
                        {pullRequest.mergeState}
                    </Badge>
                </div>
            </div>
            {pullRequest.body === undefined || pullRequest.body.trim() === "" ? null : (
                <div className="border-primary-700 bg-primary-900/40 mt-3 max-h-64 overflow-auto rounded-lg border p-3">
                    <Markdown
                        components={{ a: SafeMarkdownLink, img: SafeMarkdownImage }}
                        source={pullRequest.body}
                    />
                </div>
            )}
            <div className="mt-3 grid grid-cols-1 gap-1.5 sm:flex sm:flex-wrap">
                {actions.map(({ action, reason, state }) => {
                    const reasonId =
                        reason === undefined
                            ? undefined
                            : `delivery-pr-${pullRequest.number}-reason-${disabledReasons.indexOf(reason)}`;
                    return (
                        <div className="w-full sm:w-auto" key={action.action}>
                            <Button
                                aria-describedby={state.enabled ? undefined : reasonId}
                                disabled={!state.enabled || busy}
                                className="w-full sm:w-auto"
                                onClick={() => onAction(group, pullRequest, action)}
                                size="sm"
                                title={reason}
                                variant={actionVariant(action.action)}
                            >
                                <Icon
                                    icon={actionIcon(pullRequest, action.action, preview)}
                                    size="sm"
                                />
                                {actionLabel(group, pullRequest, action, preview)}
                            </Button>
                        </div>
                    );
                })}
            </div>
            {disabledReasons.length === 0 ? null : (
                <div className="mt-2 space-y-1">
                    {disabledReasons.map((reason, index) => (
                        <div
                            id={`delivery-pr-${pullRequest.number}-reason-${index}`}
                            key={reason}
                        >
                            <Alert
                                className="py-2"
                                focusOnError={false}
                                message={reason}
                                variant="warning"
                            />
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
}

/** @returns Server-grouped pull requests with no browser-side chain or policy inference. */
export function PullRequestBrowser({
    actionState,
    busy,
    groups,
    onAction,
    preview,
}: PullRequestBrowserProps) {
    if (groups.length === 0) {
        return (
            <Card>
                <Text>No open pull requests.</Text>
            </Card>
        );
    }
    return (
        <div className="space-y-4">
            {groups
                .toSorted((left, right) => groupOrder[left.kind] - groupOrder[right.kind])
                .map((group) => {
                    const memberList = (
                        <ol className="space-y-2">
                            {group.members.map((pullRequest) => (
                                <li key={pullRequest.number}>
                                    <PullRequestCard
                                        actionState={actionState}
                                        busy={busy}
                                        group={group}
                                        onAction={onAction}
                                        preview={preview}
                                        pullRequest={pullRequest}
                                    />
                                </li>
                            ))}
                        </ol>
                    );
                    return (
                        <section
                            aria-labelledby={`delivery-group-${group.id}`}
                            className="space-y-3"
                            key={group.id}
                        >
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <Icon icon={GitPullRequest} tone="accent" />
                                    <Heading id={`delivery-group-${group.id}`} level={3}>
                                        {deliveryPullRequestGroupLabels[group.kind]}
                                    </Heading>
                                    <Badge variant="info">{group.members.length}</Badge>
                                </div>
                                <Text className="mt-1" size="sm" tone="muted">
                                    {groupDescription(group.kind)}
                                </Text>
                            </div>
                            {group.kind === "native-stack" ? (
                                <div className="border-primary-700 bg-primary-900/20 space-y-3 rounded-lg border p-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div>
                                            <Heading level={3}>
                                                {group.stackNumber === undefined
                                                    ? "Stack"
                                                    : `Stack #${group.stackNumber}`}
                                            </Heading>
                                            <Text size="sm" tone="muted">
                                                {group.members.length} open layers · base{" "}
                                                {group.members[0]?.baseRef ?? "unknown"}
                                            </Text>
                                        </div>
                                        <Badge>Bottom → top</Badge>
                                    </div>
                                    {memberList}
                                </div>
                            ) : (
                                memberList
                            )}
                        </section>
                    );
                })}
        </div>
    );
}
