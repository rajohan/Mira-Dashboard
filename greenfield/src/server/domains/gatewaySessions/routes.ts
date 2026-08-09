import { TRPCError } from "@trpc/server";

import {
    gatewaySessionActionInputSchema,
    gatewaySessionActionResultSchema,
    gatewaySessionDeleteInputSchema,
    listGatewaySessionsInputSchema,
    listGatewaySessionsResultSchema,
} from "../../../contracts/gatewaySessions.ts";
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
    GatewaySessionConflictError,
    GatewaySessionControlForbiddenError,
    GatewaySessionControlUnknownOutcomeError,
    GatewaySessionControlUnavailableError,
    GatewaySessionNotFoundError,
    GatewaySessionsUnavailableError,
} from "./errors.ts";
import type { GatewaySessionMutationAccess } from "./mutationAccess.ts";
import type { GatewaySessionsService } from "./service.ts";

interface GatewaySessionContextPorts {
    readonly gatewaySessionMutationAccess?: GatewaySessionMutationAccess;
    readonly gatewaySessionsService?: GatewaySessionsService;
}

function isGatewaySessionsService(value: unknown): value is GatewaySessionsService {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<GatewaySessionsService>;
    return (
        typeof candidate.compact === "function" &&
        typeof candidate.delete === "function" &&
        typeof candidate.list === "function" &&
        typeof candidate.reset === "function"
    );
}

function gatewaySessionsService(context: RequestContext): GatewaySessionsService {
    if (isGatewaySessionsService(context.gatewaySessionsService)) {
        return context.gatewaySessionsService;
    }
    throw new Error("Request context is missing the Gateway sessions service");
}

function gatewaySessionMutationAccess(
    context: RequestContext
): GatewaySessionMutationAccess {
    const contextPorts = context as RequestContext & GatewaySessionContextPorts;
    return contextPorts.gatewaySessionMutationAccess ?? context.authenticationLifecycle;
}

function authorizeGatewaySessionMutation(
    context: RequestContext & {
        readonly sessionIdentity: AuthenticatedBrowserIdentity;
    }
): void {
    const status = gatewaySessionMutationAccess(context).authorizeRecentMfa(
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

function throwGatewaySessionFailure(error: unknown): never {
    if (error instanceof GatewaySessionsUnavailableError) {
        throw new TRPCError({
            cause: error,
            code: "SERVICE_UNAVAILABLE",
            message: "Gateway sessions are temporarily unavailable",
        });
    }
    if (error instanceof GatewaySessionNotFoundError) {
        throw new TRPCError({
            cause: error,
            code: "NOT_FOUND",
            message: "Gateway session was not found",
        });
    }
    if (error instanceof GatewaySessionConflictError) {
        throw new TRPCError({
            cause: error,
            code: "CONFLICT",
            message: "Gateway session state changed",
        });
    }
    if (error instanceof GatewaySessionControlUnavailableError) {
        throw new TRPCError({
            cause: error,
            code: "SERVICE_UNAVAILABLE",
            message: "Gateway session control is temporarily unavailable",
        });
    }
    if (error instanceof GatewaySessionControlUnknownOutcomeError) {
        throw operationOutcomeUnknownError(
            "Gateway session control outcome could not be confirmed"
        );
    }
    if (error instanceof GatewaySessionControlForbiddenError) {
        throw new TRPCError({
            cause: error,
            code: "FORBIDDEN",
            message: "The primary Gateway session cannot be deleted",
        });
    }
    throw error;
}

const readProcedure = sessionCapabilityProcedure("gateway-sessions:read");
const controlProcedure = sessionCapabilityProcedure("gateway-sessions:write");

/** Session-only current OpenClaw session routes with recent-MFA controls. */
export const gatewaySessionRoutes = {
    compact: controlProcedure
        .input(gatewaySessionActionInputSchema)
        .output(gatewaySessionActionResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeGatewaySessionMutation(ctx);
            try {
                return await gatewaySessionsService(ctx).compact(
                    input,
                    {
                        actor: sessionActor(ctx.sessionIdentity),
                        requestId: ctx.requestId,
                    },
                    signal
                );
            } catch (error) {
                return throwGatewaySessionFailure(error);
            }
        }),
    delete: controlProcedure
        .input(gatewaySessionDeleteInputSchema)
        .output(gatewaySessionActionResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeGatewaySessionMutation(ctx);
            try {
                return await gatewaySessionsService(ctx).delete(
                    input,
                    {
                        actor: sessionActor(ctx.sessionIdentity),
                        requestId: ctx.requestId,
                    },
                    signal
                );
            } catch (error) {
                return throwGatewaySessionFailure(error);
            }
        }),
    list: readProcedure
        .input(listGatewaySessionsInputSchema)
        .output(listGatewaySessionsResultSchema)
        .query(async ({ ctx, input, signal }) => {
            try {
                return await gatewaySessionsService(ctx).list(input, signal);
            } catch (error) {
                return throwGatewaySessionFailure(error);
            }
        }),
    reset: controlProcedure
        .input(gatewaySessionActionInputSchema)
        .output(gatewaySessionActionResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeGatewaySessionMutation(ctx);
            try {
                return await gatewaySessionsService(ctx).reset(
                    input,
                    {
                        actor: sessionActor(ctx.sessionIdentity),
                        requestId: ctx.requestId,
                    },
                    signal
                );
            } catch (error) {
                return throwGatewaySessionFailure(error);
            }
        }),
};
