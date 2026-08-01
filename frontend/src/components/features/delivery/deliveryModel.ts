import type {
    DashboardReleaseSummary,
    DeploymentJob,
    ProductionCheckoutStatus,
    PullRequestExpectedHead,
    PullRequestPreviewStatus,
    PullRequestSummary,
} from "../../../../../contracts/delivery";
import { messageFromError } from "../../../lib/errorMessage";
import type { PullRequestStackCandidate } from "./pullRequestStacks";

/** Defines pending action. */
export type PendingAction =
    | undefined
    | { type: "merge"; pr: PullRequestSummary; scope: PullRequestSummary[] }
    | { type: "merge-deploy"; pr: PullRequestSummary; scope: PullRequestSummary[] }
    | { type: "review-approve"; pr: PullRequestSummary }
    | {
          type: "preview-rebuild";
          pr: PullRequestSummary;
          scope: PullRequestSummary[];
      }
    | { type: "preview-start"; pr: PullRequestSummary; scope: PullRequestSummary[] }
    | { number: number; title?: string; type: "preview-stop" }
    | { type: "reject"; pr: PullRequestSummary }
    | { release: DashboardReleaseSummary; type: "rollback" }
    | { candidate: PullRequestStackCandidate; type: "stack-create" }
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
    | "stack-create"
>;

const PENDING_ACTION_SWITCH_IS_EXHAUSTIVE: UnhandledPendingActionType extends never
    ? true
    : never = true;
void PENDING_ACTION_SWITCH_IS_EXHAUSTIVE;

const MIRA_AUTHOR = "mira-2026";
const DEFAULT_REVIEWER_AUTHOR = "rajohan";
const DEPENDABOT_AUTHOR = "app/dependabot";
export const FULL_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
export const DEFAULT_BASE = "main";
export const ACTIVE_PREVIEW_STATUSES = new Set<PullRequestPreviewStatus["status"]>([
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

/**
 * Returns whether mira pull request.
 * @returns Whether mira pull request.
 */
export function isMiraPullRequest(pr: PullRequestSummary): boolean {
    return pr.author?.login === MIRA_AUTHOR;
}

/**
 * Performs author label.
 * @returns Author label result.
 */
export function authorLabel(pr: PullRequestSummary): string {
    if (pr.author?.login === DEPENDABOT_AUTHOR) return "Dependabot";
    return pr.author?.login || "Unknown author";
}

/**
 * Performs status variant.
 * @param value Value to process.
 * @returns Status variant result.
 */
export function statusVariant(value: string | undefined) {
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

/**
 * Performs review decision variant.
 * @returns Review decision variant result.
 */
export function reviewDecisionVariant(pr: PullRequestSummary) {
    if (isPullRequestReviewApproved(pr)) return "success" as const;
    const value = pr.reviewDecision;
    const normalized = (value || "").toUpperCase();
    if (normalized === "CHANGES_REQUESTED") return "error" as const;
    if (normalized === "REVIEW_REQUIRED") return "warning" as const;
    return "default" as const;
}

/**
 * Performs review decision label.
 * @returns Review decision label result.
 */
export function reviewDecisionLabel(pr: PullRequestSummary) {
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

/**
 * Returns whether the pull request has a dashboard-accepted approval.
 * @returns Whether the pull request has a dashboard-accepted approval.
 */
export function isPullRequestReviewApproved(pr: PullRequestSummary): boolean {
    return (
        pr.reviewDecision?.toUpperCase() === "APPROVED" || pr.reviewerApproved === true
    );
}

/**
 * Performs summarize checks.
 * @param checks Checks value.
 * @returns Summarize checks result.
 */
export function summarizeChecks(checks: unknown[] | undefined) {
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

/**
 * Returns whether pull request checks are conclusively passing.
 * @param checks Checks value.
 * @returns Whether pull request checks are conclusively passing.
 */
export function hasPullRequestChecksPassed(checks: unknown[] | undefined): boolean {
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

/**
 * Keeps only the latest check entry for each GitHub check name/context.
 * @param checks Checks value.
 * @returns Latest check records result.
 */
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

/**
 * Returns a stable key for a GitHub status or check run.
 * @returns a stable key for a GitHub status or check run.
 */
function checkKey(check: Record<string, unknown>): string {
    for (const key of ["name", "context", "workflowName"]) {
        const value = check[key];
        if (typeof value === "string" && value.trim()) {
            return `${key}:${value.trim()}`;
        }
    }
    return JSON.stringify(check);
}

/**
 * Returns a comparable timestamp for a GitHub status or check run.
 * @returns a comparable timestamp for a GitHub status or check run.
 */
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

/**
 * Normalizes a GitHub check status or conclusion.
 * @param value Value to process.
 * @returns Normalized a GitHub check status or conclusion.
 */
function normalizedCheckValue(value: unknown): string {
    return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * Performs deployment variant.
 * @param status Status value.
 * @returns Deployment variant result.
 */
export function deploymentVariant(status: DeploymentJob["status"]) {
    if (status === "isOk") return "success" as const;
    if (status === "failed") return "error" as const;
    if (status === "verifying") return "warning" as const;
    return "info" as const;
}

/**
 * Performs deployment status label.
 * @param status Status value.
 * @returns Deployment status label result.
 */
export function deploymentStatusLabel(status: DeploymentJob["status"]) {
    return status === "isOk" ? "ok" : status;
}

/**
 * Performs checkout variant.
 * @param checkout Checkout value.
 * @returns Checkout variant result.
 */
export function checkoutVariant(checkout: ProductionCheckoutStatus | undefined) {
    if (!checkout) return "default" as const;
    if (!checkout.isProductionRoot || !checkout.isClean) return "error" as const;
    if (!checkout.isSafeForDeploy) return "warning" as const;
    return "success" as const;
}

/**
 * Performs checkout label.
 * @param checkout Checkout value.
 * @returns Checkout label result.
 */
export function checkoutLabel(checkout: ProductionCheckoutStatus | undefined) {
    if (!checkout) return "Checking production checkout";
    if (!checkout.isProductionRoot) return "Wrong root";
    if (!checkout.isClean) return "Dirty checkout";
    if (checkout.branch !== checkout.expectedBranch) {
        return `Off ${checkout.expectedBranch}`;
    }
    return "Ready to deploy";
}

/**
 * Performs checkout message.
 * @param checkout Checkout value.
 * @param error Error to inspect.
 * @returns Checkout message result.
 */
export function checkoutMessage(
    checkout: ProductionCheckoutStatus | undefined,
    error: Error | undefined
) {
    if (error)
        return messageFromError(error, "Production checkout status is unavailable");
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

/**
 * Returns whether GitHub currently reports a pull request merge blocker.
 * @returns Whether GitHub currently reports a pull request merge blocker.
 */
export function isGithubMergeBlocked(pr: PullRequestSummary): boolean {
    return (
        ["BEHIND", "BLOCKED"].includes(pr.mergeStateStatus?.toUpperCase() || "") ||
        ["CONFLICTING", "DIRTY"].includes(pr.mergeable?.toUpperCase() || "")
    );
}

/**
 * Returns whether GitHub reports the pull request branch is behind the base branch.
 * @returns Whether GitHub reports the pull request branch is behind the base branch.
 */
export function isPullRequestBranchBehind(pr: PullRequestSummary): boolean {
    return pr.mergeStateStatus?.toUpperCase() === "BEHIND";
}

/**
 * Returns whether GitHub reports merge conflicts for a pull request.
 * @returns Whether GitHub reports merge conflicts for a pull request.
 */
export function hasPullRequestConflicts(pr: PullRequestSummary): boolean {
    const mergeable = pr.mergeable?.toUpperCase();
    return mergeable === "CONFLICTING" || mergeable === "DIRTY";
}

/**
 * Returns whether the configured reviewer can approve the pull request review.
 * @returns Whether the configured reviewer can approve the pull request review.
 */
export function canConfiguredReviewerApproveReview(pr: PullRequestSummary): boolean {
    if (typeof pr.canReviewerApprove === "boolean") {
        return pr.canReviewerApprove;
    }
    return (
        pr.author?.login !== DEFAULT_REVIEWER_AUTHOR &&
        !pr.isDraft &&
        !isPullRequestReviewApproved(pr)
    );
}

/**
 * Performs action label.
 * @returns Action label result.
 */
export function actionLabel(action: Exclude<PendingAction, undefined>) {
    switch (action.type) {
        case "merge": {
            return action.pr.stack ? "Merge stack" : "Merge PR";
        }
        case "merge-deploy": {
            return action.pr.stack ? "Merge stack + Deploy" : "Merge + Deploy";
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
        case "stack-create": {
            return "Create GitHub stack";
        }
        case "deploy": {
            return `Deploy latest ${DEFAULT_BASE}`;
        }
        case "rollback": {
            return `Roll back to ${action.release.commitSha.slice(0, 8)}`;
        }
    }
}

/**
 * Formats the exact pull request heads included in a stack merge confirmation.
 * @param pullRequests Pull requests ordered from bottom to top.
 * @returns Bottom-to-top pull request numbers and abbreviated head SHAs.
 */
function exactPullRequestHeadSummary(pullRequests: PullRequestSummary[]): string {
    return pullRequests
        .map(
            (pullRequest) =>
                `#${pullRequest.number} ${pullRequest.headRefOid?.slice(0, 8) ?? "unavailable"}`
        )
        .join(" → ");
}

/**
 * Builds the exact per-layer head preconditions for a native stack merge.
 * @param pullRequest Selected pull request.
 * @param scope Pull requests included through the selected stack layer.
 * @returns Expected stack heads, or undefined for a standalone pull request.
 */
export function expectedStackHeadsForMerge(
    pullRequest: PullRequestSummary,
    scope: PullRequestSummary[]
): PullRequestExpectedHead[] | undefined {
    if (!pullRequest.stack) return undefined;
    return scope.map((candidate) => {
        if (
            typeof candidate.headRefOid !== "string" ||
            !FULL_COMMIT_SHA_PATTERN.test(candidate.headRefOid)
        ) {
            throw new Error(
                `Refresh Delivery before merging because the exact head for PR #${candidate.number} is unavailable`
            );
        }
        return {
            headSha: candidate.headRefOid,
            number: candidate.number,
        };
    });
}

/**
 * Performs action message.
 * @returns Action message result.
 */
export function actionMessage(action: Exclude<PendingAction, undefined>) {
    switch (action.type) {
        case "merge": {
            if (action.pr.stack) {
                return `Merge GitHub stack #${action.pr.stack.number} through PR #${action.pr.number}: ${action.pr.title}?\n\nIncluded exact heads: ${exactPullRequestHeadSummary(action.scope)}. GitHub will submit every open PR from the bottom of the stack through #${action.pr.number} as one all-or-nothing merge group. Direct merges use squash; a required merge queue uses its repository policy. Delivery removes each merged PR's clean local worktree and managed dev data only after every included PR confirms as merged. If GitHub queues the stack, Delivery retains every worktree. It will not deploy.`;
            }
            return `Merge PR #${action.pr.number}: ${action.pr.title}?\n\nThis will squash-merge exact head ${action.pr.headRefOid?.slice(0, 8) ?? "shown in Delivery"} and delete the remote branch. It will not deploy.`;
        }
        case "merge-deploy": {
            if (action.pr.stack) {
                return `Merge and deploy GitHub stack #${action.pr.stack.number} through PR #${action.pr.number}: ${action.pr.title}?\n\nIncluded exact heads: ${exactPullRequestHeadSummary(action.scope)}. GitHub will submit every open PR from the bottom of the stack through #${action.pr.number} as one all-or-nothing merge group. Direct merges use squash; a required merge queue uses its repository policy. After every included PR confirms as merged, Delivery removes its clean local worktree and managed dev data, syncs ${DEFAULT_BASE}, publishes an immutable release, atomically activates it, restarts web and worker, and verifies commit-bound readiness. If GitHub queues the stack, Delivery keeps all worktrees and does not auto-deploy; use Deploy latest ${DEFAULT_BASE} after the queue finishes.`;
            }
            return `Merge and deploy PR #${action.pr.number}: ${action.pr.title}?\n\nThis will squash-merge exact head ${action.pr.headRefOid?.slice(0, 8) ?? "shown in Delivery"}, sync ${DEFAULT_BASE}, publish an immutable release, atomically activate it, restart web and worker, and verify commit-bound readiness. A failed release is rolled back automatically.`;
        }
        case "review-approve": {
            return `Approve PR #${action.pr.number}: ${action.pr.title}?\n\nThis approves the PR on GitHub. It does not merge or deploy.`;
        }
        case "preview-start": {
            const includedPullRequests = action.scope
                .map((pullRequest) => `#${pullRequest.number}`)
                .join(" → ");
            return `Run PR #${action.pr.number} in dev: ${action.pr.title}?\n\nThis runs the exact PR head ${action.pr.headRefOid?.slice(0, 8) ?? "shown in Delivery"}. Included layers: ${includedPullRequests}. It runs over Tailscale HTTPS without source watchers, using an isolated Dashboard database, a writable workspace snapshot, and an isolated scheduler/worker without host or backup jobs. It connects to the live production Gateway so chat and session changes can affect production data. The dev environment stops automatically after four hours.`;
        }
        case "preview-rebuild": {
            const includedPullRequests = action.scope
                .map((pullRequest) => `#${pullRequest.number}`)
                .join(" → ");
            return `Rebuild PR dev for #${action.pr.number}: ${action.pr.title}?\n\nThis replaces the running dev environment with exact PR head ${action.pr.headRefOid?.slice(0, 8) ?? "shown in Delivery"}. Included layers: ${includedPullRequests}. It keeps the same isolation and live production Gateway connection. The rebuilt environment stops automatically after four hours.`;
        }
        case "preview-stop": {
            const title = action.title ? `: ${action.title}` : "";
            return `Stop PR dev for #${action.number}${title}?\n\nThe shared checkout and isolated PR state are kept while the PR remains open for a faster later restart.`;
        }
        case "reject": {
            return `Reject PR #${action.pr.number}: ${action.pr.title}?\n\nThis closes the PR with a dashboard rejection comment. It does not delete the branch.`;
        }
        case "stack-create": {
            const pullRequestNumbers = action.candidate.pullRequests
                .map((pullRequest) => `#${pullRequest.number}`)
                .join(" → ");
            return `Create a GitHub stack from ${pullRequestNumbers}?\n\nThe existing pull requests will be linked from bottom to top. Their branches, commits, and review state are unchanged.`;
        }
        case "deploy": {
            return `Deploy latest ${DEFAULT_BASE}?\n\nThis will sync ${DEFAULT_BASE}, publish an immutable release, atomically activate it, restart web and worker, and verify commit-bound readiness. A failed release is rolled back automatically.`;
        }
        case "rollback": {
            return `Roll back to ${action.release.commitSha.slice(0, 8)}: ${action.release.commitTitle}?\n\nThis atomically swaps the active and previous releases, restarts web and worker, and verifies commit-bound readiness. If the rollback target fails, the current release is restored automatically.`;
        }
    }
}

/**
 * Combines an action result with any best-effort cleanup outcomes.
 * @param message Message to process.
 * @param cleanupResults Cleanup results value.
 * @returns Action result message result.
 */
export function actionResultMessage(
    message: string,
    ...cleanupResults: Array<{ message: string } | { message: string }[] | undefined>
) {
    return [
        message,
        ...cleanupResults
            .flatMap((cleanup) => {
                if (cleanup === undefined) return [];
                return Array.isArray(cleanup) ? cleanup : [cleanup];
            })
            .map((cleanup) => cleanup.message),
    ].join("\n");
}

/**
 * Normalizes pull request body.
 * @param body Request or document body.
 * @returns Normalized pull request body.
 */
export function normalizePullRequestBody(body: string): string {
    if (!body.includes("\n") && body.includes(String.raw`\n`)) {
        return body.replaceAll(String.raw`\n`, "\n");
    }

    return body;
}
