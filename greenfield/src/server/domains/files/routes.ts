import { TRPCError } from "@trpc/server";

import {
    getWorkspaceFileWriteStatusInputSchema,
    listWorkspaceFileRootsInputSchema,
    listWorkspaceFileRootsOutputSchema,
    listWorkspaceFilesInputSchema,
    listWorkspaceFilesOutputSchema,
    prepareWorkspaceFileContentInputSchema,
    prepareWorkspaceFileUploadInputSchema,
    prepareWorkspaceFileWriteInputSchema,
    workspaceFileContentTicketSchema,
    workspaceFileUploadTicketSchema,
    workspaceFileWriteStatusSchema,
} from "../../../contracts/files.ts";
import { appendClearedDashboardSessionCookie } from "../../rawHttp/sessionCookie.ts";
import type { RequestContext } from "../../trpc/context.ts";
import {
    authenticationPolicyError,
    sessionCapabilityProcedure,
} from "../../trpc/trpc.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";
import { WorkspaceFileError } from "./errors.ts";
import type { WorkspaceFileActor, WorkspaceFilesService } from "./service.ts";

export interface WorkspaceFileRecentAuthenticationAccess {
    readonly authorizeRecentMfa: (
        identity: AuthenticatedBrowserIdentity
    ) =>
        | "authorized"
        | "mfa-enrollment-required"
        | "session-changed"
        | "step-up-required";
}

interface WorkspaceFileRequestPorts {
    readonly workspaceFileRecentAuthenticationAccess?: WorkspaceFileRecentAuthenticationAccess;
    readonly workspaceFilesService?: WorkspaceFilesService;
}

function service(context: RequestContext): WorkspaceFilesService {
    const candidate = (context as RequestContext & WorkspaceFileRequestPorts)
        .workspaceFilesService;
    if (candidate === undefined) {
        throw new WorkspaceFileError("unavailable");
    }
    return candidate;
}

function actor(identity: AuthenticatedBrowserIdentity): WorkspaceFileActor {
    return Object.freeze({
        authenticatorId: identity.sessionId,
        id: identity.userId,
    });
}

function authorizeWrite(
    context: RequestContext & { readonly sessionIdentity: AuthenticatedBrowserIdentity }
): void {
    const access =
        (context as RequestContext & WorkspaceFileRequestPorts)
            .workspaceFileRecentAuthenticationAccess ?? context.authenticationLifecycle;
    switch (access.authorizeRecentMfa(context.sessionIdentity)) {
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

function throwFailure(
    error: unknown,
    options: { readonly capacityIsRateLimit?: boolean } = {}
): never {
    if (!(error instanceof WorkspaceFileError)) throw error;
    switch (error.reason) {
        case "access-denied": {
            throw new TRPCError({
                cause: error,
                code: "FORBIDDEN",
                message: "Workspace file access is not permitted",
            });
        }
        case "capacity": {
            throw new TRPCError({
                cause: error,
                code: options.capacityIsRateLimit
                    ? "TOO_MANY_REQUESTS"
                    : "SERVICE_UNAVAILABLE",
                message: "Workspace file capacity is temporarily unavailable",
            });
        }
        case "conflict": {
            throw new TRPCError({
                cause: error,
                code: "CONFLICT",
                message: "Workspace file state changed",
            });
        }
        case "directory-too-large":
        case "invalid-input":
        case "not-file":
        case "too-large": {
            throw new TRPCError({
                cause: error,
                code: "BAD_REQUEST",
                message: "Workspace file request is invalid",
            });
        }
        case "expired":
        case "not-found": {
            throw new TRPCError({
                cause: error,
                code: "NOT_FOUND",
                message: "Workspace file resource was not found",
            });
        }
        case "unavailable": {
            throw new TRPCError({
                cause: error,
                code: "SERVICE_UNAVAILABLE",
                message: "Workspace files are temporarily unavailable",
            });
        }
    }
}

const readProcedure = sessionCapabilityProcedure("files:read");
const writeProcedure = sessionCapabilityProcedure("files:write");

/** Session-only metadata reads and recent-MFA upload reservations. */
export const workspaceFileRoutes = {
    getWriteStatus: readProcedure
        .input(getWorkspaceFileWriteStatusInputSchema)
        .output(workspaceFileWriteStatusSchema)
        .query(async ({ ctx, input, signal }) => {
            try {
                return await service(ctx).getWriteStatus(
                    actor(ctx.sessionIdentity),
                    input.ticketId,
                    signal
                );
            } catch (error) {
                return throwFailure(error);
            }
        }),
    list: readProcedure
        .input(listWorkspaceFilesInputSchema)
        .output(listWorkspaceFilesOutputSchema)
        .query(async ({ ctx, input, signal }) => {
            try {
                return await service(ctx).list(actor(ctx.sessionIdentity), input, signal);
            } catch (error) {
                return throwFailure(error);
            }
        }),
    listRoots: readProcedure
        .input(listWorkspaceFileRootsInputSchema)
        .output(listWorkspaceFileRootsOutputSchema)
        .query(async ({ ctx, signal }) => {
            try {
                return await service(ctx).listRoots(actor(ctx.sessionIdentity), signal);
            } catch (error) {
                return throwFailure(error);
            }
        }),
    prepareContent: readProcedure
        .input(prepareWorkspaceFileContentInputSchema)
        .output(workspaceFileContentTicketSchema)
        .query(async ({ ctx, input, signal }) => {
            try {
                return await service(ctx).prepareContent(
                    actor(ctx.sessionIdentity),
                    input,
                    signal
                );
            } catch (error) {
                return throwFailure(error);
            }
        }),
    prepareUpload: writeProcedure
        .input(prepareWorkspaceFileUploadInputSchema)
        .output(workspaceFileUploadTicketSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeWrite(ctx);
            try {
                return await service(ctx).prepareUpload(
                    actor(ctx.sessionIdentity),
                    input,
                    signal
                );
            } catch (error) {
                return throwFailure(error, { capacityIsRateLimit: true });
            }
        }),
    prepareWrite: writeProcedure
        .input(prepareWorkspaceFileWriteInputSchema)
        .output(workspaceFileUploadTicketSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeWrite(ctx);
            try {
                return await service(ctx).prepareWrite(
                    actor(ctx.sessionIdentity),
                    input,
                    signal
                );
            } catch (error) {
                return throwFailure(error, { capacityIsRateLimit: true });
            }
        }),
};
