import type { TRPCRequestOptions } from "@trpc/client";

import type {
    DeliveryDeploymentsResult,
    DeliveryPreviewResult,
    DeliveryProductionCheckoutResult,
    DeliveryPullRequestsResult,
    DeliveryReleasesResult,
    DeliveryRequestOperationInput,
    DeliveryRequestOperationResult,
} from "../../contracts/delivery.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

export type DeliveryApprovePullRequestInput = Extract<
    DeliveryRequestOperationInput,
    { readonly operation: "merge-pull-request" }
>;
export type DeliveryApproveReviewInput = Extract<
    DeliveryRequestOperationInput,
    { readonly operation: "approve-review" }
>;
export type DeliveryCreatePullRequestStackInput = Extract<
    DeliveryRequestOperationInput,
    { readonly operation: "create-pull-request-stack" }
>;
export type DeliveryDeployInput = Extract<
    DeliveryRequestOperationInput,
    { readonly operation: "deploy" }
>;
export type DeliveryRejectPullRequestInput = Extract<
    DeliveryRequestOperationInput,
    { readonly operation: "reject-pull-request" }
>;
export type DeliveryRollbackReleaseInput = Extract<
    DeliveryRequestOperationInput,
    { readonly operation: "rollback-release" }
>;
export type DeliveryStartPreviewInput = Extract<
    DeliveryRequestOperationInput,
    { readonly operation: "start-preview" }
>;
export type DeliveryStopPreviewInput = Extract<
    DeliveryRequestOperationInput,
    { readonly operation: "stop-preview" }
>;
export type DeliveryUpdateBranchInput = Extract<
    DeliveryRequestOperationInput,
    { readonly operation: "update-branch" }
>;

/** Browser-owned procedure surface for the Delivery vertical. */
export interface DeliveryClient {
    readonly mutation: {
        (
            name: "delivery.approvePullRequest",
            input: DeliveryApprovePullRequestInput,
            options?: TRPCRequestOptions
        ): Promise<DeliveryRequestOperationResult>;
        (
            name: "delivery.startPreview",
            input: DeliveryStartPreviewInput,
            options?: TRPCRequestOptions
        ): Promise<DeliveryRequestOperationResult>;
        (
            name: "delivery.stopPreview",
            input: DeliveryStopPreviewInput,
            options?: TRPCRequestOptions
        ): Promise<DeliveryRequestOperationResult>;
        (
            name: "delivery.rejectPullRequest",
            input: DeliveryRejectPullRequestInput,
            options?: TRPCRequestOptions
        ): Promise<DeliveryRequestOperationResult>;
        (
            name: "delivery.approveReview",
            input: DeliveryApproveReviewInput,
            options?: TRPCRequestOptions
        ): Promise<DeliveryRequestOperationResult>;
        (
            name: "delivery.updateBranch",
            input: DeliveryUpdateBranchInput,
            options?: TRPCRequestOptions
        ): Promise<DeliveryRequestOperationResult>;
        (
            name: "delivery.deploy",
            input: DeliveryDeployInput,
            options?: TRPCRequestOptions
        ): Promise<DeliveryRequestOperationResult>;
        (
            name: "delivery.rollbackRelease",
            input: DeliveryRollbackReleaseInput,
            options?: TRPCRequestOptions
        ): Promise<DeliveryRequestOperationResult>;
        (
            name: "delivery.createPullRequestStack",
            input: DeliveryCreatePullRequestStackInput,
            options?: TRPCRequestOptions
        ): Promise<DeliveryRequestOperationResult>;
    };
    readonly query: {
        (
            name: "delivery.listPullRequests",
            input: Record<string, never>,
            options?: TRPCRequestOptions
        ): Promise<DeliveryPullRequestsResult>;
        (
            name: "delivery.listDeployments",
            input: Record<string, never>,
            options?: TRPCRequestOptions
        ): Promise<DeliveryDeploymentsResult>;
        (
            name: "delivery.getPreview",
            input: Record<string, never>,
            options?: TRPCRequestOptions
        ): Promise<DeliveryPreviewResult>;
        (
            name: "delivery.getProductionCheckout",
            input: Record<string, never>,
            options?: TRPCRequestOptions
        ): Promise<DeliveryProductionCheckoutResult>;
        (
            name: "delivery.getReleases",
            input: Record<string, never>,
            options?: TRPCRequestOptions
        ): Promise<DeliveryReleasesResult>;
    };
}

/** @returns A Delivery-only view of the shared contract-validating tRPC client. */
export function deliveryClient(client: DashboardTrpcClient): DeliveryClient {
    return Object.freeze({
        mutation: client.mutation.bind(client) as DeliveryClient["mutation"],
        query: client.query.bind(client) as DeliveryClient["query"],
    });
}
