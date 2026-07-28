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
import { type ReactNode, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { ProductionReleasesCard } from "../components/features/delivery/ProductionReleasesCard";
import { PullRequestDevelopmentCard } from "../components/features/delivery/PullRequestDevelopmentCard";
import { Alert } from "../components/ui/Alert";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { LoadingState } from "../components/ui/LoadingState";
import { PageState } from "../components/ui/PageState";
import { RefreshButton } from "../components/ui/RefreshButton";
import type {
    DashboardReleaseSummary,
    DeploymentJob,
    ProductionCheckoutStatus,
    PullRequestPreviewStatus,
    PullRequestSummary,
} from "../hooks";
import {
    useApprovePullRequest,
    useApprovePullRequestReview,
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
} from "../hooks";
import { formatDate } from "../utils/format";

/** Defines pending action. */
type PendingAction =
    | undefined
    | { type: "merge"; pr: PullRequestSummary }
    | { type: "merge-deploy"; pr: PullRequestSummary }
    | { type: "review-approve"; pr: PullRequestSummary }
    | { type: "preview-rebuild"; pr: PullRequestSummary }
    | { type: "preview-start"; pr: PullRequestSummary }
    | { number: number; title?: string; type: "preview-stop" }
    | { type: "reject"; pr: PullRequestSummary }
    | { release: DashboardReleaseSummary; type: "rollback" }
    | { type: "deploy" };
type PendingActionType = Exclude<PendingAction, undefined>["type"];
type UnhandledPendingActionType = Exclude<
    PendingActionType,
    | "deploy"
    | "merge"
    | "merge-deploy"
    | "preview-rebuild"
    | "preview-start"
    | "preview-stop"
    | "reject"
    | "review-approve"
    | "rollback"
>;

const PENDING_ACTION_SWITCH_IS_EXHAUSTIVE: UnhandledPendingActionType extends never
    ? true
    : never = true;
void PENDING_ACTION_SWITCH_IS_EXHAUSTIVE;

const MIRA_AUTHOR = "mira-2026";
const DEFAULT_REVIEWER_AUTHOR = "rajohan";
const DEPENDABOT_AUTHOR = "app/dependabot";
const DEFAULT_BASE = "main";
const ACTIVE_PREVIEW_STATUSES = new Set<PullRequestPreviewStatus["status"]>([
    "running",
    "starting",
    "stopping",
]);
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
    if (["mergeable", "clean", "isok", "success"].includes(normalized)) {
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
        case "CHANGES_REQUESTED": {
            return "Changes requested";
        }
        case "REVIEW_REQUIRED": {
            return "Review required";
        }
        default: {
            return value ? value.replaceAll("_", " ") : "Review pending";
        }
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

    const records = latestCheckRecords(checks);
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
    const records = latestCheckRecords(checks);

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

/** Keeps only the latest check entry for each GitHub check name/context. */
function latestCheckRecords(
    checks: unknown[] | undefined
): Array<Record<string, unknown>> {
    const latestByKey = new Map<string, Record<string, unknown>>();
    const checkValues = checks || [];
    for (const check of checkValues) {
        if (!check || typeof check !== "object" || Array.isArray(check)) continue;
        const record = check as Record<string, unknown>;
        const key = checkKey(record);
        const existing = latestByKey.get(key);
        if (!existing || checkTimestamp(record) >= checkTimestamp(existing)) {
            latestByKey.set(key, record);
        }
    }
    return latestByKey.values().toArray();
}

/** Returns a stable key for a GitHub status or check run. */
function checkKey(check: Record<string, unknown>): string {
    for (const key of ["name", "context", "workflowName"]) {
        const value = check[key];
        if (typeof value === "string" && value.trim()) {
            return `${key}:${value.trim()}`;
        }
    }
    return JSON.stringify(check);
}

/** Returns a comparable timestamp for a GitHub status or check run. */
function checkTimestamp(check: Record<string, unknown>): number {
    for (const key of ["completedAt", "startedAt", "createdAt"]) {
        const value = check[key];
        if (typeof value === "string") {
            const timestamp = Date.parse(value);
            if (Number.isFinite(timestamp)) return timestamp;
        }
    }
    return 0;
}

/** Normalizes a GitHub check status or conclusion. */
function normalizedCheckValue(value: unknown): string {
    return typeof value === "string" ? value.toLowerCase() : "";
}

/** Performs deployment variant. */
function deploymentVariant(status: DeploymentJob["status"]) {
    if (status === "isOk") return "success" as const;
    if (status === "failed") return "error" as const;
    if (status === "verifying") return "warning" as const;
    return "info" as const;
}

/** Performs deployment status label. */
function deploymentStatusLabel(status: DeploymentJob["status"]) {
    return status === "isOk" ? "ok" : status;
}

/** Formats pull request count copy. */
function pullRequestCountLabel(count: number): string {
    return `${count} ${count === 1 ? "PR" : "PRs"}`;
}

/** Renders pull request section title and count badge. */
function SectionHeader({
    title,
    count,
    badgeVariant,
}: {
    title: string;
    count: number;
    badgeVariant: Parameters<typeof Badge>[0]["variant"];
}) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">{title}</CardTitle>
            <Badge variant={badgeVariant}>{pullRequestCountLabel(count)}</Badge>
        </div>
    );
}

/** Renders the deployment commit title and commit reference. */
function deploymentCommitLabel(deployment: DeploymentJob): ReactNode {
    const commit = deployment.commit?.slice(0, 8) || deployment.id;
    if (!deployment.commitTitle) return commit;

    return (
        <>
            <span className="line-clamp-2 min-w-0 flex-1 wrap-break-word">
                {deployment.commitTitle}
            </span>
            <span className="shrink-0 whitespace-nowrap text-primary-500">
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
    error: Error | undefined
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
function actionLabel(action: Exclude<PendingAction, undefined>) {
    switch (action.type) {
        case "merge": {
            return "Merge PR";
        }
        case "merge-deploy": {
            return "Merge + Deploy";
        }
        case "review-approve": {
            return "Approve PR";
        }
        case "preview-start": {
            return "Run PR in dev";
        }
        case "preview-rebuild": {
            return "Rebuild PR dev";
        }
        case "preview-stop": {
            return "Stop PR dev";
        }
        case "reject": {
            return "Reject PR";
        }
        case "deploy": {
            return `Deploy latest ${DEFAULT_BASE}`;
        }
        case "rollback": {
            return `Roll back to ${action.release.commitSha.slice(0, 8)}`;
        }
    }
}

/** Performs action message. */
function actionMessage(action: Exclude<PendingAction, undefined>) {
    switch (action.type) {
        case "merge": {
            return `Merge PR #${action.pr.number}: ${action.pr.title}?\n\nThis will squash-merge the PR and delete the remote branch. It will not deploy.`;
        }
        case "merge-deploy": {
            return `Merge and deploy PR #${action.pr.number}: ${action.pr.title}?\n\nThis will squash-merge, sync ${DEFAULT_BASE}, publish an immutable release, atomically activate it, restart web and worker, and verify commit-bound readiness. A failed release is rolled back automatically.`;
        }
        case "review-approve": {
            return `Approve PR #${action.pr.number}: ${action.pr.title}?\n\nThis approves the PR on GitHub. It does not merge or deploy.`;
        }
        case "preview-start": {
            return `Run PR #${action.pr.number} in dev: ${action.pr.title}?\n\nThis runs the fixed PR commit over Tailscale HTTPS without source watchers, using an isolated Dashboard database, a writable workspace snapshot, and an isolated scheduler/worker without host or backup jobs. It connects to the live production Gateway so chat and session changes can affect production data. The dev environment stops automatically after four hours.`;
        }
        case "preview-rebuild": {
            return `Rebuild PR dev for #${action.pr.number}: ${action.pr.title}?\n\nThis replaces the running dev environment with the latest PR head while keeping the same isolation and live production Gateway connection. The rebuilt environment stops automatically after four hours.`;
        }
        case "preview-stop": {
            const title = action.title ? `: ${action.title}` : "";
            return `Stop PR dev for #${action.number}${title}?\n\nThe shared checkout and isolated PR state are kept while the PR remains open for a faster later restart.`;
        }
        case "reject": {
            return `Reject PR #${action.pr.number}: ${action.pr.title}?\n\nThis closes the PR with a dashboard rejection comment. It does not delete the branch.`;
        }
        case "deploy": {
            return `Deploy latest ${DEFAULT_BASE}?\n\nThis will sync ${DEFAULT_BASE}, publish an immutable release, atomically activate it, restart web and worker, and verify commit-bound readiness. A failed release is rolled back automatically.`;
        }
        case "rollback": {
            return `Roll back to ${action.release.commitSha.slice(0, 8)}: ${action.release.commitTitle}?\n\nThis atomically swaps the active and previous releases, restarts web and worker, and verifies commit-bound readiness. If the rollback target fails, the current release is restored automatically.`;
        }
    }
}

/** Combines an action result with any best-effort cleanup outcomes. */
function actionResultMessage(
    message: string,
    ...cleanupResults: Array<{ message: string } | undefined>
) {
    return [
        message,
        ...cleanupResults
            .filter((cleanup) => cleanup !== undefined)
            .map((cleanup) => cleanup.message),
    ].join("\n");
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

/** Renders recent dashboard deployment jobs. */
function RecentDeploysCard({ deployments }: { deployments: DeploymentJob[] }) {
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
                                                {deploymentCommitLabel(deployment)}
                                            </a>
                                        ) : (
                                            <span className="flex max-w-full min-w-0 items-baseline gap-1 text-primary-400">
                                                {deploymentCommitLabel(deployment)}
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

/** Renders Dashboard delivery operations. */
export function Delivery() {
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
    const rejectPullRequest = useRejectPullRequest();
    const updatePullRequestBranch = useUpdatePullRequestBranch();
    const deployDashboard = useDeployDashboard();
    const rollbackDashboard = useRollbackDashboard();
    const startPullRequestPreview = useStartPullRequestPreview();
    const stopPullRequestPreview = useStopPullRequestPreview();
    const [pendingAction, setPendingAction] = useState<PendingAction>(undefined);
    const [lastResult, setLastResult] = useState<string | undefined>(undefined);
    const [actionError, setActionError] = useState<string | undefined>(undefined);
    const isActionPending =
        approvePullRequest.isPending ||
        approvePullRequestReview.isPending ||
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
    const miraPullRequests = pullRequests.filter((pr) => isMiraPullRequest(pr));
    const externalPullRequests = pullRequests.filter((pr) => !isMiraPullRequest(pr));

    /** Performs confirm action. */
    async function confirmAction(action: Exclude<PendingAction, undefined>) {
        setActionError(undefined);
        try {
            switch (action.type) {
                case "merge": {
                    const result = await approvePullRequest.mutateAsync({
                        number: action.pr.number,
                        willDeploy: false,
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

                case "merge-deploy": {
                    const result = await approvePullRequest.mutateAsync({
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
                            result.previewCleanup
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
                    const preview = await startPullRequestPreview.mutateAsync({
                        number: action.pr.number,
                    });
                    setLastResult(
                        preview.status === "starting"
                            ? `PR #${action.pr.number} dev ${isRebuild ? "rebuild" : "start"} queued`
                            : preview.url
                              ? `PR #${action.pr.number} dev ${isRebuild ? "rebuilt" : "is running"} at ${preview.url}`
                              : `PR #${action.pr.number} dev ${isRebuild ? "rebuilt" : "started"}`
                    );
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
            setActionError(error_ instanceof Error ? error_.message : "Action failed");
        }
    }

    /** Builds trusted PR dev status and controls for an eligible pull request. */
    function pullRequestPreviewActions(pr: PullRequestSummary) {
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
            blockedMessage = `PR dev status is unavailable: ${previewStatusError.message}`;
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

    /** Renders merge controls for a pull request. */
    function renderPullRequestActions(pr: PullRequestSummary) {
        const previewActions = pullRequestPreviewActions(pr);
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
                    mergeDisabledReason = productionActionBlockedMessage;
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
                        onClick={async () => {
                            try {
                                const result = await updatePullRequestBranch.mutateAsync({
                                    number: pr.number,
                                });
                                setLastResult(result.message);
                                setActionError(undefined);
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
                        <GitBranch className="size-4" />
                        {updatePullRequestBranch.isPending
                            ? "Updating..."
                            : "Update branch"}
                    </Button>
                ) : undefined}
                {previewActions.controls}
                <Button
                    variant="primary"
                    onClick={() => setPendingAction({ type: "merge-deploy", pr })}
                    disabled={mergeDisabled}
                    aria-describedby={mergeDisabledReasonId}
                >
                    <Rocket className="size-4" />
                    Merge + Deploy
                </Button>
                <Button
                    variant="secondary"
                    onClick={() => setPendingAction({ type: "merge", pr })}
                    disabled={mergeDisabled}
                    aria-describedby={mergeDisabledReasonId}
                >
                    <GitMerge className="size-4" />
                    Merge only
                </Button>
                <Button
                    variant="danger"
                    onClick={() => setPendingAction({ type: "reject", pr })}
                    disabled={isActionPending}
                >
                    <XCircle className="size-4" />
                    Reject
                </Button>
            </>
        );
    }

    return (
        <>
            <div className="space-y-4 p-3 sm:p-4 lg:p-6">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                        <h2 className="flex items-center gap-2 text-xl font-semibold text-primary-100">
                            <Rocket className="size-5" />
                            Delivery
                        </h2>
                        <p className="mt-1 max-w-2xl text-sm text-primary-400">
                            Review and run trusted pull requests, manage production
                            releases, and deploy the latest safe main checkout.
                        </p>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:justify-items-end">
                        <Button
                            variant="primary"
                            onClick={() => setPendingAction({ type: "deploy" })}
                            disabled={isActionPending || isProductionActionBlocked}
                            aria-describedby={deployBlockedReasonId}
                        >
                            <Rocket className="size-4" />
                            {`Deploy latest ${DEFAULT_BASE}`}
                        </Button>
                        {productionActionBlockedMessage ? (
                            <p
                                id={deployBlockedReasonId}
                                className="max-w-sm text-xs text-primary-400 lg:text-right"
                            >
                                {productionActionBlockedMessage}
                            </p>
                        ) : undefined}
                    </div>
                </div>

                {lastResult ? (
                    <Alert
                        variant="success"
                        dismissLabel="Dismiss action result"
                        onDismiss={() => setLastResult(undefined)}
                    >
                        <p className="text-sm whitespace-pre-line text-green-300">
                            {lastResult}
                        </p>
                    </Alert>
                ) : undefined}

                {actionError ? (
                    <Alert
                        variant="error"
                        dismissLabel="Dismiss action error"
                        onDismiss={() => setActionError(undefined)}
                    >
                        <p className="text-sm text-red-300">{actionError}</p>
                    </Alert>
                ) : undefined}

                <PullRequestDevelopmentCard
                    error={previewStatusError ?? undefined}
                    isStopPending={isActionPending}
                    onStop={
                        previewStopTarget === undefined
                            ? undefined
                            : () => {
                                  setPendingAction({
                                      ...previewStopTarget,
                                      type: "preview-stop",
                                  });
                              }
                    }
                    preview={previewStatus}
                />

                <ProductionReleasesCard
                    baseBranch={DEFAULT_BASE}
                    checkout={productionCheckout}
                    error={releaseStatusError ?? undefined}
                    isActionPending={isActionPending}
                    onRollback={(release) => {
                        setPendingAction({ release, type: "rollback" });
                    }}
                    release={releaseStatus}
                />

                <Card variant="bordered" className="space-y-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                            <CardTitle className="text-base">
                                Production checkout
                            </CardTitle>
                            <p className="mt-1 text-sm text-primary-400">
                                {checkoutMessage(
                                    productionCheckout,
                                    productionCheckoutError ?? undefined
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
                            ) : undefined}
                            {productionCheckout ? (
                                <Badge
                                    variant={
                                        productionCheckout.isClean ? "success" : "error"
                                    }
                                >
                                    {productionCheckout.isClean ? "Clean" : "Dirty"}
                                </Badge>
                            ) : undefined}
                        </div>
                    </div>
                    {productionCheckout ? (
                        <div className="grid gap-1 text-xs text-primary-500 lg:grid-cols-2">
                            <div className="truncate">
                                Production: {productionCheckout.root}
                            </div>
                            <div className="truncate">
                                Worktrees: {productionCheckout.worktreeRoot}
                            </div>
                            <div>HEAD: {productionCheckout.head}</div>
                            <div>Upstream: {productionCheckout.upstream || "none"}</div>
                        </div>
                    ) : undefined}
                </Card>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_360px]">
                    <PageState
                        isLoading={isLoading}
                        loading={
                            <LoadingState message="Loading pull requests..." size="lg" />
                        }
                        error={error?.message ?? undefined}
                        errorView={
                            <Card
                                variant="bordered"
                                className="flex min-h-48 flex-col items-center justify-center gap-4"
                            >
                                <p className="text-red-400">{error?.message}</p>
                                <RefreshButton
                                    onClick={() => void refetchPullRequests()}
                                    label="Retry"
                                />
                            </Card>
                        }
                    >
                        <div className="space-y-4">
                            {pullRequests.length === 0 ? (
                                <Card variant="bordered">
                                    <CardTitle>No open PRs waiting</CardTitle>
                                    <p className="mt-2 text-sm text-primary-400">
                                        New dashboard and dependency PRs will appear here
                                        for review.
                                    </p>
                                </Card>
                            ) : undefined}

                            {pullRequests.length > 0 && miraPullRequests.length === 0 ? (
                                <Card variant="bordered">
                                    <CardTitle>No Mira-authored PRs waiting</CardTitle>
                                    <p className="mt-2 text-sm text-primary-400">
                                        Autopilot changes will appear here when Mira opens
                                        a dashboard PR for Raymond to review.
                                    </p>
                                </Card>
                            ) : undefined}

                            {miraPullRequests.length > 0 ? (
                                <section
                                    className="space-y-3"
                                    aria-label="Mira-authored PRs"
                                >
                                    <div>
                                        <SectionHeader
                                            title="Mira-authored PRs"
                                            count={miraPullRequests.length}
                                            badgeVariant="info"
                                        />
                                        <p className="mt-1 text-sm text-primary-400">
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
                            ) : undefined}

                            {externalPullRequests.length > 0 ? (
                                <section
                                    className="space-y-3"
                                    aria-label="Dependency and external PRs"
                                >
                                    <div>
                                        <SectionHeader
                                            title="Dependency / external PRs"
                                            count={externalPullRequests.length}
                                            badgeVariant="default"
                                        />
                                        <p className="mt-1 text-sm text-primary-400">
                                            These can be merged after the same review, CI,
                                            and checkout gates as Mira-authored PRs.
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
                            ) : undefined}
                        </div>
                    </PageState>
                    <div className={pullRequests.length > 0 ? "xl:pt-15" : undefined}>
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
                        danger={
                            pendingAction.type === "reject" ||
                            pendingAction.type === "rollback"
                        }
                        onCancel={() => {
                            if (isActionPending) {
                                return;
                            }

                            setPendingAction(undefined);
                            setActionError(undefined);
                        }}
                        onConfirm={() => {
                            void confirmAction(pendingAction);
                        }}
                    />
                )}
            </div>
        </>
    );
}
