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
import { useState } from "react";

import type { PullRequestSummary } from "../../../../../contracts/delivery";
import {
    useApprovePullRequest,
    useApprovePullRequestReview,
    useCreatePullRequestStack,
    useDashboardDeployments,
    useDashboardReleaseStatus,
    useDeployDashboard,
    useProductionCheckout,
    usePullRequestPreview,
    usePullRequests,
    useRejectPullRequest,
    useRollbackDashboard,
    useStartPullRequestPreview,
    useStopPullRequestPreview,
    useUpdatePullRequestBranch,
} from "../../../hooks";
import { messageFromError } from "../../../lib/errorMessage";
import { Button } from "../../ui/Button";
import {
    actionResultMessage,
    ACTIVE_PREVIEW_STATUSES,
    canConfiguredReviewerApproveReview,
    checkoutMessage,
    DEFAULT_BASE,
    expectedStackHeadsForMerge,
    FULL_COMMIT_SHA_PATTERN,
    hasPullRequestChecksPassed,
    hasPullRequestConflicts,
    isGithubMergeBlocked,
    isMiraPullRequest,
    isPullRequestBranchBehind,
    isPullRequestReviewApproved,
    type PendingAction,
} from "./deliveryModel";
import {
    derivePullRequestStackCandidates,
    groupNativePullRequestStacks,
    indexPullRequestStackCandidates,
    pullRequestStackMergeGroup,
} from "./pullRequestStacks";

/**
 * Owns Delivery data, mutations, confirmations, and pull-request controls.
 * @returns Delivery page state, derived groups, and actions.
 */
export function useDeliveryController() {
    const {
        data: pullRequests = [],
        isLoading,
        error,
        refetch: refetchPullRequests,
    } = usePullRequests();
    const { data: deployments = [] } = useDashboardDeployments();
    const { data: productionCheckout, error: productionCheckoutError } =
        useProductionCheckout();
    const { data: releaseStatus, error: releaseStatusError } =
        useDashboardReleaseStatus();
    const {
        data: previewStatus,
        error: previewStatusError,
        isLoading: isPreviewStatusLoading,
    } = usePullRequestPreview();
    const approvePullRequest = useApprovePullRequest();
    const approvePullRequestReview = useApprovePullRequestReview();
    const createPullRequestStack = useCreatePullRequestStack();
    const rejectPullRequest = useRejectPullRequest();
    const updatePullRequestBranch = useUpdatePullRequestBranch();
    const deployDashboard = useDeployDashboard();
    const rollbackDashboard = useRollbackDashboard();
    const startPullRequestPreview = useStartPullRequestPreview();
    const stopPullRequestPreview = useStopPullRequestPreview();
    const [pendingAction, setPendingAction] = useState<PendingAction>();
    const [lastResult, setLastResult] = useState<string | undefined>();
    const [actionError, setActionError] = useState<string | undefined>();
    const isActionPending =
        approvePullRequest.isPending ||
        approvePullRequestReview.isPending ||
        createPullRequestStack.isPending ||
        rejectPullRequest.isPending ||
        updatePullRequestBranch.isPending ||
        deployDashboard.isPending ||
        rollbackDashboard.isPending ||
        startPullRequestPreview.isPending ||
        stopPullRequestPreview.isPending;
    const isProductionActionBlocked = !productionCheckout?.isSafeForDeploy;
    const productionActionBlockedMessage = isProductionActionBlocked
        ? checkoutMessage(productionCheckout, productionCheckoutError ?? undefined)
        : undefined;
    const deployBlockedReasonId = productionActionBlockedMessage
        ? "deploy-checkout-disabled-reason"
        : undefined;
    const previewStopTarget =
        previewStatus?.number === undefined
            ? undefined
            : {
                  number: previewStatus.number,
                  title: previewStatus.title,
              };
    const stackGroups = groupNativePullRequestStacks(pullRequests);
    const unstackedPullRequests = pullRequests.filter(
        (pullRequest) => pullRequest.stack === undefined
    );
    const stackCandidates = derivePullRequestStackCandidates(
        unstackedPullRequests,
        DEFAULT_BASE
    );
    const stackCandidateEntries = indexPullRequestStackCandidates(stackCandidates);
    const standalonePullRequests = unstackedPullRequests.filter(
        (pullRequest) => !stackCandidateEntries.has(pullRequest.number)
    );
    const hasMiraPullRequests = pullRequests.some((pr) => isMiraPullRequest(pr));
    const miraPullRequests = standalonePullRequests.filter((pr) => isMiraPullRequest(pr));
    const externalPullRequests = standalonePullRequests.filter(
        (pr) => !isMiraPullRequest(pr)
    );

    /** Performs confirm action. */
    async function confirmAction(action: Exclude<PendingAction, undefined>) {
        setActionError(undefined);
        try {
            switch (action.type) {
                case "merge": {
                    const expectedHeadSha = action.pr.headRefOid;
                    if (
                        typeof expectedHeadSha !== "string" ||
                        !FULL_COMMIT_SHA_PATTERN.test(expectedHeadSha)
                    ) {
                        throw new Error(
                            "Refresh Delivery before merging because the exact PR head is unavailable"
                        );
                    }
                    const expectedStackHeads = expectedStackHeadsForMerge(
                        action.pr,
                        action.scope
                    );
                    const result = await approvePullRequest.mutateAsync({
                        expectedHeadSha,
                        expectedStackHeads,
                        mergeStack: action.pr.stack !== undefined,
                        number: action.pr.number,
                        willDeploy: false,
                    });
                    setLastResult(
                        actionResultMessage(
                            result.message,
                            result.cleanup,
                            result.cleanups,
                            result.previewCleanup,
                            result.previewCleanups
                        )
                    );
                    break;
                }

                case "merge-deploy": {
                    const expectedHeadSha = action.pr.headRefOid;
                    if (
                        typeof expectedHeadSha !== "string" ||
                        !FULL_COMMIT_SHA_PATTERN.test(expectedHeadSha)
                    ) {
                        throw new Error(
                            "Refresh Delivery before merging because the exact PR head is unavailable"
                        );
                    }
                    const expectedStackHeads = expectedStackHeadsForMerge(
                        action.pr,
                        action.scope
                    );
                    const result = await approvePullRequest.mutateAsync({
                        expectedHeadSha,
                        expectedStackHeads,
                        mergeStack: action.pr.stack !== undefined,
                        number: action.pr.number,
                        willDeploy: true,
                    });
                    const message = result.deployError
                        ? `${result.message}: ${result.deployError}`
                        : result.deployment?.note || result.message;
                    setLastResult(
                        actionResultMessage(
                            message,
                            result.cleanup,
                            result.cleanups,
                            result.previewCleanup,
                            result.previewCleanups
                        )
                    );
                    break;
                }

                case "review-approve": {
                    const result = await approvePullRequestReview.mutateAsync({
                        number: action.pr.number,
                    });
                    setLastResult(result.message);
                    setPendingAction(undefined);
                    return;
                }

                case "preview-rebuild":
                case "preview-start": {
                    const isRebuild = action.type === "preview-rebuild";
                    const expectedHeadSha = action.pr.headRefOid;
                    if (
                        typeof expectedHeadSha !== "string" ||
                        !FULL_COMMIT_SHA_PATTERN.test(expectedHeadSha)
                    ) {
                        throw new Error(
                            "Refresh Delivery before starting dev because the exact PR head is unavailable"
                        );
                    }
                    const preview = await startPullRequestPreview.mutateAsync({
                        expectedHeadSha,
                        number: action.pr.number,
                    });
                    let resultMessage: string;
                    if (preview.status === "starting") {
                        const actionLabel = isRebuild ? "rebuild" : "start";
                        resultMessage = `PR #${action.pr.number} dev ${actionLabel} queued`;
                    } else if (preview.url) {
                        const actionLabel = isRebuild ? "rebuilt" : "is running";
                        resultMessage = `PR #${action.pr.number} dev ${actionLabel} at ${preview.url}`;
                    } else {
                        const actionLabel = isRebuild ? "rebuilt" : "started";
                        resultMessage = `PR #${action.pr.number} dev ${actionLabel}`;
                    }
                    setLastResult(resultMessage);
                    break;
                }

                case "preview-stop": {
                    await stopPullRequestPreview.mutateAsync({
                        number: action.number,
                    });
                    setLastResult(`PR #${action.number} dev stopped`);
                    break;
                }

                case "reject": {
                    const result = await rejectPullRequest.mutateAsync({
                        number: action.pr.number,
                    });
                    setLastResult(
                        actionResultMessage(
                            result.message,
                            result.cleanup,
                            result.previewCleanup
                        )
                    );
                    break;
                }

                case "stack-create": {
                    const result = await createPullRequestStack.mutateAsync({
                        pullRequests: action.candidate.pullRequests.map(
                            (pullRequest) => pullRequest.number
                        ),
                    });
                    setLastResult(result.message);
                    break;
                }

                case "deploy": {
                    const result = await deployDashboard.mutateAsync();
                    setLastResult(result?.deployment?.note ?? "Deploy scheduled");
                    break;
                }

                case "rollback": {
                    const result = await rollbackDashboard.mutateAsync({
                        targetCommit: action.release.commitSha,
                    });
                    setLastResult(
                        result?.deployment?.note ??
                            `Rollback to ${action.release.commitSha.slice(0, 8)} scheduled`
                    );
                    break;
                }
            }

            setPendingAction(undefined);
        } catch (error_) {
            setActionError(messageFromError(error_, "Action failed"));
        }
    }

    /**
     * Builds trusted PR dev status and controls for an eligible pull request.
     * @returns Built trusted PR dev status and controls for an eligible pull request.
     */
    function pullRequestPreviewActions(
        pr: PullRequestSummary,
        scope: PullRequestSummary[]
    ) {
        if (pr.previewEligible !== true) {
            return { blockedMessage: undefined, controls: undefined };
        }
        const isPreviewSlotActive =
            previewStatus !== undefined &&
            ACTIVE_PREVIEW_STATUSES.has(previewStatus.status);
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
            isActionPending ||
            isPreviewStatusLoading ||
            Boolean(previewStatusError) ||
            !arePreviewControlsAvailable ||
            isPreviewSlotBusy ||
            isPreviewTransitionInProgress;
        let blockedMessage: string | undefined;
        if (isPreviewStatusLoading) {
            blockedMessage = "Loading PR dev status.";
        } else if (previewStatusError) {
            blockedMessage = `PR dev status is unavailable: ${messageFromError(
                previewStatusError,
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
                            setPendingAction({
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
                            setPendingAction({
                                number: pr.number,
                                title: pr.title,
                                type: "preview-stop",
                            })
                        }
                        disabled={
                            isActionPending ||
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
     * Renders merge controls for a pull request.
     * @returns Rendered merge controls for a pull request.
     */
    function renderPullRequestActions(pr: PullRequestSummary) {
        const stackCandidateEntry = stackCandidateEntries.get(pr.number);
        const previewScope = stackCandidateEntry
            ? stackCandidateEntry.candidate.pullRequests.slice(
                  0,
                  stackCandidateEntry.position
              )
            : pullRequestStackMergeGroup(pr, pullRequests);
        const previewActions = pullRequestPreviewActions(pr, previewScope);
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
            unstackedPullRequests.some(
                (pullRequest) =>
                    pullRequest.number !== pr.number &&
                    pullRequest.baseRefName === pr.headRefName
            )
        ) {
            return (
                <p className="col-span-full w-full text-xs text-primary-400">
                    This PR has an ambiguous or incomplete dependent chain. Restructure
                    the branches into one linear candidate before managing it from
                    Delivery.
                </p>
            );
        }
        if (pr.baseRefName !== DEFAULT_BASE && !pr.stack) {
            return (
                <p className="col-span-full w-full text-xs text-primary-400">
                    This dependent PR targets{" "}
                    <span className="font-mono text-primary-300">{pr.baseRefName}</span>.
                    Link its complete linear chain as a GitHub stack before managing it
                    from Delivery.
                </p>
            );
        }
        if (pr.stack && pr.stack.baseRefName !== DEFAULT_BASE) {
            return (
                <p className="col-span-full w-full text-xs text-primary-400">
                    GitHub stack #{pr.stack.number} targets{" "}
                    <span className="font-mono text-primary-300">
                        {pr.stack.baseRefName}
                    </span>
                    . Only {DEFAULT_BASE}-rooted stacks can be managed from Delivery.
                </p>
            );
        }
        const mergeGroup = pullRequestStackMergeGroup(pr, pullRequests);
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
            isActionPending ||
            isProductionActionBlocked ||
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
        } else if (isProductionActionBlocked) {
            mergeDisabledReason = productionActionBlockedMessage;
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
                        onClick={() => setPendingAction({ type: "review-approve", pr })}
                        disabled={isActionPending}
                    >
                        <CheckCircle className="size-4" />
                        Approve PR
                    </Button>
                ) : undefined}
                {canUpdateBranch ? (
                    <Button
                        variant="secondary"
                        onClick={() => {
                            void (async () => {
                                try {
                                    const result =
                                        await updatePullRequestBranch.mutateAsync({
                                            number: pr.number,
                                        });
                                    setLastResult(result.message);
                                    setActionError(undefined);
                                } catch (error_) {
                                    setActionError(
                                        messageFromError(error_, "Action failed")
                                    );
                                }
                            })();
                        }}
                        disabled={isActionPending}
                    >
                        <GitBranch className="size-4" />
                        {updatePullRequestBranch.isPending
                            ? "Updating..."
                            : "Update branch"}
                    </Button>
                ) : undefined}
                {previewActions.controls}
                <Button
                    variant="primary"
                    onClick={() =>
                        setPendingAction({
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
                        setPendingAction({ pr, scope: mergeGroup, type: "merge" })
                    }
                    disabled={isMergeDisabled}
                    aria-describedby={mergeDisabledReasonId}
                >
                    <GitMerge className="size-4" />
                    {pr.stack ? `Merge stack through #${pr.number}` : "Merge only"}
                </Button>
                {pr.stack ? (
                    <p className="col-span-full w-full text-xs text-primary-400">
                        Reject is unavailable because closing one member leaves a blocker
                        in the GitHub stack. Restructure or unstack it on GitHub first.
                    </p>
                ) : (
                    <Button
                        variant="danger"
                        onClick={() => setPendingAction({ type: "reject", pr })}
                        disabled={isActionPending}
                    >
                        <XCircle className="size-4" />
                        Reject
                    </Button>
                )}
            </>
        );
    }

    return {
        actionError,
        confirmAction,
        deployments,
        deployBlockedReasonId,
        error,
        externalPullRequests,
        hasMiraPullRequests,
        isActionPending,
        isLoading,
        isProductionActionBlocked,
        lastResult,
        miraPullRequests,
        pendingAction,
        previewStatus,
        previewStatusError,
        previewStopTarget,
        productionActionBlockedMessage,
        productionCheckout,
        productionCheckoutError,
        pullRequests,
        refetchPullRequests,
        releaseStatus,
        releaseStatusError,
        renderPullRequestActions,
        setActionError,
        setLastResult,
        setPendingAction,
        stackCandidates,
        stackGroups,
    };
}
