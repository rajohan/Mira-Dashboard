import {
    CheckCircle,
    GitBranch,
    GitMerge,
    GitPullRequest,
    Rocket,
    XCircle,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { LoadingState } from "../components/ui/LoadingState";
import { PageState } from "../components/ui/PageState";
import { RefreshButton } from "../components/ui/RefreshButton";
import type {
    DeploymentJob,
    ProductionCheckoutStatus,
    PullRequestSummary,
    WorktreeCleanupResult,
} from "../hooks";
import {
    useApprovePullRequest,
    useApprovePullRequestReview,
    useDeployDashboard,
    useProductionCheckout,
    usePullRequestDeployments,
    usePullRequests,
    useRejectPullRequest,
    useUpdatePullRequestBranch,
} from "../hooks";
import { formatDate } from "../utils/format";

/** Defines pending action. */
type PendingAction =
    | null
    | { type: "merge"; pr: PullRequestSummary }
    | { type: "merge-deploy"; pr: PullRequestSummary }
    | { type: "review-approve"; pr: PullRequestSummary }
    | { type: "reject"; pr: PullRequestSummary }
    | { type: "deploy" };
type PendingActionType = Exclude<PendingAction, null>["type"];
type UnhandledPendingActionType = Exclude<
    PendingActionType,
    "deploy" | "merge" | "merge-deploy" | "reject" | "review-approve"
>;

const PENDING_ACTION_SWITCH_IS_EXHAUSTIVE: UnhandledPendingActionType extends never
    ? true
    : never = true;
void PENDING_ACTION_SWITCH_IS_EXHAUSTIVE;

const MIRA_AUTHOR = "mira-2026";
const DEFAULT_REVIEWER_AUTHOR = "rajohan";
const DEPENDABOT_AUTHOR = "app/dependabot";
const DEFAULT_BASE = "main";
const PASSING_CHECK_VALUES = new Set(["success", "successful", "neutral", "skipped"]);
const FAILED_CHECK_VALUES = new Set([
    "error",
    "failed",
    "failure",
    "startup_failure",
    "timed_out",
]);
const RUNNING_CHECK_VALUES = new Set([
    "expected",
    "in_progress",
    "pending",
    "queued",
    "requested",
    "waiting",
]);
const ATTENTION_CHECK_VALUES = new Set([
    "action_required",
    "cancelled",
    "canceled",
    "stale",
]);
const SKIPPED_CHECK_VALUES = new Set(["neutral", "skipped"]);

/** Returns whether mira pull request. */
function isMiraPullRequest(pr: PullRequestSummary): boolean {
    return pr.author?.login === MIRA_AUTHOR;
}

/** Performs author label. */
function authorLabel(pr: PullRequestSummary): string {
    if (pr.author?.login === DEPENDABOT_AUTHOR) return "Dependabot";
    return pr.author?.login || "Unknown author";
}

/** Performs status variant. */
function statusVariant(value: string | undefined) {
    const normalized = (value || "").toLowerCase();
    if (["mergeable", "clean", "isOk", "success"].includes(normalized)) {
        return "success" as const;
    }

    if (
        ["conflicting", "dirty", "blocked", "failure", "failed", "error"].includes(
            normalized
        )
    ) {
        return "error" as const;
    }

    if (
        ["unknown", "unstable", "pending", "queued", "in_progress", "behind"].includes(
            normalized
        )
    ) {
        return "warning" as const;
    }

    return "default" as const;
}

/** Performs review decision variant. */
function reviewDecisionVariant(pr: PullRequestSummary) {
    if (isPullRequestReviewApproved(pr)) return "success" as const;
    const value = pr.reviewDecision;
    const normalized = (value || "").toUpperCase();
    if (normalized === "CHANGES_REQUESTED") return "error" as const;
    if (normalized === "REVIEW_REQUIRED") return "warning" as const;
    return "default" as const;
}

/** Performs review decision label. */
function reviewDecisionLabel(pr: PullRequestSummary) {
    if (isPullRequestReviewApproved(pr)) return "Review approved";
    const value = pr.reviewDecision;
    const normalized = (value || "").toUpperCase();
    switch (normalized) {
        case "CHANGES_REQUESTED":
            return "Changes requested";
        case "REVIEW_REQUIRED":
            return "Review required";
        default:
            return value ? value.replaceAll("_", " ") : "Review pending";
    }
}

/** Returns whether the pull request has a dashboard-accepted approval. */
function isPullRequestReviewApproved(pr: PullRequestSummary): boolean {
    return (
        pr.reviewDecision?.toUpperCase() === "APPROVED" || pr.reviewerApproved === true
    );
}

/** Performs summarize checks. */
function summarizeChecks(checks: unknown[] | undefined) {
    if (!checks?.length) {
        return { label: "No CI checks", variant: "default" as const };
    }

    const records = checks.filter(
        (check): check is Record<string, unknown> =>
            Boolean(check) && typeof check === "object" && !Array.isArray(check)
    );
    const values = records.map((check) => {
        const conclusion = normalizedCheckValue(check.conclusion);
        return conclusion || normalizedCheckValue(check.status ?? check.state);
    });
    const visibleValues = values.filter(Boolean);

    if (visibleValues.length === 0) {
        return { label: "No CI checks", variant: "default" as const };
    }

    if (visibleValues.some((value) => FAILED_CHECK_VALUES.has(value))) {
        return { label: "Checks failed", variant: "error" as const };
    }

    if (visibleValues.some((value) => RUNNING_CHECK_VALUES.has(value))) {
        return { label: "Checks running", variant: "warning" as const };
    }

    if (visibleValues.some((value) => ATTENTION_CHECK_VALUES.has(value))) {
        return { label: "Checks need attention", variant: "warning" as const };
    }

    if (visibleValues.some((value) => SKIPPED_CHECK_VALUES.has(value))) {
        return { label: "Checks skipped", variant: "warning" as const };
    }

    if (hasPullRequestChecksPassed(checks)) {
        return { label: "Checks passed", variant: "success" as const };
    }

    return { label: "Checks pending", variant: "warning" as const };
}

/** Returns whether pull request checks are conclusively passing. */
function hasPullRequestChecksPassed(checks: unknown[] | undefined): boolean {
    const records = (checks || []).filter(
        (check): check is Record<string, unknown> =>
            Boolean(check) && typeof check === "object" && !Array.isArray(check)
    );

    if (records.length === 0) {
        return false;
    }

    return records.every((check) => {
        const conclusion = normalizedCheckValue(check.conclusion);
        if (conclusion) {
            return PASSING_CHECK_VALUES.has(conclusion);
        }

        const status = normalizedCheckValue(check.status ?? check.state);
        return PASSING_CHECK_VALUES.has(status);
    });
}

/** Normalizes a GitHub check status or conclusion. */
function normalizedCheckValue(value: unknown): string {
    return typeof value === "string" ? value.toLowerCase() : "";
}

/** Performs deployment variant. */
function deploymentVariant(status: DeploymentJob["status"]) {
    if (status === "isOk") return "success" as const;
    if (status === "failed") return "error" as const;
    if (status === "restart-scheduled") return "warning" as const;
    return "info" as const;
}

/** Renders the deployment commit title and commit reference. */
function deploymentCommitLabel(deployment: DeploymentJob): ReactNode {
    const commit = deployment.commit || deployment.id;
    if (!deployment.commitTitle) return commit;

    return (
        <>
            <span className="line-clamp-2 min-w-0 flex-1 break-words">
                {deployment.commitTitle}
            </span>
            <span className="text-primary-500 shrink-0 whitespace-nowrap">
                ({commit})
            </span>
        </>
    );
}

/** Performs checkout variant. */
function checkoutVariant(checkout: ProductionCheckoutStatus | undefined) {
    if (!checkout) return "default" as const;
    if (!checkout.isProductionRoot || !checkout.isClean) return "error" as const;
    if (!checkout.isSafeForDeploy) return "warning" as const;
    return "success" as const;
}

/** Performs checkout label. */
function checkoutLabel(checkout: ProductionCheckoutStatus | undefined) {
    if (!checkout) return "Checking production checkout";
    if (!checkout.isProductionRoot) return "Wrong root";
    if (!checkout.isClean) return "Dirty checkout";
    if (checkout.branch !== checkout.expectedBranch) {
        return `Off ${checkout.expectedBranch}`;
    }
    return "Ready to deploy";
}

/** Performs checkout message. */
function checkoutMessage(
    checkout: ProductionCheckoutStatus | undefined,
    error: Error | null
) {
    if (error) return error.message;
    if (!checkout) return "Loading checkout status…";
    if (!checkout.isProductionRoot) {
        return `Deploy is blocked because the backend is not operating on ${checkout.expectedRoot}.`;
    }
    if (!checkout.isClean) {
        return "Deploy and merge are blocked until local changes in the production checkout are resolved.";
    }
    if (checkout.branch !== checkout.expectedBranch) {
        return `Deploy and merge are blocked until the production checkout is switched from ${checkout.branch} to ${checkout.expectedBranch}.`;
    }
    return "Deploys build only from the clean production checkout. PR verification should happen in separate git worktrees.";
}

/** Returns whether GitHub currently reports a pull request merge blocker. */
function isGithubMergeBlocked(pr: PullRequestSummary): boolean {
    return (
        ["BEHIND", "BLOCKED"].includes(pr.mergeStateStatus?.toUpperCase() || "") ||
        ["CONFLICTING", "DIRTY"].includes(pr.mergeable?.toUpperCase() || "")
    );
}

/** Returns whether GitHub reports the pull request branch is behind the base branch. */
function isPullRequestBranchBehind(pr: PullRequestSummary): boolean {
    return pr.mergeStateStatus?.toUpperCase() === "BEHIND";
}

/** Returns whether GitHub reports merge conflicts for a pull request. */
function hasPullRequestConflicts(pr: PullRequestSummary): boolean {
    const mergeable = pr.mergeable?.toUpperCase();
    return mergeable === "CONFLICTING" || mergeable === "DIRTY";
}

/** Returns whether the configured reviewer can approve the pull request review. */
function canConfiguredReviewerApproveReview(pr: PullRequestSummary): boolean {
    if (typeof pr.canReviewerApprove === "boolean") {
        return pr.canReviewerApprove;
    }
    return (
        pr.author?.login !== DEFAULT_REVIEWER_AUTHOR &&
        !pr.isDraft &&
        !isPullRequestReviewApproved(pr)
    );
}

/** Performs action label. */
function actionLabel(action: Exclude<PendingAction, null>) {
    switch (action.type) {
        case "merge":
            return "Merge PR";
        case "merge-deploy":
            return "Merge + Deploy";
        case "review-approve":
            return "Approve PR";
        case "reject":
            return "Reject PR";
        case "deploy":
            return `Deploy latest ${DEFAULT_BASE}`;
    }
}

/** Performs action message. */
function actionMessage(action: Exclude<PendingAction, null>) {
    switch (action.type) {
        case "merge":
            return `Merge PR #${action.pr.number}: ${action.pr.title}?\n\nThis will squash-merge the PR and delete the remote branch. It will not deploy.`;
        case "merge-deploy":
            return `Merge and deploy PR #${action.pr.number}: ${action.pr.title}?\n\nThis will squash-merge, sync the production checkout to ${DEFAULT_BASE}, build frontend/backend from there, schedule a service restart, and run a health check.`;
        case "review-approve":
            return `Approve PR #${action.pr.number}: ${action.pr.title}?\n\nThis approves the PR on GitHub. It does not merge or deploy.`;
        case "reject":
            return `Reject PR #${action.pr.number}: ${action.pr.title}?\n\nThis closes the PR with a dashboard rejection comment. It does not delete the branch.`;
        case "deploy":
            return `Deploy latest ${DEFAULT_BASE}?\n\nThis will sync the production checkout to ${DEFAULT_BASE}, build frontend/backend from there, schedule a mira-dashboard.service restart, and run a health check.`;
    }
}

/** Performs action result message. */
function actionResultMessage(message: string, cleanup?: WorktreeCleanupResult) {
    if (!cleanup) return message;
    return `${message}\n${cleanup.message}`;
}

/** Normalizes pull request body. */
function normalizePullRequestBody(body: string): string {
    if (!body.includes("\n") && body.includes(String.raw`\n`)) {
        return body.replaceAll(String.raw`\n`, "\n");
    }

    return body;
}

/** Renders the pull request description UI. */
function PullRequestDescription({ body }: { body: string }) {
    const normalizedBody = normalizePullRequestBody(body);

    return (
        <div className="border-primary-700 bg-primary-900/50 max-h-80 overflow-auto rounded border p-3 sm:p-4">
            <div className="prose prose-invert prose-p:my-2 prose-headings:my-3 prose-ol:my-2 prose-ul:my-2 prose-li:my-0.5 prose-table:my-3 prose-th:border-primary-700 prose-td:border-primary-700 prose-th:p-2 prose-td:p-2 prose-code:before:content-none prose-code:after:content-none max-w-none text-sm break-words">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeRaw, rehypeSanitize]}
                    components={{
                        a: ({ node, ...properties }) => {
                            void node;
                            return <a {...properties} target="_blank" rel="noreferrer" />;
                        },
                    }}
                >
                    {normalizedBody}
                </ReactMarkdown>
            </div>
        </div>
    );
}

/** Renders the pull request card UI. */
function PullRequestCard({
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
                    <div className="text-primary-400 text-xs">
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
                    <div className="text-primary-500 mt-1 text-xs">
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
                    <Badge variant={statusVariant(pr.mergeable)}>
                        {pr.mergeable || "mergeable unknown"}
                    </Badge>
                    <Badge variant={statusVariant(pr.mergeStateStatus)}>
                        {pr.mergeStateStatus || "state unknown"}
                    </Badge>
                    <Badge variant={checks.variant}>{checks.label}</Badge>
                    {pr.isDraft ? <Badge variant="warning">Draft</Badge> : null}
                    <Badge variant={reviewDecisionVariant(pr)}>
                        {reviewDecisionLabel(pr)}
                    </Badge>
                </div>
            </div>

            {pr.body ? <PullRequestDescription body={pr.body} /> : null}

            <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">{actions}</div>
        </Card>
    );
}

/** Renders recent dashboard deployment jobs. */
function RecentDeploysCard({ deployments }: { deployments: DeploymentJob[] }) {
    return (
        <Card variant="bordered" className="h-fit space-y-3">
            <CardTitle className="text-base">Recent deploys</CardTitle>
            {deployments.length === 0 ? (
                <p className="text-primary-400 text-sm">
                    No dashboard deploy jobs recorded yet.
                </p>
            ) : (
                <div className="space-y-2">
                    {deployments.map((deployment) => (
                        <div
                            key={deployment.id}
                            className="border-primary-700 bg-primary-900/40 rounded border p-3"
                        >
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="text-primary-300 text-sm font-medium">
                                        {deployment.commitUrl ? (
                                            <a
                                                href={deployment.commitUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="text-primary-400 hover:text-primary-100 flex max-w-full min-w-0 items-baseline gap-1"
                                            >
                                                {deploymentCommitLabel(deployment)}
                                            </a>
                                        ) : (
                                            <span className="text-primary-400 flex max-w-full min-w-0 items-baseline gap-1">
                                                {deploymentCommitLabel(deployment)}
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-primary-500 text-xs">
                                        {formatDate(deployment.updatedAt)}
                                    </div>
                                </div>
                                <Badge
                                    variant={deploymentVariant(deployment.status)}
                                    className="shrink-0 whitespace-nowrap"
                                >
                                    {deployment.status}
                                </Badge>
                            </div>
                            {deployment.note ? (
                                <p className="text-primary-400 mt-2 text-xs">
                                    {deployment.note}
                                </p>
                            ) : null}
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
}

/** Renders the pull requests UI. */
export function PullRequests() {
    const {
        data: pullRequests = [],
        isLoading,
        error,
        refetch: refetchPullRequests,
    } = usePullRequests();
    const { data: deployments = [] } = usePullRequestDeployments();
    const { data: productionCheckout, error: productionCheckoutError } =
        useProductionCheckout();
    const approvePullRequest = useApprovePullRequest();
    const approvePullRequestReview = useApprovePullRequestReview();
    const rejectPullRequest = useRejectPullRequest();
    const updatePullRequestBranch = useUpdatePullRequestBranch();
    const deployDashboard = useDeployDashboard();
    const [pendingAction, setPendingAction] = useState<PendingAction>(null);
    const [lastResult, setLastResult] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const isActionPending =
        approvePullRequest.isPending ||
        approvePullRequestReview.isPending ||
        rejectPullRequest.isPending ||
        updatePullRequestBranch.isPending ||
        deployDashboard.isPending;
    const isProductionActionBlocked = !productionCheckout?.isSafeForDeploy;
    const miraPullRequests = pullRequests.filter(isMiraPullRequest);
    const externalPullRequests = pullRequests.filter((pr) => !isMiraPullRequest(pr));

    /** Performs confirm action. */
    async function confirmAction(action: Exclude<PendingAction, null>) {
        setActionError(null);
        try {
            switch (action.type) {
                case "merge": {
                    const result = await approvePullRequest.mutateAsync({
                        number: action.pr.number,
                        willDeploy: false,
                    });
                    setLastResult(actionResultMessage(result.message, result.cleanup));
                    break;
                }

                case "merge-deploy": {
                    const result = await approvePullRequest.mutateAsync({
                        number: action.pr.number,
                        willDeploy: true,
                    });
                    const message = result.deployError
                        ? `${result.message}: ${result.deployError}`
                        : result.deployment?.note || result.message;
                    setLastResult(actionResultMessage(message, result.cleanup));
                    break;
                }

                case "review-approve": {
                    const result = await approvePullRequestReview.mutateAsync({
                        number: action.pr.number,
                    });
                    setLastResult(result.message);
                    setPendingAction(null);
                    return;
                }

                case "reject": {
                    const result = await rejectPullRequest.mutateAsync({
                        number: action.pr.number,
                    });
                    setLastResult(actionResultMessage(result.message, result.cleanup));
                    break;
                }

                case "deploy": {
                    const result = await deployDashboard.mutateAsync();
                    setLastResult(result?.deployment?.note ?? "Deploy scheduled");
                    break;
                }
            }

            setPendingAction(null);
        } catch (error_) {
            setActionError(error_ instanceof Error ? error_.message : "Action failed");
        }
    }

    /** Renders merge controls for a pull request. */
    function renderPullRequestActions(pr: PullRequestSummary) {
        const isChecksPassed = hasPullRequestChecksPassed(pr.statusCheckRollup);
        const isReviewApproved = isPullRequestReviewApproved(pr);
        const isMergeBlocked = isGithubMergeBlocked(pr);
        const canUpdateBranch =
            pr.baseRefName === DEFAULT_BASE &&
            isPullRequestBranchBehind(pr) &&
            !hasPullRequestConflicts(pr);
        const mergeDisabled =
            isActionPending ||
            isProductionActionBlocked ||
            pr.isDraft ||
            !isChecksPassed ||
            !isReviewApproved ||
            isMergeBlocked;
        let mergeDisabledReason: string | undefined;
        if (pr.isDraft) {
            mergeDisabledReason =
                "Draft pull requests cannot be merged from the dashboard";
        } else if (isChecksPassed) {
            if (isReviewApproved) {
                if (isMergeBlocked) {
                    mergeDisabledReason =
                        "GitHub reports this pull request is blocked from merging";
                } else if (isProductionActionBlocked) {
                    mergeDisabledReason = checkoutMessage(
                        productionCheckout,
                        productionCheckoutError
                    );
                }
            } else {
                mergeDisabledReason = "Approve the PR before merging from the dashboard";
            }
        } else {
            mergeDisabledReason = "CI checks must pass before merging from the dashboard";
        }
        const mergeDisabledReasonId = mergeDisabledReason
            ? `pr-${pr.number}-merge-disabled-reason`
            : undefined;

        return (
            <>
                {mergeDisabledReason ? (
                    <p
                        id={mergeDisabledReasonId}
                        className="text-primary-400 text-xs sm:basis-full"
                    >
                        {mergeDisabledReason}
                    </p>
                ) : null}
                {canConfiguredReviewerApproveReview(pr) ? (
                    <Button
                        variant="secondary"
                        onClick={() => setPendingAction({ type: "review-approve", pr })}
                        disabled={isActionPending}
                    >
                        <CheckCircle className="h-4 w-4" />
                        Approve PR
                    </Button>
                ) : null}
                {canUpdateBranch ? (
                    <Button
                        variant="secondary"
                        onClick={async () => {
                            try {
                                const result = await updatePullRequestBranch.mutateAsync({
                                    number: pr.number,
                                });
                                setLastResult(result.message);
                                setActionError(null);
                            } catch (error_) {
                                setActionError(
                                    error_ instanceof Error
                                        ? error_.message
                                        : "Action failed"
                                );
                            }
                        }}
                        disabled={isActionPending}
                    >
                        <GitBranch className="h-4 w-4" />
                        {updatePullRequestBranch.isPending
                            ? "Updating..."
                            : "Update branch"}
                    </Button>
                ) : null}
                <Button
                    variant="primary"
                    onClick={() => setPendingAction({ type: "merge-deploy", pr })}
                    disabled={mergeDisabled}
                    aria-describedby={mergeDisabledReasonId}
                >
                    <Rocket className="h-4 w-4" />
                    Merge + Deploy
                </Button>
                <Button
                    variant="secondary"
                    onClick={() => setPendingAction({ type: "merge", pr })}
                    disabled={mergeDisabled}
                    aria-describedby={mergeDisabledReasonId}
                >
                    <GitMerge className="h-4 w-4" />
                    Merge only
                </Button>
                <Button
                    variant="danger"
                    onClick={() => setPendingAction({ type: "reject", pr })}
                    disabled={isActionPending}
                >
                    <XCircle className="h-4 w-4" />
                    Reject
                </Button>
            </>
        );
    }

    return (
        <PageState
            isLoading={isLoading}
            loading={<LoadingState message="Loading pull requests..." size="lg" />}
            error={error?.message ?? null}
            errorView={
                <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-3 sm:p-6">
                    <p className="text-red-400">{error?.message}</p>
                    <RefreshButton
                        onClick={() => void refetchPullRequests()}
                        label="Retry"
                    />
                </div>
            }
        >
            <div className="space-y-4 p-3 sm:p-4 lg:p-6">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                        <h2 className="text-primary-100 flex items-center gap-2 text-xl font-semibold">
                            <GitPullRequest className="h-5 w-5" />
                            Pull requests
                        </h2>
                        <p className="text-primary-400 mt-1 max-w-2xl text-sm">
                            Review open rajohan/Mira-Dashboard pull requests. Dashboard
                            merge actions are enabled after review approval, passing CI,
                            and a safe production checkout.
                        </p>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:flex">
                        <Button
                            variant="primary"
                            onClick={() => setPendingAction({ type: "deploy" })}
                            disabled={isActionPending || isProductionActionBlocked}
                        >
                            <Rocket className="h-4 w-4" />
                            {`Deploy latest ${DEFAULT_BASE}`}
                        </Button>
                    </div>
                </div>

                {lastResult ? (
                    <Card
                        variant="bordered"
                        className="border-green-500/30 bg-green-500/10"
                    >
                        <p className="text-sm whitespace-pre-line text-green-300">
                            {lastResult}
                        </p>
                    </Card>
                ) : null}

                {actionError ? (
                    <Card variant="bordered" className="border-red-500/30 bg-red-500/10">
                        <p className="text-sm text-red-300">{actionError}</p>
                    </Card>
                ) : null}

                <Card variant="bordered" className="space-y-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                            <CardTitle className="text-base">
                                Production checkout
                            </CardTitle>
                            <p className="text-primary-400 mt-1 text-sm">
                                {checkoutMessage(
                                    productionCheckout,
                                    productionCheckoutError
                                )}
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            <Badge variant={checkoutVariant(productionCheckout)}>
                                {checkoutLabel(productionCheckout)}
                            </Badge>
                            {productionCheckout ? (
                                <Badge
                                    variant={
                                        productionCheckout.branch ===
                                        productionCheckout.expectedBranch
                                            ? "success"
                                            : "warning"
                                    }
                                >
                                    {productionCheckout.branch}
                                </Badge>
                            ) : null}
                            {productionCheckout ? (
                                <Badge
                                    variant={
                                        productionCheckout.isClean ? "success" : "error"
                                    }
                                >
                                    {productionCheckout.isClean ? "Clean" : "Dirty"}
                                </Badge>
                            ) : null}
                        </div>
                    </div>
                    {productionCheckout ? (
                        <div className="text-primary-500 grid gap-1 text-xs lg:grid-cols-2">
                            <div className="truncate">
                                Production: {productionCheckout.root}
                            </div>
                            <div className="truncate">
                                Worktrees: {productionCheckout.worktreeRoot}
                            </div>
                            <div>HEAD: {productionCheckout.head}</div>
                            <div>Upstream: {productionCheckout.upstream || "none"}</div>
                        </div>
                    ) : null}
                </Card>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_360px]">
                    <div className="space-y-4">
                        {pullRequests.length === 0 ? (
                            <Card variant="bordered">
                                <CardTitle>No open PRs waiting</CardTitle>
                                <p className="text-primary-400 mt-2 text-sm">
                                    New dashboard and dependency PRs will appear here for
                                    review.
                                </p>
                            </Card>
                        ) : null}

                        {miraPullRequests.length > 0 ? (
                            <section className="space-y-3" aria-label="Mira-authored PRs">
                                <div>
                                    <CardTitle className="text-base">
                                        Mira-authored PRs
                                    </CardTitle>
                                    <p className="text-primary-400 mt-1 text-sm">
                                        These can be merged, rejected, or merged and
                                        deployed from the dashboard.
                                    </p>
                                </div>
                                <div className="space-y-3">
                                    {miraPullRequests.map((pr) => (
                                        <PullRequestCard
                                            key={pr.number}
                                            pr={pr}
                                            actions={renderPullRequestActions(pr)}
                                        />
                                    ))}
                                </div>
                            </section>
                        ) : null}

                        {externalPullRequests.length > 0 ? (
                            <section
                                className="space-y-3"
                                aria-label="Dependency and external PRs"
                            >
                                <div>
                                    <CardTitle className="text-base">
                                        Dependency / external PRs
                                    </CardTitle>
                                    <p className="text-primary-400 mt-1 text-sm">
                                        These can be merged after the same review, CI, and
                                        checkout gates as Mira-authored PRs.
                                    </p>
                                </div>
                                <div className="space-y-3">
                                    {externalPullRequests.map((pr) => (
                                        <PullRequestCard
                                            key={pr.number}
                                            pr={pr}
                                            actions={renderPullRequestActions(pr)}
                                        />
                                    ))}
                                </div>
                            </section>
                        ) : null}
                    </div>
                    <div className={pullRequests.length > 0 ? "xl:pt-[60px]" : undefined}>
                        <RecentDeploysCard deployments={deployments} />
                    </div>
                </div>

                {pendingAction && (
                    <ConfirmModal
                        isOpen
                        title={actionLabel(pendingAction)}
                        message={actionMessage(pendingAction)}
                        confirmLabel={actionLabel(pendingAction)}
                        confirmLoadingLabel="Working"
                        loading={isActionPending}
                        danger={pendingAction.type === "reject"}
                        onCancel={() => {
                            if (isActionPending) {
                                return;
                            }

                            setPendingAction(null);
                            setActionError(null);
                        }}
                        onConfirm={() => {
                            void confirmAction(pendingAction);
                        }}
                    />
                )}
            </div>
        </PageState>
    );
}
