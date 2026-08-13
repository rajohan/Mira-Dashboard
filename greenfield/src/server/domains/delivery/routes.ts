import { TRPCError } from "@trpc/server";

import {
    deliveryApprovePullRequestInputSchema,
    deliveryApproveReviewInputSchema,
    deliveryCreatePullRequestStackInputSchema,
    deliveryDeployInputSchema,
    deliveryDeploymentsResultSchema,
    deliveryGetPreviewInputSchema,
    deliveryGetProductionCheckoutInputSchema,
    deliveryGetReleasesInputSchema,
    deliveryListDeploymentsInputSchema,
    deliveryListPullRequestsInputSchema,
    deliveryPreviewResultSchema,
    deliveryProductionCheckoutResultSchema,
    deliveryPullRequestsResultSchema,
    deliveryRejectPullRequestInputSchema,
    deliveryReleasesResultSchema,
    deliveryRequestOperationResultSchema,
    deliveryRollbackReleaseInputSchema,
    deliveryStartPreviewInputSchema,
    deliveryStopPreviewInputSchema,
    deliveryUpdateBranchInputSchema,
} from "../../../contracts/delivery.ts";
import { appendClearedDashboardSessionCookie } from "../../rawHttp/sessionCookie.ts";
import type { RequestContext } from "../../trpc/context.ts";
import {
    authenticationPolicyError,
    operationOutcomeUnknownError,
    router,
    sessionCapabilityProcedure,
} from "../../trpc/trpc.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";
import { sessionActor } from "../security/authenticationSession.ts";
import {
    type DeliveryControlContext,
    type DeliveryService,
    DeliveryServiceError,
} from "./service.ts";

function service(context: RequestContext): DeliveryService {
    const candidate = context.deliveryService;
    if (candidate === undefined) throw new DeliveryServiceError("unavailable");
    return candidate;
}

function authorizeControl(
    context: RequestContext & {
        readonly sessionIdentity: AuthenticatedBrowserIdentity;
    }
): void {
    const status = context.authenticationLifecycle.authorizeRecentMfa(
        context.sessionIdentity
    );
    switch (status) {
        case "authorized": {
            return;
        }
        case "mfa-enrollment-required": {
            throw authenticationPolicyError(
                "mfa_enrollment_required",
                "Multi-factor authentication enrollment is required"
            );
        }
        case "step-up-required": {
            throw authenticationPolicyError(
                "step_up_required",
                "Recent multi-factor authentication is required"
            );
        }
        case "session-changed": {
            appendClearedDashboardSessionCookie(context.responseHeaders);
            throw new TRPCError({
                code: "UNAUTHORIZED",
                message: "Authentication state changed; sign in again",
            });
        }
    }
}

function controlContext(
    context: RequestContext & {
        readonly sessionIdentity: AuthenticatedBrowserIdentity;
    }
): DeliveryControlContext {
    return {
        actor: sessionActor(context.sessionIdentity),
        reauthorize: () => authorizeControl(context),
        requestId: context.requestId,
    };
}

function throwServiceFailure(error: unknown): never {
    if (!(error instanceof DeliveryServiceError)) throw error;
    switch (error.reason) {
        case "conflict": {
            throw new TRPCError({
                cause: error,
                code: "CONFLICT",
                message: "Delivery state changed; reopen this confirmation",
            });
        }
        case "not-found": {
            throw new TRPCError({
                cause: error,
                code: "NOT_FOUND",
                message: "Delivery target was not found",
            });
        }
        case "unknown-outcome": {
            throw operationOutcomeUnknownError(
                "Delivery operation queue outcome could not be confirmed"
            );
        }
        case "audit-unavailable":
        case "unavailable": {
            throw new TRPCError({
                cause: error,
                code: "SERVICE_UNAVAILABLE",
                message: "Delivery is temporarily unavailable",
            });
        }
    }
}

const readProcedure = sessionCapabilityProcedure("delivery:read");
const controlProcedure = sessionCapabilityProcedure("delivery:write");

/** Five independent reads and nine recent-MFA exact Delivery mutations. */
export const deliveryRoutes = {
    approvePullRequest: controlProcedure
        .input(deliveryApprovePullRequestInputSchema)
        .output(deliveryRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).approvePullRequest(
                    input,
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    approveReview: controlProcedure
        .input(deliveryApproveReviewInputSchema)
        .output(deliveryRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).approveReview(
                    input,
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    createPullRequestStack: controlProcedure
        .input(deliveryCreatePullRequestStackInputSchema)
        .output(deliveryRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).createPullRequestStack(
                    input,
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    deploy: controlProcedure
        .input(deliveryDeployInputSchema)
        .output(deliveryRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).deploy(input, controlContext(ctx), signal);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    getPreview: readProcedure
        .input(deliveryGetPreviewInputSchema)
        .output(deliveryPreviewResultSchema)
        .query(({ ctx }) => {
            try {
                return service(ctx).getPreview();
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    getProductionCheckout: readProcedure
        .input(deliveryGetProductionCheckoutInputSchema)
        .output(deliveryProductionCheckoutResultSchema)
        .query(({ ctx }) => {
            try {
                return service(ctx).getProductionCheckout();
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    getReleases: readProcedure
        .input(deliveryGetReleasesInputSchema)
        .output(deliveryReleasesResultSchema)
        .query(({ ctx }) => {
            try {
                return service(ctx).getReleases();
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    listDeployments: readProcedure
        .input(deliveryListDeploymentsInputSchema)
        .output(deliveryDeploymentsResultSchema)
        .query(({ ctx }) => {
            try {
                return service(ctx).listDeployments();
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    listPullRequests: readProcedure
        .input(deliveryListPullRequestsInputSchema)
        .output(deliveryPullRequestsResultSchema)
        .query(({ ctx }) => {
            try {
                return service(ctx).listPullRequests();
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    rejectPullRequest: controlProcedure
        .input(deliveryRejectPullRequestInputSchema)
        .output(deliveryRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).rejectPullRequest(
                    input,
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    rollbackRelease: controlProcedure
        .input(deliveryRollbackReleaseInputSchema)
        .output(deliveryRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).rollbackRelease(
                    input,
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    startPreview: controlProcedure
        .input(deliveryStartPreviewInputSchema)
        .output(deliveryRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).startPreview(
                    input,
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    stopPreview: controlProcedure
        .input(deliveryStopPreviewInputSchema)
        .output(deliveryRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).stopPreview(input, controlContext(ctx), signal);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    updateBranch: controlProcedure
        .input(deliveryUpdateBranchInputSchema)
        .output(deliveryRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).updateBranch(
                    input,
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
};

export const deliveryProcedureNames = Object.freeze(Object.keys(deliveryRoutes));
export const deliveryRouter = router(deliveryRoutes);
