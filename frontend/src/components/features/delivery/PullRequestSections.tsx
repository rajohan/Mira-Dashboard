import { GitBranch } from "lucide-react";

import type { PullRequestSummary } from "../../../../../contracts/delivery/pullRequests";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";
import { PullRequestCard } from "./DeliveryCards";
import { SectionHeader } from "./DeliveryLabels";
import { PullRequestActions, type PullRequestActionsContext } from "./PullRequestActions";
import type {
    PullRequestStackCandidate,
    PullRequestStackGroup,
} from "./pullRequestStacks";

interface PullRequestSectionsProperties {
    actionContext: PullRequestActionsContext;
    externalPullRequests: PullRequestSummary[];
    hasMiraPullRequests: boolean;
    isActionPending: boolean;
    miraPullRequests: PullRequestSummary[];
    onCreateStack: (candidate: PullRequestStackCandidate) => void;
    pullRequests: PullRequestSummary[];
    stackCandidates: PullRequestStackCandidate[];
    stackGroups: PullRequestStackGroup[];
}

function pullRequestCard(
    pullRequest: PullRequestSummary,
    actionContext: PullRequestActionsContext
) {
    return (
        <PullRequestCard
            key={pullRequest.number}
            pr={pullRequest}
            actions={<PullRequestActions context={actionContext} pr={pullRequest} />}
        />
    );
}

/**
 * Renders native stacks, stack candidates, and standalone Delivery pull requests.
 * @param properties Pull request groups and Delivery action callbacks.
 * @returns Rendered pull request sections.
 */
export function PullRequestSections({
    actionContext,
    externalPullRequests,
    hasMiraPullRequests,
    isActionPending,
    miraPullRequests,
    onCreateStack,
    pullRequests,
    stackCandidates,
    stackGroups,
}: PullRequestSectionsProperties) {
    return (
        <div className="space-y-4">
            {pullRequests.length === 0 ? (
                <Card variant="bordered">
                    <CardTitle>No open PRs waiting</CardTitle>
                    <p className="mt-2 text-sm text-primary-400">
                        New dashboard and dependency PRs will appear here for review.
                    </p>
                </Card>
            ) : undefined}

            {stackCandidates.length > 0 ? (
                <section className="space-y-3" aria-label="GitHub stack candidates">
                    <div>
                        <SectionHeader
                            title="GitHub stack candidates"
                            count={stackCandidates.reduce(
                                (count, candidate) =>
                                    count + candidate.pullRequests.length,
                                0
                            )}
                            badgeVariant="warning"
                        />
                        <p className="mt-1 text-sm text-primary-400">
                            These existing PR chains are linear but not yet linked as
                            GitHub stacks.
                        </p>
                    </div>
                    <div className="space-y-2">
                        {stackCandidates.map((candidate) => {
                            const numbers = candidate.pullRequests
                                .map((pullRequest) => `#${pullRequest.number}`)
                                .join(" → ");
                            return (
                                <div
                                    key={numbers}
                                    className="space-y-3 rounded-lg border border-primary-700 bg-primary-900/20 p-3"
                                    aria-label={`GitHub stack candidate ${numbers}`}
                                >
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                        <div>
                                            <div className="text-sm font-medium text-primary-200">
                                                {numbers}
                                            </div>
                                            <p className="mt-1 text-xs text-primary-400">
                                                Bottom targets{" "}
                                                <span className="font-mono">
                                                    {candidate.baseRefName}
                                                </span>
                                                ; each next PR targets the branch below
                                                it.
                                            </p>
                                        </div>
                                        <Button
                                            variant="secondary"
                                            onClick={() => onCreateStack(candidate)}
                                            disabled={isActionPending}
                                        >
                                            <GitBranch className="size-4" />
                                            Create stack
                                        </Button>
                                    </div>
                                    {candidate.pullRequests.map((pullRequest) =>
                                        pullRequestCard(pullRequest, actionContext)
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </section>
            ) : undefined}

            {stackGroups.length > 0 ? (
                <section className="space-y-3" aria-label="GitHub stacks">
                    <div>
                        <SectionHeader
                            title="GitHub stacks"
                            count={stackGroups.reduce(
                                (count, group) => count + group.pullRequests.length,
                                0
                            )}
                            badgeVariant="info"
                        />
                        <p className="mt-1 text-sm text-primary-400">
                            Choose any layer to submit it and every open PR below it as
                            one merge group. Choosing the top submits the full remaining
                            stack.
                        </p>
                    </div>
                    <div className="space-y-4">
                        {stackGroups.map((group) => {
                            const firstPullRequest = group.pullRequests[0];
                            const stack = firstPullRequest?.stack;
                            if (!stack) return null;
                            return (
                                <div
                                    key={group.number}
                                    className="space-y-3 rounded-lg border border-primary-700 bg-primary-900/20 p-3"
                                    aria-label={`GitHub stack #${group.number}`}
                                >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div>
                                            <h3 className="font-medium text-primary-200">
                                                Stack #{group.number}
                                            </h3>
                                            <p className="text-xs text-primary-400">
                                                {group.pullRequests.length} open of{" "}
                                                {stack.size} total · base{" "}
                                                <span className="font-mono text-primary-300">
                                                    {stack.baseRefName}
                                                </span>
                                            </p>
                                        </div>
                                        <Badge variant="info">Bottom → top</Badge>
                                    </div>
                                    {group.pullRequests.map((pullRequest) =>
                                        pullRequestCard(pullRequest, actionContext)
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </section>
            ) : undefined}

            {pullRequests.length > 0 && !hasMiraPullRequests ? (
                <Card variant="bordered">
                    <CardTitle>No Mira-authored PRs waiting</CardTitle>
                    <p className="mt-2 text-sm text-primary-400">
                        Autopilot changes will appear here when Mira opens a dashboard PR
                        for Raymond to review.
                    </p>
                </Card>
            ) : undefined}

            {miraPullRequests.length > 0 ? (
                <section className="space-y-3" aria-label="Mira-authored PRs">
                    <div>
                        <SectionHeader
                            title="Mira-authored PRs"
                            count={miraPullRequests.length}
                            badgeVariant="info"
                        />
                        <p className="mt-1 text-sm text-primary-400">
                            Standalone main PRs use the existing single-PR flow.
                            Unresolved dependent PRs stay read-only until linked as a
                            stack.
                        </p>
                    </div>
                    <div className="space-y-3">
                        {miraPullRequests.map((pullRequest) =>
                            pullRequestCard(pullRequest, actionContext)
                        )}
                    </div>
                </section>
            ) : undefined}

            {externalPullRequests.length > 0 ? (
                <section className="space-y-3" aria-label="Dependency and external PRs">
                    <div>
                        <SectionHeader
                            title="Dependency / external PRs"
                            count={externalPullRequests.length}
                            badgeVariant="default"
                        />
                        <p className="mt-1 text-sm text-primary-400">
                            Standalone changes use the same review, CI, and checkout gates
                            as Mira-authored PRs. Unresolved dependent PRs stay read-only
                            until linked as a stack.
                        </p>
                    </div>
                    <div className="space-y-3">
                        {externalPullRequests.map((pullRequest) =>
                            pullRequestCard(pullRequest, actionContext)
                        )}
                    </div>
                </section>
            ) : undefined}
        </div>
    );
}
