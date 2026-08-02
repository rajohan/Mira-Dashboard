import {
    CheckCircle,
    ExternalLink,
    GitBranch,
    GitMerge,
    Play,
    RefreshCw,
    Rocket,
    Square,
    XCircle,
} from "lucide-react";
import type { ReactNode } from "react";

import type { PullRequestPreviewStatus } from "../../../../../contracts/delivery/previews";
import type { PullRequestSummary } from "../../../../../contracts/delivery/pullRequests";
import { messageFromError } from "../../../lib/errorMessage";
import { Button } from "../../ui/Button";
import {
    DEFAULT_BASE,
    FULL_COMMIT_SHA_PATTERN,
    type PendingAction,
} from "./deliveryActionModel";
import {
    ACTIVE_PREVIEW_STATUSES,
    canConfiguredReviewerApproveReview,
    hasPullRequestChecksPassed,
    hasPullRequestConflicts,
    isGithubMergeBlocked,
    isPullRequestBranchBehind,
    isPullRequestReviewApproved,
} from "./deliveryModel";
import {
    type PullRequestStackCandidateEntry,
    pullRequestStackMergeGroup,
} from "./pullRequestStacks";

export interface PullRequestActionsContext {
    isActionPending: boolean;
    isPreviewStatusLoading: boolean;
    isProductionActionBlocked: boolean;
    isUpdateBranchPending: boolean;
    onRequestAction: (action: Exclude<PendingAction, undefined>) => void;
    onUpdateBranch: (number: number) => Promise<void>;
    previewStatus: PullRequestPreviewStatus | undefined;
    previewStatusError: unknown;
    productionActionBlockedMessage: string | undefined;
    pullRequests: PullRequestSummary[];
    stackCandidateEntries: Map<number, PullRequestStackCandidateEntry>;
    unstackedPullRequests: PullRequestSummary[];
}

interface PullRequestActionsProperties {
    context: PullRequestActionsContext;
    pr: PullRequestSummary;
}

interface PreviewActions {
    blockedMessage: string | undefined;
    controls: ReactNode;
}

function pullRequestPreviewActions(
    context: PullRequestActionsContext,
    pr: PullRequestSummary,
    scope: PullRequestSummary[]
): PreviewActions {
    if (pr.previewEligible !== true) {
        return { blockedMessage: undefined, controls: undefined };
    }

    const previewStatus = context.previewStatus;
    const isPreviewSlotActive =
        previewStatus !== undefined && ACTIVE_PREVIEW_STATUSES.has(previewStatus.status);
    const hasPullRequestPreviewSlot = previewStatus?.number === pr.number;
    const isPreviewSlotBusy = isPreviewSlotActive && !hasPullRequestPreviewSlot;
    const isPreviewTransitionInProgress =
        hasPullRequestPreviewSlot &&
        (previewStatus.status === "starting" || previewStatus.status === "stopping");
    const isPreviewCommitCurrent =
        previewStatus?.commitSha !== undefined &&
        previewStatus.commitSha === pr.headRefOid;
    const hasCurrentDevelopment =
        isPreviewSlotActive && hasPullRequestPreviewSlot && isPreviewCommitCurrent;
    const isRebuildDevelopment =
        isPreviewSlotActive && hasPullRequestPreviewSlot && !isPreviewCommitCurrent;
    const canStartDevelopment = !hasCurrentDevelopment;
    const arePreviewControlsAvailable = previewStatus?.controlsAvailable !== false;
    const isPreviewActionDisabled =
        context.isActionPending ||
        context.isPreviewStatusLoading ||
        Boolean(context.previewStatusError) ||
        !arePreviewControlsAvailable ||
        isPreviewSlotBusy ||
        isPreviewTransitionInProgress;
    let blockedMessage: string | undefined;
    if (context.isPreviewStatusLoading) {
        blockedMessage = "Loading PR dev status.";
    } else if (context.previewStatusError) {
        blockedMessage = `PR dev status is unavailable: ${messageFromError(
            context.previewStatusError,
            "Unknown status error"
        )}`;
    } else if (!arePreviewControlsAvailable) {
        blockedMessage =
            previewStatus?.message ??
            "PR dev controls are available only from the production Dashboard.";
    } else if (isPreviewSlotBusy) {
        blockedMessage = `PR #${previewStatus?.number} currently owns the dev slot. Stop it before starting another PR.`;
    } else if (isPreviewTransitionInProgress) {
        blockedMessage = "PR dev is currently changing state.";
    }

    const controls = (
        <>
            {hasPullRequestPreviewSlot &&
            previewStatus.status === "running" &&
            previewStatus.url ? (
                <a
                    href={previewStatus.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary-700 px-4 py-2 text-sm font-medium text-primary-100 transition-colors hover:bg-primary-600"
                >
                    <ExternalLink className="size-4" />
                    Open dev
                </a>
            ) : undefined}
            {canStartDevelopment ? (
                <Button
                    variant="secondary"
                    onClick={() =>
                        context.onRequestAction({
                            pr,
                            scope,
                            type: isRebuildDevelopment
                                ? "preview-rebuild"
                                : "preview-start",
                        })
                    }
                    disabled={isPreviewActionDisabled}
                    title={
                        isRebuildDevelopment
                            ? "Rebuild trusted PR dev at the latest PR commit"
                            : "Prod-like trusted dev with isolated Dashboard data and the live production Gateway"
                    }
                >
                    {isRebuildDevelopment ? (
                        <RefreshCw className="size-4" />
                    ) : (
                        <Play className="size-4" />
                    )}
                    {isRebuildDevelopment ? "Rebuild dev" : "Run in dev"}
                </Button>
            ) : undefined}
            {hasPullRequestPreviewSlot && previewStatus.status !== "stopped" ? (
                <Button
                    variant="secondary"
                    onClick={() =>
                        context.onRequestAction({
                            number: pr.number,
                            title: pr.title,
                            type: "preview-stop",
                        })
                    }
                    disabled={
                        context.isActionPending ||
                        !arePreviewControlsAvailable ||
                        isPreviewTransitionInProgress
                    }
                >
                    <Square className="size-4" />
                    Stop dev
                </Button>
            ) : undefined}
        </>
    );
    return { blockedMessage, controls };
}

/**
 * Renders preview, review, merge, update, and reject controls for one pull request.
 * @param properties Pull request and shared Delivery action context.
 * @returns Rendered pull request controls.
 */
export function PullRequestActions({ context, pr }: PullRequestActionsProperties) {
    const stackCandidateEntry = context.stackCandidateEntries.get(pr.number);
    const previewScope = stackCandidateEntry
        ? stackCandidateEntry.candidate.pullRequests.slice(
              0,
              stackCandidateEntry.position
          )
        : pullRequestStackMergeGroup(pr, context.pullRequests);
    const previewActions = pullRequestPreviewActions(context, pr, previewScope);
    if (stackCandidateEntry) {
        return (
            <>
                {previewActions.blockedMessage ? (
                    <p className="col-span-full w-full text-xs text-primary-400">
                        {previewActions.blockedMessage}
                    </p>
                ) : undefined}
                {previewActions.controls}
                <p className="col-span-full w-full text-xs text-primary-400">
                    This is layer {stackCandidateEntry.position}/
                    {stackCandidateEntry.candidate.pullRequests.length} in an unlinked
                    GitHub stack candidate. Create the stack above before reviewing,
                    merging, or rejecting it from Delivery.
                </p>
            </>
        );
    }
    if (
        !pr.stack &&
        pr.isCrossRepository !== true &&
        pr.headRefName !== DEFAULT_BASE &&
        context.unstackedPullRequests.some(
            (pullRequest) =>
                pullRequest.number !== pr.number &&
                pullRequest.baseRefName === pr.headRefName
        )
    ) {
        return (
            <p className="col-span-full w-full text-xs text-primary-400">
                This PR has an ambiguous or incomplete dependent chain. Restructure the
                branches into one linear candidate before managing it from Delivery.
            </p>
        );
    }
    if (pr.baseRefName !== DEFAULT_BASE && !pr.stack) {
        return (
            <p className="col-span-full w-full text-xs text-primary-400">
                This dependent PR targets{" "}
                <span className="font-mono text-primary-300">{pr.baseRefName}</span>. Link
                its complete linear chain as a GitHub stack before managing it from
                Delivery.
            </p>
        );
    }
    if (pr.stack && pr.stack.baseRefName !== DEFAULT_BASE) {
        return (
            <p className="col-span-full w-full text-xs text-primary-400">
                GitHub stack #{pr.stack.number} targets{" "}
                <span className="font-mono text-primary-300">{pr.stack.baseRefName}</span>
                . Only {DEFAULT_BASE}-rooted stacks can be managed from Delivery.
            </p>
        );
    }

    const mergeGroup = pullRequestStackMergeGroup(pr, context.pullRequests);
    const draftPullRequest = mergeGroup.find((pullRequest) => pullRequest.isDraft);
    const checksBlockedPullRequest = mergeGroup.find(
        (pullRequest) => !hasPullRequestChecksPassed(pullRequest.statusCheckRollup)
    );
    const reviewBlockedPullRequest = mergeGroup.find(
        (pullRequest) => !isPullRequestReviewApproved(pullRequest)
    );
    const githubBlockedPullRequest = mergeGroup.find((pullRequest) =>
        isGithubMergeBlocked(pullRequest)
    );
    const missingExpectedHeadPullRequest = mergeGroup.find(
        (pullRequest) =>
            typeof pullRequest.headRefOid !== "string" ||
            !FULL_COMMIT_SHA_PATTERN.test(pullRequest.headRefOid)
    );
    const canUpdateBranch =
        !pr.stack &&
        pr.baseRefName === DEFAULT_BASE &&
        isPullRequestBranchBehind(pr) &&
        !hasPullRequestConflicts(pr);
    const isMergeDisabled =
        context.isActionPending ||
        context.isProductionActionBlocked ||
        draftPullRequest !== undefined ||
        checksBlockedPullRequest !== undefined ||
        reviewBlockedPullRequest !== undefined ||
        githubBlockedPullRequest !== undefined ||
        missingExpectedHeadPullRequest !== undefined;
    let mergeDisabledReason: string | undefined;
    if (draftPullRequest) {
        mergeDisabledReason = `PR #${draftPullRequest.number} is a draft`;
    } else if (checksBlockedPullRequest) {
        mergeDisabledReason = `CI checks must pass on PR #${checksBlockedPullRequest.number} before merging`;
    } else if (reviewBlockedPullRequest) {
        mergeDisabledReason = `Approve PR #${reviewBlockedPullRequest.number} before merging`;
    } else if (githubBlockedPullRequest) {
        mergeDisabledReason = `GitHub reports PR #${githubBlockedPullRequest.number} is blocked from merging`;
    } else if (missingExpectedHeadPullRequest) {
        mergeDisabledReason = `Refresh Delivery before merging because the exact head for PR #${missingExpectedHeadPullRequest.number} is unavailable`;
    } else if (context.isProductionActionBlocked) {
        mergeDisabledReason = context.productionActionBlockedMessage;
    }
    const mergeDisabledReasonId = mergeDisabledReason
        ? `pr-${pr.number}-merge-disabled-reason`
        : undefined;

    return (
        <>
            {mergeDisabledReason ? (
                <p
                    id={mergeDisabledReasonId}
                    className="col-span-full w-full text-xs text-primary-400"
                >
                    {mergeDisabledReason}
                </p>
            ) : undefined}
            {previewActions.blockedMessage ? (
                <p className="col-span-full w-full text-xs text-primary-400">
                    {previewActions.blockedMessage}
                </p>
            ) : undefined}
            {canConfiguredReviewerApproveReview(pr) ? (
                <Button
                    variant="secondary"
                    onClick={() =>
                        context.onRequestAction({ type: "review-approve", pr })
                    }
                    disabled={context.isActionPending}
                >
                    <CheckCircle className="size-4" />
                    Approve PR
                </Button>
            ) : undefined}
            {canUpdateBranch ? (
                <Button
                    variant="secondary"
                    onClick={() => void context.onUpdateBranch(pr.number)}
                    disabled={context.isActionPending}
                >
                    <GitBranch className="size-4" />
                    {context.isUpdateBranchPending ? "Updating..." : "Update branch"}
                </Button>
            ) : undefined}
            {previewActions.controls}
            <Button
                variant="primary"
                onClick={() =>
                    context.onRequestAction({
                        pr,
                        scope: mergeGroup,
                        type: "merge-deploy",
                    })
                }
                disabled={isMergeDisabled}
                aria-describedby={mergeDisabledReasonId}
            >
                <Rocket className="size-4" />
                {pr.stack ? `Merge through #${pr.number} + Deploy` : "Merge + Deploy"}
            </Button>
            <Button
                variant="secondary"
                onClick={() =>
                    context.onRequestAction({ pr, scope: mergeGroup, type: "merge" })
                }
                disabled={isMergeDisabled}
                aria-describedby={mergeDisabledReasonId}
            >
                <GitMerge className="size-4" />
                {pr.stack ? `Merge stack through #${pr.number}` : "Merge only"}
            </Button>
            {pr.stack ? (
                <p className="col-span-full w-full text-xs text-primary-400">
                    Reject is unavailable because closing one member leaves a blocker in
                    the GitHub stack. Restructure or unstack it on GitHub first.
                </p>
            ) : (
                <Button
                    variant="danger"
                    onClick={() => context.onRequestAction({ type: "reject", pr })}
                    disabled={context.isActionPending}
                >
                    <XCircle className="size-4" />
                    Reject
                </Button>
            )}
        </>
    );
}
