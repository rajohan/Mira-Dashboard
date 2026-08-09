import { TRPCError } from "@trpc/server";

import {
    deleteOpenClawCronInputSchema,
    deleteOpenClawCronResultSchema,
    getOpenClawCronInputSchema,
    getOpenClawCronResultSchema,
    listOpenClawCronInputSchema,
    listOpenClawCronResultSchema,
    listOpenClawCronRunsInputSchema,
    listOpenClawCronRunsResultSchema,
    runOpenClawCronInputSchema,
    runOpenClawCronResultSchema,
    setOpenClawCronEnabledInputSchema,
    updateOpenClawCronInputSchema,
} from "../../../contracts/openClawCron.ts";
import type { ApplicationCapability } from "../../../contracts/security.ts";
import { appendClearedDashboardSessionCookie } from "../../rawHttp/sessionCookie.ts";
import type { RequestContext } from "../../trpc/context.ts";
import {
    authenticationPolicyError,
    operationOutcomeUnknownError,
    sessionProcedure,
} from "../../trpc/trpc.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";
import type { OpenClawCronMutationAccess } from "./mutationAccess.ts";
import type { OpenClawCronAuditContext } from "./operationAudit.ts";
import { type OpenClawCronService, OpenClawCronServiceError } from "./service.ts";

interface OpenClawCronContextPorts {
    readonly openClawCronMutationAccess?: OpenClawCronMutationAccess;
    readonly openClawCronService?: OpenClawCronService;
}

function isOpenClawCronService(value: unknown): value is OpenClawCronService {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<OpenClawCronService>;
    return (
        typeof candidate.delete === "function" &&
        typeof candidate.get === "function" &&
        typeof candidate.list === "function" &&
        typeof candidate.listRuns === "function" &&
        typeof candidate.reconcileExpired === "function" &&
        typeof candidate.run === "function" &&
        typeof candidate.setEnabled === "function" &&
        typeof candidate.update === "function"
    );
}

function openClawCronService(context: RequestContext): OpenClawCronService {
    const contextPorts = context as RequestContext & OpenClawCronContextPorts;
    if (isOpenClawCronService(contextPorts.openClawCronService)) {
        return contextPorts.openClawCronService;
    }
    throw new Error("Request context is missing the OpenClaw cron service");
}

function mutationAccess(context: RequestContext): OpenClawCronMutationAccess {
    const contextPorts = context as RequestContext & OpenClawCronContextPorts;
    return contextPorts.openClawCronMutationAccess ?? context.authenticationLifecycle;
}

function authorizeCapability(
    context: RequestContext,
    capability: ApplicationCapability
): void {
    if (
        context.authentication.kind !== "authenticated" ||
        !context.authentication.principal.capabilities.includes(capability)
    ) {
        throw new TRPCError({
            code: "FORBIDDEN",
            message: "Required application capability is not granted",
        });
    }
}

function authorizeMutation(
    context: RequestContext & {
        readonly sessionIdentity: AuthenticatedBrowserIdentity;
    }
): void {
    authorizeCapability(context, "jobs:write");
    const status = mutationAccess(context).authorizeRecentMfa(context.sessionIdentity);
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

function operator(identity: AuthenticatedBrowserIdentity) {
    return { id: identity.userId, kind: "user" } as const;
}

function operationAuditContext(
    context: RequestContext & {
        readonly sessionIdentity: AuthenticatedBrowserIdentity;
    }
): OpenClawCronAuditContext {
    return {
        actor: {
            authenticatorId: context.sessionIdentity.sessionId,
            id: context.sessionIdentity.userId,
            kind: "user",
        },
        requestId: context.requestId,
    };
}

function throwServiceFailure(error: unknown): never {
    if (!(error instanceof OpenClawCronServiceError)) throw error;
    switch (error.reason) {
        case "invalid-input": {
            throw new TRPCError({
                cause: error,
                code: "BAD_REQUEST",
                message: "OpenClaw cron request is invalid",
            });
        }
        case "conflict": {
            throw new TRPCError({
                cause: error,
                code: "CONFLICT",
                message: "OpenClaw cron state changed",
            });
        }
        case "not-found": {
            throw new TRPCError({
                cause: error,
                code: "NOT_FOUND",
                message: "OpenClaw cron job was not found",
            });
        }
        case "precondition-failed": {
            throw new TRPCError({
                cause: error,
                code: "PRECONDITION_FAILED",
                message: "OpenClaw cron control precondition failed",
            });
        }
        case "unknown-outcome": {
            throw operationOutcomeUnknownError(
                "OpenClaw cron outcome could not be confirmed"
            );
        }
        case "audit-unavailable":
        case "provider-data-invalid":
        case "provider-unavailable": {
            throw new TRPCError({
                cause: error,
                code: "SERVICE_UNAVAILABLE",
                message: "OpenClaw cron is temporarily unavailable",
            });
        }
    }
}

/** Session-only OpenClaw cron reads and explicitly recent-MFA-gated controls. */
export const openClawCronRoutes = {
    delete: sessionProcedure
        .input(deleteOpenClawCronInputSchema)
        .output(deleteOpenClawCronResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeMutation(ctx);
            try {
                return await openClawCronService(ctx).delete(
                    input,
                    operator(ctx.sessionIdentity),
                    signal,
                    operationAuditContext(ctx)
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    get: sessionProcedure
        .input(getOpenClawCronInputSchema)
        .output(getOpenClawCronResultSchema)
        .query(async ({ ctx, input, signal }) => {
            authorizeCapability(ctx, "jobs:read");
            try {
                return await openClawCronService(ctx).get(input, signal);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    list: sessionProcedure
        .input(listOpenClawCronInputSchema)
        .output(listOpenClawCronResultSchema)
        .query(async ({ ctx, input, signal }) => {
            authorizeCapability(ctx, "jobs:read");
            try {
                return await openClawCronService(ctx).list(input, signal);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    listRuns: sessionProcedure
        .input(listOpenClawCronRunsInputSchema)
        .output(listOpenClawCronRunsResultSchema)
        .query(async ({ ctx, input, signal }) => {
            authorizeCapability(ctx, "jobs:read");
            try {
                return await openClawCronService(ctx).listRuns(input, signal);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    run: sessionProcedure
        .input(runOpenClawCronInputSchema)
        .output(runOpenClawCronResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeMutation(ctx);
            try {
                return await openClawCronService(ctx).run(
                    input,
                    signal,
                    operationAuditContext(ctx)
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    setEnabled: sessionProcedure
        .input(setOpenClawCronEnabledInputSchema)
        .output(getOpenClawCronResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeMutation(ctx);
            try {
                return await openClawCronService(ctx).setEnabled(
                    input,
                    operator(ctx.sessionIdentity),
                    signal,
                    operationAuditContext(ctx)
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    update: sessionProcedure
        .input(updateOpenClawCronInputSchema)
        .output(getOpenClawCronResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeMutation(ctx);
            try {
                return await openClawCronService(ctx).update(
                    input,
                    signal,
                    operationAuditContext(ctx)
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
};
