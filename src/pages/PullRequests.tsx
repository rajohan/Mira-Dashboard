import { GitMerge, GitPullRequest, Rocket, XCircle } from "lucide-react";
import { type ReactNode, useState } from "react";

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
    useDeployDashboard,
    useProductionCheckout,
    usePullRequestDeployments,
    usePullRequests,
    useRejectPullRequest,
} from "../hooks";
import { formatDate } from "../utils/format";

type PendingAction =
    | { type: "merge"; pr: PullRequestSummary }
    | { type: "merge-deploy"; pr: PullRequestSummary }
    | { type: "reject"; pr: PullRequestSummary }
    | { type: "deploy" }
    | null;

const MIRA_AUTHOR = "mira-2026";
const DEPENDABOT_AUTHOR = "app/dependabot";

function isMiraPullRequest(pr: PullRequestSummary): boolean {
    return pr.author?.login === MIRA_AUTHOR;
}

function authorLabel(pr: PullRequestSummary): string {
    if (pr.author?.login === DEPENDABOT_AUTHOR) return "Dependabot";
    return pr.author?.login || "Unknown author";
}

function statusVariant(value: string | undefined) {
    const normalized = (value || "").toLowerCase();
    if (["mergeable", "clean", "ok", "success"].includes(normalized)) {
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
        ["unknown", "unstable", "pending", "queued", "in_progress"].includes(normalized)
    ) {
        return "warning" as const;
    }

    return "default" as const;
}

function summarizeChecks(checks: unknown[] | undefined) {
    if (!checks?.length) {
        return { label: "No CI checks", variant: "default" as const };
    }

    const records = checks.filter(
        (check): check is Record<string, unknown> =>
            Boolean(check) && typeof check === "object" && !Array.isArray(check)
    );
    const values = records.map((check) =>
        String(check.conclusion || check.status || "").toLowerCase()
    );

    if (values.some((value) => ["failure", "failed", "error"].includes(value))) {
        return { label: "Checks failed", variant: "error" as const };
    }

    if (values.some((value) => ["queued", "pending", "in_progress"].includes(value))) {
        return { label: "Checks running", variant: "warning" as const };
    }

    return { label: "Checks passed", variant: "success" as const };
}

function deploymentVariant(status: DeploymentJob["status"]) {
    if (status === "ok") return "success" as const;
    if (status === "failed") return "error" as const;
    if (status === "restart-scheduled") return "warning" as const;
    return "info" as const;
}

function checkoutVariant(checkout: ProductionCheckoutStatus | undefined) {
    if (!checkout) return "default" as const;
    if (!checkout.isProductionRoot || !checkout.isClean) return "error" as const;
    if (!checkout.isSafeForDeploy) return "warning" as const;
    return "success" as const;
}

function checkoutLabel(checkout: ProductionCheckoutStatus | undefined) {
    if (!checkout) return "Checking production checkout";
    if (!checkout.isProductionRoot) return "Wrong root";
    if (!checkout.isClean) return "Dirty checkout";
    if (checkout.branch !== checkout.expectedBranch) return "Will switch to master";
    return "Ready to deploy";
}

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
        return `The next deploy/merge will switch the production checkout from ${checkout.branch} to ${checkout.expectedBranch} before building.`;
    }
    return "Deploys build only from the clean production checkout. PR verification should happen in separate git worktrees.";
}

function actionLabel(action: PendingAction) {
    if (!action) return "Confirm";
    switch (action.type) {
        case "merge":
            return "Merge PR";
        case "merge-deploy":
            return "Merge + deploy";
        case "reject":
            return "Reject PR";
        case "deploy":
            return "Deploy latest master";
    }
}

function actionMessage(action: PendingAction) {
    if (!action) return "";
    switch (action.type) {
        case "merge":
            return `Merge PR #${action.pr.number}: ${action.pr.title}?\n\nThis will squash-merge the PR and delete the remote branch. It will not deploy.`;
        case "merge-deploy":
            return `Merge and deploy PR #${action.pr.number}: ${action.pr.title}?\n\nThis will squash-merge, sync the production checkout to master, build frontend/backend from there, schedule a service restart, and run a health check.`;
        case "reject":
            return `Reject PR #${action.pr.number}: ${action.pr.title}?\n\nThis closes the PR with a dashboard rejection comment. It does not delete the branch.`;
        case "deploy":
            return "Deploy latest master?\n\nThis will sync the production checkout to master, build frontend/backend from there, schedule a mira-dashboard.service restart, and run a health check.";
    }
}

function actionResultMessage(message: string, cleanup?: WorktreeCleanupResult) {
    if (!cleanup) return message;
    return `${message}\n${cleanup.message}`;
}

function PullRequestCard({
    pr,
    actions,
}: {
    pr: PullRequestSummary;
    actions?: ReactNode;
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
                        {authorLabel(pr)} · Updated {formatDate(pr.updatedAt)} · +
                        {pr.additions ?? 0} -{pr.deletions ?? 0} across{" "}
                        {pr.changedFiles ?? 0} files
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
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
                </div>
            </div>

            {pr.body ? (
                <pre className="border-primary-700 bg-primary-900/50 text-primary-300 max-h-48 overflow-auto rounded border p-3 text-xs whitespace-pre-wrap">
                    {pr.body}
                </pre>
            ) : null}

            {actions ? (
                <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
                    {actions}
                </div>
            ) : null}
        </Card>
    );
}

export function PullRequests() {
    const { data: pullRequests = [], isLoading, error, refetch } = usePullRequests();
    const { data: deployments = [] } = usePullRequestDeployments();
    const { data: productionCheckout, error: productionCheckoutError } =
        useProductionCheckout();
    const approvePullRequest = useApprovePullRequest();
    const rejectPullRequest = useRejectPullRequest();
    const deployDashboard = useDeployDashboard();
    const [pendingAction, setPendingAction] = useState<PendingAction>(null);
    const [lastResult, setLastResult] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    const isActionPending =
        approvePullRequest.isPending ||
        rejectPullRequest.isPending ||
        deployDashboard.isPending;
    const isProductionActionBlocked = Boolean(
        productionCheckout &&
        (!productionCheckout.isProductionRoot || !productionCheckout.isClean)
    );
    const miraPullRequests = pullRequests.filter(isMiraPullRequest);
    const externalPullRequests = pullRequests.filter((pr) => !isMiraPullRequest(pr));

    async function confirmAction() {
        if (!pendingAction) return;

        setActionError(null);
        try {
            if (pendingAction.type === "merge") {
                const result = await approvePullRequest.mutateAsync({
                    number: pendingAction.pr.number,
                    deploy: false,
                });
                setLastResult(actionResultMessage(result.message, result.cleanup));
            }

            if (pendingAction.type === "merge-deploy") {
                const result = await approvePullRequest.mutateAsync({
                    number: pendingAction.pr.number,
                    deploy: true,
                });
                setLastResult(
                    actionResultMessage(
                        result.deployment?.note || result.message,
                        result.cleanup
                    )
                );
            }

            if (pendingAction.type === "reject") {
                const result = await rejectPullRequest.mutateAsync({
                    number: pendingAction.pr.number,
                });
                setLastResult(actionResultMessage(result.message, result.cleanup));
            }

            if (pendingAction.type === "deploy") {
                const result = await deployDashboard.mutateAsync();
                setLastResult(result.deployment.note || "Deploy scheduled");
            }

            setPendingAction(null);
        } catch (error_) {
            setActionError(error_ instanceof Error ? error_.message : "Action failed");
        }
    }

    return (
        <PageState
            isLoading={isLoading}
            loading={<LoadingState size="lg" />}
            error={error?.message ?? null}
            errorView={
                <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-3 sm:p-6">
                    <p className="text-red-400">{error?.message}</p>
                    <RefreshButton onClick={() => void refetch()} label="Retry" />
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
                            actions are only enabled for Mira-authored PRs.
                        </p>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:flex">
                        <RefreshButton
                            onClick={() => void refetch()}
                            isLoading={isLoading}
                            label="Refresh"
                            variant="secondary"
                        />
                        <Button
                            variant="primary"
                            onClick={() => setPendingAction({ type: "deploy" })}
                            disabled={isActionPending || isProductionActionBlocked}
                        >
                            <Rocket className="h-4 w-4" />
                            Deploy latest master
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
                        <div className="flex flex-wrap gap-2">
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
                                    {productionCheckout.isClean ? "clean" : "dirty"}
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
                                {miraPullRequests.map((pr) => (
                                    <PullRequestCard
                                        key={pr.number}
                                        pr={pr}
                                        actions={
                                            <>
                                                <Button
                                                    variant="primary"
                                                    onClick={() =>
                                                        setPendingAction({
                                                            type: "merge-deploy",
                                                            pr,
                                                        })
                                                    }
                                                    disabled={
                                                        isActionPending ||
                                                        isProductionActionBlocked
                                                    }
                                                >
                                                    <Rocket className="h-4 w-4" />
                                                    Merge + deploy
                                                </Button>
                                                <Button
                                                    variant="secondary"
                                                    onClick={() =>
                                                        setPendingAction({
                                                            type: "merge",
                                                            pr,
                                                        })
                                                    }
                                                    disabled={
                                                        isActionPending ||
                                                        isProductionActionBlocked
                                                    }
                                                >
                                                    <GitMerge className="h-4 w-4" />
                                                    Merge only
                                                </Button>
                                                <Button
                                                    variant="danger"
                                                    onClick={() =>
                                                        setPendingAction({
                                                            type: "reject",
                                                            pr,
                                                        })
                                                    }
                                                    disabled={isActionPending}
                                                >
                                                    <XCircle className="h-4 w-4" />
                                                    Reject
                                                </Button>
                                            </>
                                        }
                                    />
                                ))}
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
                                        Visible for review status. Manage these on GitHub
                                        until we add a dedicated safe policy.
                                    </p>
                                </div>
                                {externalPullRequests.map((pr) => (
                                    <PullRequestCard key={pr.number} pr={pr} />
                                ))}
                            </section>
                        ) : null}
                    </div>

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
                                                    {deployment.commit || deployment.id}
                                                </div>
                                                <div className="text-primary-500 text-xs">
                                                    {formatDate(deployment.updatedAt)}
                                                </div>
                                            </div>
                                            <Badge
                                                variant={deploymentVariant(
                                                    deployment.status
                                                )}
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
                </div>

                <ConfirmModal
                    isOpen={pendingAction !== null}
                    title={actionLabel(pendingAction)}
                    message={actionMessage(pendingAction)}
                    confirmLabel={actionLabel(pendingAction)}
                    confirmLoadingLabel="Working"
                    loading={isActionPending}
                    danger={pendingAction?.type === "reject"}
                    onCancel={() => {
                        if (!isActionPending) {
                            setPendingAction(null);
                            setActionError(null);
                        }
                    }}
                    onConfirm={() => {
                        void confirmAction();
                    }}
                />
            </div>
        </PageState>
    );
}
