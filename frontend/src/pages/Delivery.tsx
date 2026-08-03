import { Rocket } from "lucide-react";
import { useEffect, useRef } from "react";

import {
    actionLabel,
    actionMessage,
    DEFAULT_BASE,
} from "../components/features/delivery/deliveryActionModel";
import { RecentDeploysCard } from "../components/features/delivery/DeliveryCards";
import {
    checkoutLabel,
    checkoutMessage,
    checkoutVariant,
} from "../components/features/delivery/deliveryModel";
import { ProductionReleasesCard } from "../components/features/delivery/ProductionReleasesCard";
import { PullRequestDevelopmentCard } from "../components/features/delivery/PullRequestDevelopmentCard";
import { PullRequestSections } from "../components/features/delivery/PullRequestSections";
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
        actionProgress,
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
    } = useDeliveryController();
    const pageTopRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!actionProgress) return;
        pageTopRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
        });
    }, [actionProgress]);

    return (
        <div ref={pageTopRef} className="space-y-4 p-3 sm:p-4 lg:p-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <h2 className="flex items-center gap-2 text-xl font-semibold text-primary-100">
                        <Rocket className="size-5" />
                        Delivery
                    </h2>
                    <p className="mt-1 max-w-2xl text-sm text-primary-400">
                        Review and run trusted pull requests, manage production releases,
                        and deploy the latest safe main checkout.
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

            {actionProgress ? (
                <div>
                    <Alert variant="info">
                        <output className="block text-sm text-blue-300">
                            {actionProgress}
                        </output>
                    </Alert>
                </div>
            ) : undefined}

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
                        <CardTitle className="text-base">Production checkout</CardTitle>
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
                                variant={productionCheckout.isClean ? "success" : "error"}
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
                                {messageFromError(error, "Failed to load pull requests")}
                            </p>
                            <RefreshButton
                                onClick={() => void refetchPullRequests()}
                                label="Retry"
                            />
                        </Card>
                    }
                >
                    <PullRequestSections
                        actionContext={pullRequestActionContext}
                        externalPullRequests={externalPullRequests}
                        hasMiraPullRequests={hasMiraPullRequests}
                        isActionPending={isActionPending}
                        miraPullRequests={miraPullRequests}
                        onCreateStack={(candidate) =>
                            setPendingAction({ candidate, type: "stack-create" })
                        }
                        pullRequests={pullRequests}
                        stackCandidates={stackCandidates}
                        stackGroups={stackGroups}
                    />
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
                        if (isActionPending) return;
                        setPendingAction(undefined);
                        setActionError(undefined);
                    }}
                    onConfirm={() => {
                        void confirmAction(pendingAction);
                    }}
                />
            )}
        </div>
    );
}
