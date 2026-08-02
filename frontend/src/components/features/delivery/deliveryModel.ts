import type {
    DeploymentJob,
    ProductionCheckoutStatus,
} from "../../../../../contracts/delivery/deployments";
import type { PullRequestPreviewStatus } from "../../../../../contracts/delivery/previews";
import type { PullRequestSummary } from "../../../../../contracts/delivery/pullRequests";
import { messageFromError } from "../../../lib/errorMessage";

const MIRA_AUTHOR = "mira-2026";
const DEFAULT_REVIEWER_AUTHOR = "rajohan";
const DEPENDABOT_AUTHOR = "app/dependabot";
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
