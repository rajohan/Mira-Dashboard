import { TRPCError } from "@trpc/server";

import {
    getServiceActionsStatusInputSchema,
    getServiceActionsStatusResultSchema,
    requestServiceActionInputSchema,
    requestServiceActionResultSchema,
} from "../../../contracts/serviceActions.ts";
import { appendClearedDashboardSessionCookie } from "../../rawHttp/sessionCookie.ts";
import type { RequestContext } from "../../trpc/context.ts";
import {
    authenticationPolicyError,
    operationOutcomeUnknownError,
    sessionCapabilityProcedure,
} from "../../trpc/trpc.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";
import { sessionActor } from "../security/authenticationSession.ts";
import {
    type ServiceActionControlContext,
    ServiceActionsServiceError,
} from "./service.ts";

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
): ServiceActionControlContext {
    return {
        actor: sessionActor(context.sessionIdentity),
        reauthorize: () => authorizeControl(context),
        requestId: context.requestId,
    };
}

function throwServiceFailure(error: unknown): never {
    if (!(error instanceof ServiceActionsServiceError)) throw error;
    switch (error.reason) {
        case "conflict": {
            throw new TRPCError({
                cause: error,
                code: "CONFLICT",
                message: "Service action request conflicts with an existing intent",
            });
        }
        case "unknown-outcome": {
            throw operationOutcomeUnknownError(
                "Service action queue outcome could not be confirmed"
            );
        }
        case "audit-unavailable":
        case "unavailable": {
            throw new TRPCError({
                cause: error,
                code: "SERVICE_UNAVAILABLE",
                message: "Service actions are temporarily unavailable",
            });
        }
    }
}

const readProcedure = sessionCapabilityProcedure("service-actions:read");
const controlProcedure = sessionCapabilityProcedure("service-actions:write");

/** Session-only fixed service-action status and recent-MFA queue controls. */
export const serviceActionsRoutes = {
    getStatus: readProcedure
        .input(getServiceActionsStatusInputSchema)
        .output(getServiceActionsStatusResultSchema)
        .query(async ({ ctx, signal }) => {
            try {
                return await ctx.serviceActionsService.getStatus(signal);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    request: controlProcedure
        .input(requestServiceActionInputSchema)
        .output(requestServiceActionResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await ctx.serviceActionsService.request(
                    input,
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
};
