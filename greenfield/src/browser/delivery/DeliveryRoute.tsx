import { useQuery } from "@tanstack/react-query";
import { ExternalLink as ExternalLinkIcon, Rocket, X } from "lucide-react";

import type {
    DeliveryPreviewResult,
    DeliveryProductionCheckoutResult,
    DeliveryPullRequest,
    DeliveryPullRequestActionCapability,
    DeliveryPullRequestGroup,
    DeliveryPullRequestsResult,
    DeliveryReleasesResult,
} from "../../contracts/delivery.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import type { DeliveryClient } from "./deliveryClient.ts";
import { DeliveryJobsPanel } from "./DeliveryJobsPanel.tsx";
import {
    deployMainPrompt,
    pullRequestOperationPrompt,
    rollbackReleasePrompt,
    stopPreviewPrompt,
} from "./deliveryOperations.ts";
import { deliveryFailureMessage } from "./deliveryPresentation.ts";
import {
    deliveryCheckoutQueryOptions,
    deliveryDeploymentsQueryOptions,
    deliveryPreviewQueryOptions,
    deliveryPullRequestsQueryOptions,
    deliveryReleasesQueryOptions,
    useDeliveryRealtimeInvalidation,
} from "./deliveryQueries.ts";
import { DeliveryReadRegion } from "./DeliveryReadRegion.tsx";
import { PreviewPanel } from "./PreviewPanel.tsx";
import { ProductionReleasesPanel } from "./ProductionPanel.tsx";
import { PullRequestBrowser } from "./PullRequestBrowser.tsx";
import { useDeliveryOperations } from "./useDeliveryOperations.ts";

interface DeliveryRouteProps {
    readonly client: DeliveryClient;
}

type AvailablePullRequestsResult = Exclude<
    DeliveryPullRequestsResult,
    { readonly state: "unavailable" }
>;
type AvailablePreviewResult = Exclude<
    DeliveryPreviewResult,
    { readonly state: "unavailable" }
>;
type AvailableCheckoutResult = Exclude<
    DeliveryProductionCheckoutResult,
    { readonly state: "unavailable" }
>;
type AvailableReleasesResult = Exclude<
    DeliveryReleasesResult,
    { readonly state: "unavailable" }
>;

function availablePullRequestsResult(
    value: DeliveryPullRequestsResult | undefined
): AvailablePullRequestsResult | undefined {
    return value === undefined || value.state === "unavailable" ? undefined : value;
}

function availablePreviewResult(
    value: DeliveryPreviewResult | undefined
): AvailablePreviewResult | undefined {
    return value === undefined || value.state === "unavailable" ? undefined : value;
}

function availableCheckoutResult(
    value: DeliveryProductionCheckoutResult | undefined
): AvailableCheckoutResult | undefined {
    return value === undefined || value.state === "unavailable" ? undefined : value;
}

function availableReleasesResult(
    value: DeliveryReleasesResult | undefined
): AvailableReleasesResult | undefined {
    return value === undefined || value.state === "unavailable" ? undefined : value;
}

/** @returns Complete Delivery parity page with five independently resilient read regions. */
export function DeliveryRoute({ client }: DeliveryRouteProps) {
    useDeliveryRealtimeInvalidation();
    const pullRequestsQuery = useQuery(deliveryPullRequestsQueryOptions(client));
    const previewQuery = useQuery(deliveryPreviewQueryOptions(client));
    const checkoutQuery = useQuery(deliveryCheckoutQueryOptions(client));
    const releasesQuery = useQuery(deliveryReleasesQueryOptions(client));
    const deploymentsQuery = useQuery(deliveryDeploymentsQueryOptions(client));

    const pullRequests = pullRequestsQuery.data;
    const preview = previewQuery.data;
    const checkout = checkoutQuery.data;
    const releases = releasesQuery.data;
    const deployments = deploymentsQuery.data;
    const availablePullRequests = availablePullRequestsResult(pullRequests);
    const availablePreview = availablePreviewResult(preview);
    const availableCheckout = availableCheckoutResult(checkout);
    const availableReleases = availableReleasesResult(releases);
    const pullRequestsBrowserRetained =
        pullRequestsQuery.error !== null && pullRequests?.state !== undefined;
    const retainedReads = [
        ["production releases", releases?.state, releasesQuery.error],
        ["pull request preview", preview?.state, previewQuery.error],
        ["production checkout", checkout?.state, checkoutQuery.error],
        ["pull requests", pullRequests?.state, pullRequestsQuery.error],
        ["recent Delivery jobs", deployments?.state, deploymentsQuery.error],
    ].flatMap(([label, state, error]) =>
        state === "last-known-good" || (state !== undefined && error !== null)
            ? [label]
            : []
    );
    const retainedReadsFetching =
        releasesQuery.isFetching ||
        previewQuery.isFetching ||
        checkoutQuery.isFetching ||
        pullRequestsQuery.isFetching ||
        deploymentsQuery.isFetching;
    const retryRetainedReads = () =>
        void Promise.allSettled([
            releasesQuery.refetch(),
            previewQuery.refetch(),
            checkoutQuery.refetch(),
            pullRequestsQuery.refetch(),
            deploymentsQuery.refetch(),
        ]);
    const pullRequestsFresh =
        pullRequests?.state === "fresh" && pullRequestsQuery.error === null;
    const previewFresh = preview?.state === "fresh" && previewQuery.error === null;
    const checkoutFresh = checkout?.state === "fresh" && checkoutQuery.error === null;
    const releasesFresh = releases?.state === "fresh" && releasesQuery.error === null;
    const currentAuthority = {
        ...(checkout?.state === "unavailable"
            ? {}
            : {
                  checkout: checkout?.checkout,
                  checkoutFresh,
                  checkoutSourceRevision: checkout?.sourceRevision,
              }),
        ...(preview?.state === "unavailable"
            ? {}
            : {
                  preview: preview?.preview,
                  previewActionActive: preview?.actionActive,
                  previewFresh,
                  previewSourceRevision: preview?.sourceRevision,
              }),
        ...(pullRequests?.state === "unavailable"
            ? {}
            : {
                  pullRequestsFresh,
                  pullRequestSourceRevision: pullRequests?.sourceRevision,
                  reviewerRevision: pullRequests?.reviewerCapability.revision,
              }),
        ...(releases?.state === "unavailable"
            ? {}
            : {
                  releases: releases?.releases,
                  releasesActionActive: releases?.actionActive,
                  releasesFresh,
                  releasesSourceRevision: releases?.sourceRevision,
              }),
    };
    const operations = useDeliveryOperations(client, currentAuthority);

    function actionState(
        _pullRequest: DeliveryPullRequest,
        action: DeliveryPullRequestActionCapability
    ): { readonly enabled: boolean; readonly reason?: string } {
        if (!pullRequestsFresh) {
            return {
                enabled: false,
                reason: "Fresh pull request authority is required.",
            };
        }
        if (!action.available) return { enabled: false };
        switch (action.action) {
            case "approve-review": {
                if (!pullRequests.reviewerCapability.available) {
                    return {
                        enabled: false,
                        reason: "The dedicated Raymond (rajohan) approval capability is unavailable.",
                    };
                }
                return { enabled: true };
            }
            case "merge": {
                return checkoutFresh && checkout.checkout.safeForDeploy
                    ? { enabled: true }
                    : {
                          enabled: false,
                          reason: "A fresh, safe production checkout is required.",
                      };
            }
            case "merge-and-deploy": {
                if (releasesFresh && releases.actionActive) {
                    return {
                        enabled: false,
                        reason: "Another Delivery action is active.",
                    };
                }
                return checkoutFresh && checkout.checkout.safeForDeploy && releasesFresh
                    ? { enabled: true }
                    : {
                          enabled: false,
                          reason: "Fresh checkout and activation revisions are required for merge and deploy.",
                      };
            }
            case "preview-start": {
                if (previewFresh && preview.actionActive) {
                    return {
                        enabled: false,
                        reason: "Another Delivery action is active.",
                    };
                }
                return previewFresh && preview.preview.controlsAvailable
                    ? { enabled: true }
                    : {
                          enabled: false,
                          reason: "A fresh controllable preview slot is required.",
                      };
            }
            default: {
                return { enabled: true };
            }
        }
    }

    function requestPullRequestAction(
        group: DeliveryPullRequestGroup,
        pullRequest: DeliveryPullRequest,
        action: DeliveryPullRequestActionCapability
    ): void {
        if (!pullRequestsFresh) return;
        const prompt = pullRequestOperationPrompt({
            action,
            ...(checkoutFresh ? { checkout: checkout.checkout } : {}),
            ...(previewFresh ? { preview: preview.preview } : {}),
            group,
            pullRequest,
            ...(releasesFresh ? { releases: releases.releases } : {}),
            reviewerRevision: pullRequests.reviewerCapability.revision,
            sourceRevision: pullRequests.sourceRevision,
        });
        if (prompt !== undefined) operations.open(prompt);
    }

    const deployAvailable =
        checkoutFresh &&
        releasesFresh &&
        !releases.actionActive &&
        checkout.checkout.safeForDeploy &&
        releases.releases.current !== undefined;
    let deployReason: string | undefined;
    if (!checkoutFresh || !releasesFresh) {
        deployReason = "Fresh checkout and activation revisions are required.";
    } else if (releases.actionActive) {
        deployReason = "Another Delivery action is active.";
    } else if (!checkout.checkout.safeForDeploy) {
        deployReason = "The production checkout must be ready, clean, and on main.";
    } else if (releases.releases.current === undefined) {
        deployReason = "An active managed release is required before deployment.";
    }

    function requestDeploy(): void {
        if (
            !checkoutFresh ||
            !releasesFresh ||
            availableCheckout === undefined ||
            availableReleases === undefined
        )
            return;
        operations.open(
            deployMainPrompt(
                availableCheckout.checkout,
                availableCheckout.sourceRevision,
                availableReleases.releases
            )
        );
    }

    return (
        <div className="space-y-4">
            <div className="space-y-4">
                {operations.result === undefined ? null : (
                    <Card aria-labelledby="delivery-operation-result-heading">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                            <div>
                                <Heading id="delivery-operation-result-heading" level={2}>
                                    Delivery operation queued
                                </Heading>
                                <Text className="mt-1" tone="muted">
                                    The API accepted {operations.result.operation}.
                                    Runtime success is not assumed.
                                </Text>
                                <code className="text-primary-400 mt-2 block text-xs wrap-anywhere">
                                    {operations.result.jobRunId}
                                </code>
                            </div>
                            <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto">
                                <ActionLink
                                    className="w-full justify-center sm:w-auto"
                                    search={{ runId: operations.result.jobRunId }}
                                    size="sm"
                                    to="/jobs"
                                    variant="primary"
                                >
                                    <Icon icon={ExternalLinkIcon} size="sm" />
                                    View job
                                </ActionLink>
                                <Button
                                    className="w-full sm:w-auto"
                                    onClick={operations.dismissResult}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <Icon icon={X} size="sm" />
                                    Dismiss
                                </Button>
                            </div>
                        </div>
                    </Card>
                )}
                {operations.error !== undefined && operations.pending === undefined ? (
                    <Alert message={operations.error} />
                ) : null}
                {retainedReads.length === 0 ? null : (
                    <Alert
                        action={
                            <Button
                                busy={retainedReadsFetching}
                                onClick={retryRetainedReads}
                                size="sm"
                                variant="secondary"
                            >
                                Try again
                            </Button>
                        }
                        focusOnError={false}
                        message={`The latest Delivery refresh did not complete. Retained data is shown for ${retainedReads.join(", ")}. Consequential controls require fresh data.`}
                        variant="warning"
                    />
                )}

                <DeliveryReadRegion
                    error={releasesQuery.error}
                    fetching={releasesQuery.isFetching}
                    headingId="delivery-releases-heading"
                    loading={releasesQuery.isPending}
                    onRetry={() => void releasesQuery.refetch()}
                    showRetainedFeedback={false}
                    state={releases?.state}
                    title="Production releases"
                    titleIcon={Rocket}
                >
                    {availableReleases === undefined ? null : (
                        <ProductionReleasesPanel
                            busy={operations.busy}
                            checkout={
                                checkoutFresh ? availableCheckout?.checkout : undefined
                            }
                            checkoutError={
                                checkoutQuery.data === undefined &&
                                checkoutQuery.error !== null
                                    ? deliveryFailureMessage(checkoutQuery.error)
                                    : undefined
                            }
                            checkoutRetryBusy={checkoutQuery.isFetching}
                            deployAvailable={deployAvailable}
                            deployReason={deployReason}
                            onDeploy={requestDeploy}
                            onRetryCheckout={
                                checkoutQuery.data === undefined &&
                                checkoutQuery.error !== null
                                    ? () => void checkoutQuery.refetch()
                                    : undefined
                            }
                            onRollback={() => {
                                if (!releasesFresh) return;
                                const prompt = rollbackReleasePrompt(
                                    availableReleases.releases,
                                    availableReleases.sourceRevision
                                );
                                if (prompt !== undefined) operations.open(prompt);
                            }}
                            releases={availableReleases.releases}
                            releasesFresh={releasesFresh}
                        />
                    )}
                </DeliveryReadRegion>

                <DeliveryReadRegion
                    error={previewQuery.error}
                    fetching={previewQuery.isFetching}
                    headingId="delivery-preview-heading"
                    loading={previewQuery.isPending}
                    onRetry={() => void previewQuery.refetch()}
                    showRetainedFeedback={false}
                    state={preview?.state}
                    title="Pull request preview"
                    visuallyHiddenTitle
                >
                    {availablePreview === undefined ? null : (
                        <PreviewPanel
                            busy={operations.busy}
                            controlsFresh={previewFresh && !availablePreview.actionActive}
                            onStop={() => {
                                const prompt = stopPreviewPrompt(
                                    availablePreview.preview,
                                    availablePreview.sourceRevision
                                );
                                if (prompt !== undefined) operations.open(prompt);
                            }}
                            preview={availablePreview.preview}
                        />
                    )}
                </DeliveryReadRegion>

                <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22.5rem]">
                    <DeliveryReadRegion
                        error={
                            pullRequestsBrowserRetained ? null : pullRequestsQuery.error
                        }
                        fetching={pullRequestsQuery.isFetching}
                        headingId="delivery-pull-requests-heading"
                        loading={pullRequestsQuery.isPending}
                        onRetry={() => void pullRequestsQuery.refetch()}
                        showRetainedFeedback={false}
                        state={pullRequests?.state}
                        title="Pull requests"
                        visuallyHiddenTitle
                    >
                        {availablePullRequests === undefined ? null : (
                            <PullRequestBrowser
                                actionState={actionState}
                                busy={operations.busy}
                                groups={availablePullRequests.groups}
                                onAction={requestPullRequestAction}
                                preview={availablePreview?.preview}
                            />
                        )}
                    </DeliveryReadRegion>

                    <div
                        className={
                            (availablePullRequests?.groups.length ?? 0) > 0
                                ? "xl:pt-15"
                                : undefined
                        }
                    >
                        <DeliveryReadRegion
                            error={deploymentsQuery.error}
                            fetching={deploymentsQuery.isFetching}
                            headingId="delivery-deployments-heading"
                            loading={deploymentsQuery.isPending}
                            onRetry={() => void deploymentsQuery.refetch()}
                            showRetainedFeedback={false}
                            state={deployments?.state}
                            title="Recent Delivery jobs"
                            visuallyHiddenTitle
                        >
                            {deployments?.state === "fresh" ? (
                                <DeliveryJobsPanel
                                    deployments={deployments.deployments}
                                />
                            ) : null}
                        </DeliveryReadRegion>
                    </div>
                </div>
            </div>
            <ConfirmModal
                busy={operations.busy}
                confirmDisabled={!operations.current}
                confirmLabel={operations.pending?.confirmLabel}
                danger={operations.pending?.danger}
                description={
                    operations.pending?.description ?? "No Delivery action is selected."
                }
                error={
                    operations.current
                        ? operations.error
                        : "Delivery state changed. Reopen this confirmation."
                }
                onCancel={operations.close}
                onConfirm={() => void operations.confirm()}
                open={operations.pending !== undefined}
                title={operations.pending?.title ?? "Confirm Delivery action"}
            />
        </div>
    );
}
