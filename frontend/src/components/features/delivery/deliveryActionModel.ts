import type { DashboardReleaseSummary } from "../../../../../contracts/delivery/deployments";
import type {
    PullRequestExpectedHead,
    PullRequestSummary,
} from "../../../../../contracts/delivery/pullRequests";
import type { PullRequestStackCandidate } from "./pullRequestStacks";

/** Defines a Delivery action awaiting explicit confirmation. */
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

export const FULL_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
export const DEFAULT_BASE = "main";

// Returns the confirmation label for a pending Delivery action.
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

function exactPullRequestHeadSummary(pullRequests: PullRequestSummary[]): string {
    return pullRequests
        .map(
            (pullRequest) =>
                `#${pullRequest.number} ${pullRequest.headRefOid?.slice(0, 8) ?? "unavailable"}`
        )
        .join(" → ");
}

/**
 * Builds exact per-layer head preconditions for a native stack merge.
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

// Returns the confirmation message for a pending Delivery action.
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

// Combines an action result with any best-effort cleanup outcomes.
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
