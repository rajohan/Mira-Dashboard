import { TRPCError } from "@trpc/server";

import {
    backupClearKopiaAttentionInputSchema,
    backupClearWalgAttentionInputSchema,
    backupRequestOperationResultSchema,
    backupRunKopiaInputSchema,
    backupRunWalgInputSchema,
    backupStatusInputSchema,
    kopiaBackupStatusSchema,
    walgBackupStatusSchema,
} from "../../../contracts/backups.ts";
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
    type BackupControlContext,
    type BackupService,
    BackupServiceError,
} from "./service.ts";

function service(context: RequestContext): BackupService {
    if (context.backupService === undefined) {
        throw new BackupServiceError("unavailable");
    }
    return context.backupService;
}

function authorizeControl(
    context: RequestContext & {
        readonly sessionIdentity: AuthenticatedBrowserIdentity;
    }
): void {
    const status = context.authenticationLifecycle.authorizeRecentMfa(
        context.sessionIdentity
    );
    if (status === "authorized") return;
    if (status === "mfa-enrollment-required") {
        throw authenticationPolicyError(
            "mfa_enrollment_required",
            "Multi-factor authentication enrollment is required"
        );
    }
    if (status === "step-up-required") {
        throw authenticationPolicyError(
            "step_up_required",
            "Recent multi-factor authentication is required"
        );
    }
    appendClearedDashboardSessionCookie(context.responseHeaders);
    throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Authentication state changed; sign in again",
    });
}

function controlContext(
    context: RequestContext & {
        readonly sessionIdentity: AuthenticatedBrowserIdentity;
    }
): BackupControlContext {
    return {
        actor: sessionActor(context.sessionIdentity),
        reauthorize: () => authorizeControl(context),
        requestId: context.requestId,
    };
}

function throwFailure(error: unknown): never {
    if (!(error instanceof BackupServiceError)) throw error;
    if (error.reason === "conflict") {
        throw new TRPCError({
            cause: error,
            code: "CONFLICT",
            message: "Backup state changed; refresh before retrying",
        });
    }
    if (error.reason === "not-found") {
        throw new TRPCError({
            cause: error,
            code: "NOT_FOUND",
            message: "Backup attention run was not found",
        });
    }
    if (error.reason === "unknown-outcome") {
        throw operationOutcomeUnknownError("Backup queue outcome could not be confirmed");
    }
    throw new TRPCError({
        cause: error,
        code: "SERVICE_UNAVAILABLE",
        message: "Backup operations are temporarily unavailable",
    });
}

const readProcedure = sessionCapabilityProcedure("backups:read");
const controlProcedure = sessionCapabilityProcedure("backups:write");

export const backupRoutes = {
    getKopiaStatus: readProcedure
        .input(backupStatusInputSchema)
        .output(kopiaBackupStatusSchema)
        .query(({ ctx }) => service(ctx).getKopiaStatus()),
    getWalgStatus: readProcedure
        .input(backupStatusInputSchema)
        .output(walgBackupStatusSchema)
        .query(({ ctx }) => service(ctx).getWalgStatus()),
    clearKopiaAttention: controlProcedure
        .input(backupClearKopiaAttentionInputSchema)
        .output(backupRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).requestOperation(
                    { ...input, operation: "clear-attention", type: "kopia" },
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwFailure(error);
            }
        }),
    runKopia: controlProcedure
        .input(backupRunKopiaInputSchema)
        .output(backupRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).requestOperation(
                    { ...input, operation: "run", type: "kopia" },
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwFailure(error);
            }
        }),
    clearWalgAttention: controlProcedure
        .input(backupClearWalgAttentionInputSchema)
        .output(backupRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).requestOperation(
                    { ...input, operation: "clear-attention", type: "walg" },
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwFailure(error);
            }
        }),
    runWalg: controlProcedure
        .input(backupRunWalgInputSchema)
        .output(backupRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).requestOperation(
                    { ...input, operation: "run", type: "walg" },
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwFailure(error);
            }
        }),
};

export const backupProcedureNames = Object.freeze(Object.keys(backupRoutes));
export const backupRouter = router(backupRoutes);
