import { useState } from "react";

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
} from "../../../hooks/useDelivery";
import { messageFromError } from "../../../lib/errorMessage";
import {
    actionResultMessage,
    DEFAULT_BASE,
    expectedStackHeadsForMerge,
    FULL_COMMIT_SHA_PATTERN,
    type PendingAction,
} from "./deliveryActionModel";
import { checkoutMessage, isMiraPullRequest } from "./deliveryModel";
import {
    derivePullRequestStackCandidates,
    groupNativePullRequestStacks,
    indexPullRequestStackCandidates,
} from "./pullRequestStacks";

/**
 * Owns Delivery data, mutations, confirmations, and derived action context.
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

    /** Updates one pull request branch and presents the mutation result. */
    async function updateBranch(number: number): Promise<void> {
        try {
            const result = await updatePullRequestBranch.mutateAsync({ number });
            setLastResult(result.message);
            setActionError(undefined);
        } catch (error_) {
            setActionError(messageFromError(error_, "Action failed"));
        }
    }

    const pullRequestActionContext = {
        isActionPending,
        isPreviewStatusLoading,
        isProductionActionBlocked,
        isUpdateBranchPending: updatePullRequestBranch.isPending,
        onRequestAction: (action: Exclude<PendingAction, undefined>) => {
            setPendingAction(action);
        },
        onUpdateBranch: updateBranch,
        previewStatus,
        previewStatusError,
        productionActionBlockedMessage,
        pullRequests,
        stackCandidateEntries,
        unstackedPullRequests,
    };

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
        pullRequestActionContext,
        pullRequests,
        refetchPullRequests,
        releaseStatus,
        releaseStatusError,
        setActionError,
        setLastResult,
        setPendingAction,
        stackCandidates,
        stackGroups,
    };
}
