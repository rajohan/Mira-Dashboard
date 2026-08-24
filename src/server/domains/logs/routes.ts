import { TRPCError } from "@trpc/server";

import {
    listLogSourcesOutputSchema,
    logMaintenanceStatusOutputSchema,
    logSnapshotOutputSchema,
    requestLogMaintenanceInputSchema,
    requestLogMaintenanceOutputSchema,
    searchLogsInputSchema,
    tailLogsInputSchema,
} from "../../../contracts/logs.ts";
import { emptyInputSchema } from "../../../contracts/system.ts";
import { appendClearedDashboardSessionCookie } from "../../rawHttp/sessionCookie.ts";
import type { RequestContext } from "../../trpc/context.ts";
import {
    authenticationPolicyError,
    sessionCapabilityProcedure,
    sessionProcedure,
} from "../../trpc/trpc.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";
import type { LogMaintenanceMutationAccess } from "./mutationAccess.ts";
import type { LogMaintenanceAuditContext } from "./operationAudit.ts";
import { type LogsService, LogsServiceError } from "./service.ts";

interface LogsContextPorts {
    readonly logMaintenanceMutationAccess?: LogMaintenanceMutationAccess;
    readonly logsService?: LogsService;
}

function service(context: RequestContext): LogsService {
    const candidate = (context as RequestContext & LogsContextPorts).logsService;
    if (candidate === undefined) throw new LogsServiceError("unavailable");
    return candidate;
}

function mutationAccess(context: RequestContext): LogMaintenanceMutationAccess {
    return (
        (context as RequestContext & LogsContextPorts).logMaintenanceMutationAccess ??
        context.authenticationLifecycle
    );
}

function authorizeWriteCapability(context: RequestContext): void {
    if (
        context.authentication.kind !== "authenticated" ||
        !context.authentication.principal.capabilities.includes("logs:write")
    ) {
        throw new TRPCError({
            code: "FORBIDDEN",
            message: "Required application capability is not granted",
        });
    }
}

function authorizeMaintenance(
    context: RequestContext & { readonly sessionIdentity: AuthenticatedBrowserIdentity }
): void {
    authorizeWriteCapability(context);
    switch (mutationAccess(context).authorizeRecentMfa(context.sessionIdentity)) {
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

function auditContext(
    context: RequestContext & { readonly sessionIdentity: AuthenticatedBrowserIdentity }
): LogMaintenanceAuditContext {
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
    if (!(error instanceof LogsServiceError)) throw error;
    if (error.reason === "not-found") {
        throw new TRPCError({
            cause: error,
            code: "NOT_FOUND",
            message: "Log source was not found",
        });
    }
    throw new TRPCError({
        cause: error,
        code: "SERVICE_UNAVAILABLE",
        message: "Logs are temporarily unavailable",
    });
}

const readProcedure = sessionCapabilityProcedure("logs:read");

/** Named-source reads and one recent-MFA worker-queue maintenance request. */
export const logRoutes = {
    listSources: readProcedure
        .input(emptyInputSchema)
        .output(listLogSourcesOutputSchema)
        .query(async ({ ctx }) => {
            try {
                return await service(ctx).listSources();
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    maintenanceStatus: readProcedure
        .input(emptyInputSchema)
        .output(logMaintenanceStatusOutputSchema)
        .query(async ({ ctx, signal }) => {
            try {
                return await service(ctx).maintenanceStatus(signal);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    requestMaintenance: sessionProcedure
        .input(requestLogMaintenanceInputSchema)
        .output(requestLogMaintenanceOutputSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeMaintenance(ctx);
            try {
                return await service(ctx).requestMaintenance(
                    input,
                    auditContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    search: readProcedure
        .input(searchLogsInputSchema)
        .output(logSnapshotOutputSchema)
        .query(async ({ ctx, input }) => {
            try {
                return await service(ctx).search(input);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    tail: readProcedure
        .input(tailLogsInputSchema)
        .output(logSnapshotOutputSchema)
        .query(async ({ ctx, input }) => {
            try {
                return await service(ctx).tail(input);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
};
