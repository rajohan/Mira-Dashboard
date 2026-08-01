import { GitBranch, Rocket } from "lucide-react";

import {
    PullRequestCard,
    RecentDeploysCard,
} from "../components/features/delivery/DeliveryCards";
import { SectionHeader } from "../components/features/delivery/DeliveryLabels";
import {
    actionLabel,
    actionMessage,
    checkoutLabel,
    checkoutMessage,
    checkoutVariant,
    DEFAULT_BASE,
} from "../components/features/delivery/deliveryModel";
import { ProductionReleasesCard } from "../components/features/delivery/ProductionReleasesCard";
import { PullRequestDevelopmentCard } from "../components/features/delivery/PullRequestDevelopmentCard";
import { useDeliveryController } from "../components/features/delivery/useDeliveryController";
import { Alert } from "../components/ui/Alert";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { LoadingState } from "../components/ui/LoadingState";
import { PageState } from "../components/ui/PageState";
import { RefreshButton } from "../components/ui/RefreshButton";
import { messageFromError } from "../lib/errorMessage";

/**
 * Renders Dashboard delivery operations.
 * @returns Rendered Dashboard delivery operations.
 */
export function Delivery() {
    const {
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
    } = useDeliveryController();

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
                        error={
                            error
                                ? messageFromError(error, "Failed to load pull requests")
                                : undefined
                        }
                        errorView={
                            <Card
                                variant="bordered"
                                className="flex min-h-48 flex-col items-center justify-center gap-4"
                            >
                                <p className="text-red-400">
                                    {messageFromError(
                                        error,
                                        "Failed to load pull requests"
                                    )}
                                </p>
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

                            {stackCandidates.length > 0 ? (
                                <section
                                    className="space-y-3"
                                    aria-label="GitHub stack candidates"
                                >
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
                                            These existing PR chains are linear but not
                                            yet linked as GitHub stacks.
                                        </p>
                                    </div>
                                    <div className="space-y-2">
                                        {stackCandidates.map((candidate) => {
                                            const numbers = candidate.pullRequests
                                                .map(
                                                    (pullRequest) =>
                                                        `#${pullRequest.number}`
                                                )
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
                                                                    {
                                                                        candidate.baseRefName
                                                                    }
                                                                </span>
                                                                ; each next PR targets the
                                                                branch below it.
                                                            </p>
                                                        </div>
                                                        <Button
                                                            variant="secondary"
                                                            onClick={() =>
                                                                setPendingAction({
                                                                    candidate,
                                                                    type: "stack-create",
                                                                })
                                                            }
                                                            disabled={isActionPending}
                                                        >
                                                            <GitBranch className="size-4" />
                                                            Create stack
                                                        </Button>
                                                    </div>
                                                    {candidate.pullRequests.map((pr) => (
                                                        <PullRequestCard
                                                            key={pr.number}
                                                            pr={pr}
                                                            actions={renderPullRequestActions(
                                                                pr
                                                            )}
                                                        />
                                                    ))}
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
                                                (count, group) =>
                                                    count + group.pullRequests.length,
                                                0
                                            )}
                                            badgeVariant="info"
                                        />
                                        <p className="mt-1 text-sm text-primary-400">
                                            Choose any layer to submit it and every open
                                            PR below it as one merge group. Choosing the
                                            top submits the full remaining stack.
                                        </p>
                                    </div>
                                    <div className="space-y-4">
                                        {stackGroups.map((group) => {
                                            const firstPullRequest =
                                                group.pullRequests[0];
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
                                                                {
                                                                    group.pullRequests
                                                                        .length
                                                                }{" "}
                                                                open of {stack.size} total
                                                                · base{" "}
                                                                <span className="font-mono text-primary-300">
                                                                    {stack.baseRefName}
                                                                </span>
                                                            </p>
                                                        </div>
                                                        <Badge variant="info">
                                                            Bottom → top
                                                        </Badge>
                                                    </div>
                                                    {group.pullRequests.map((pr) => (
                                                        <PullRequestCard
                                                            key={pr.number}
                                                            pr={pr}
                                                            actions={renderPullRequestActions(
                                                                pr
                                                            )}
                                                        />
                                                    ))}
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
                                            Standalone main PRs use the existing single-PR
                                            flow. Unresolved dependent PRs stay read-only
                                            until linked as a stack.
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
                                            Standalone changes use the same review, CI,
                                            and checkout gates as Mira-authored PRs.
                                            Unresolved dependent PRs stay read-only until
                                            linked as a stack.
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
