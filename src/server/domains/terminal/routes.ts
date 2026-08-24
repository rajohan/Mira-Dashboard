import { TRPCError } from "@trpc/server";

import {
    getActiveTerminalSessionOutputSchema,
    getTerminalRuntimeInputSchema,
    prepareTerminalResumeInputSchema,
    prepareTerminalSessionInputSchema,
    terminalConnectionTicketSchema,
    terminalRuntimeSchema,
    terminateTerminalSessionInputSchema,
    terminateTerminalSessionOutputSchema,
} from "../../../contracts/terminal.ts";
import { appendClearedDashboardSessionCookie } from "../../rawHttp/sessionCookie.ts";
import type { RequestContext } from "../../trpc/context.ts";
import {
    authenticationPolicyError,
    sessionCapabilityProcedure,
} from "../../trpc/trpc.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";
import { TerminalServiceError } from "./errors.ts";
import type { TerminalRecentAuthenticationAccess } from "./mutationAccess.ts";
import type { TerminalService } from "./service.ts";

interface TerminalRequestPorts {
    readonly terminalRecentAuthenticationAccess?: TerminalRecentAuthenticationAccess;
    readonly terminalService?: TerminalService;
}

function service(context: RequestContext): TerminalService {
    const candidate = (context as RequestContext & TerminalRequestPorts).terminalService;
    if (candidate === undefined) {
        throw new TerminalServiceError("unavailable");
    }
    return candidate;
}

function authorize(
    context: RequestContext & { readonly sessionIdentity: AuthenticatedBrowserIdentity }
): void {
    const access =
        (context as RequestContext & TerminalRequestPorts)
            .terminalRecentAuthenticationAccess ?? context.authenticationLifecycle;
    const status = access.authorizeRecentMfa(context.sessionIdentity);
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

function actor(identity: AuthenticatedBrowserIdentity) {
    return Object.freeze({
        authenticatorId: identity.sessionId,
        id: identity.userId,
    });
}

function auditContext(
    context: RequestContext & { readonly sessionIdentity: AuthenticatedBrowserIdentity }
) {
    return Object.freeze({
        actor: {
            ...actor(context.sessionIdentity),
            kind: "user" as const,
        },
        requestId: context.requestId,
    });
}

function throwServiceFailure(error: unknown): never {
    if (!(error instanceof TerminalServiceError)) throw error;
    switch (error.reason) {
        case "audit-unavailable":
        case "unavailable": {
            throw new TRPCError({
                cause: error,
                code: "SERVICE_UNAVAILABLE",
                message: "Interactive terminal is temporarily unavailable",
            });
        }
        case "capacity": {
            throw new TRPCError({
                cause: error,
                code: "TOO_MANY_REQUESTS",
                message: "Interactive terminal capacity is currently exhausted",
            });
        }
        case "conflict": {
            throw new TRPCError({
                cause: error,
                code: "CONFLICT",
                message: "Interactive terminal state changed",
            });
        }
        case "gone":
        case "not-found": {
            throw new TRPCError({
                cause: error,
                code: "NOT_FOUND",
                message: "Interactive terminal session was not found",
            });
        }
        case "invalid-input": {
            throw new TRPCError({
                cause: error,
                code: "BAD_REQUEST",
                message: "Interactive terminal request is invalid",
            });
        }
    }
}

const readProcedure = sessionCapabilityProcedure("terminal:read");
const writeProcedure = sessionCapabilityProcedure("terminal:write");

/** Session-only, recent-MFA interactive terminal lifecycle routes. */
export const terminalRoutes = {
    getActiveSession: readProcedure
        .input(getTerminalRuntimeInputSchema)
        .output(getActiveTerminalSessionOutputSchema)
        .query(async ({ ctx, signal }) => {
            authorize(ctx);
            try {
                return await service(ctx).getActiveSession(
                    actor(ctx.sessionIdentity),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    getRuntime: readProcedure
        .input(getTerminalRuntimeInputSchema)
        .output(terminalRuntimeSchema)
        .query(({ ctx }) => {
            authorize(ctx);
            try {
                return service(ctx).getRuntime();
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    prepareResume: writeProcedure
        .input(prepareTerminalResumeInputSchema)
        .output(terminalConnectionTicketSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorize(ctx);
            try {
                return await service(ctx).prepareResume(
                    actor(ctx.sessionIdentity),
                    input,
                    auditContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    prepareSession: writeProcedure
        .input(prepareTerminalSessionInputSchema)
        .output(terminalConnectionTicketSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorize(ctx);
            try {
                return await service(ctx).prepareSession(
                    actor(ctx.sessionIdentity),
                    input,
                    auditContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    terminateSession: writeProcedure
        .input(terminateTerminalSessionInputSchema)
        .output(terminateTerminalSessionOutputSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorize(ctx);
            try {
                return await service(ctx).terminateSession(
                    actor(ctx.sessionIdentity),
                    input.sessionId,
                    auditContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
};
