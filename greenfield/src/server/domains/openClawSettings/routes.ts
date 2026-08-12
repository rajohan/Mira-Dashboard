import { TRPCError } from "@trpc/server";

import {
    getOpenClawConfigurationInputSchema,
    listOpenClawSkillsInputSchema,
    listOpenClawSkillsResultSchema,
    openClawConfigurationSnapshotSchema,
    setOpenClawSkillEnabledInputSchema,
    setOpenClawSkillEnabledResultSchema,
    updateOpenClawConfigurationInputSchema,
    updateOpenClawConfigurationResultSchema,
} from "../../../contracts/openClawSettings.ts";
import { appendClearedDashboardSessionCookie } from "../../rawHttp/sessionCookie.ts";
import type { RequestContext } from "../../trpc/context.ts";
import {
    authenticationPolicyError,
    operationOutcomeUnknownError,
    sessionCapabilityProcedure,
} from "../../trpc/trpc.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";
import { sessionActor } from "../security/authenticationSession.ts";
import type { OpenClawSettingsMutationAccess } from "./mutationAccess.ts";
import {
    type OpenClawSettingsControlContext,
    type OpenClawSettingsService,
    OpenClawSettingsServiceError,
} from "./service.ts";

interface OpenClawSettingsMutationAccessContextPort {
    readonly openClawSettingsMutationAccess?: OpenClawSettingsMutationAccess;
}

function service(context: RequestContext): OpenClawSettingsService {
    return context.openClawSettingsService;
}

function mutationAccess(context: RequestContext): OpenClawSettingsMutationAccess {
    const ports = context as RequestContext & OpenClawSettingsMutationAccessContextPort;
    return ports.openClawSettingsMutationAccess ?? context.authenticationLifecycle;
}

function authorizeMutation(
    context: RequestContext & {
        readonly sessionIdentity: AuthenticatedBrowserIdentity;
    }
): void {
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

function controlContext(
    context: RequestContext & {
        readonly sessionIdentity: AuthenticatedBrowserIdentity;
    }
): OpenClawSettingsControlContext {
    return {
        actor: sessionActor(context.sessionIdentity),
        reauthorize: () => authorizeMutation(context),
        requestId: context.requestId,
    };
}

function throwServiceFailure(error: unknown): never {
    if (!(error instanceof OpenClawSettingsServiceError)) throw error;
    switch (error.reason) {
        case "conflict": {
            throw new TRPCError({
                cause: error,
                code: "CONFLICT",
                message: "OpenClaw configuration state changed",
            });
        }
        case "not-found": {
            throw new TRPCError({
                cause: error,
                code: "NOT_FOUND",
                message: "OpenClaw setting target was not found",
            });
        }
        case "unknown-outcome": {
            throw operationOutcomeUnknownError(
                "OpenClaw settings outcome could not be confirmed"
            );
        }
        case "audit-unavailable":
        case "provider-data-invalid":
        case "provider-unavailable": {
            throw new TRPCError({
                cause: error,
                code: "SERVICE_UNAVAILABLE",
                message: "OpenClaw settings are temporarily unavailable",
            });
        }
    }
}

const readProcedure = sessionCapabilityProcedure("openclaw-settings:read");
const controlProcedure = sessionCapabilityProcedure("openclaw-settings:write");

/** Session-only secret-free settings reads and recent-MFA exact controls. */
export const openClawSettingsRoutes = {
    getConfiguration: readProcedure
        .input(getOpenClawConfigurationInputSchema)
        .output(openClawConfigurationSnapshotSchema)
        .query(async ({ ctx, signal }) => {
            try {
                return await service(ctx).getConfiguration(signal);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    listSkills: readProcedure
        .input(listOpenClawSkillsInputSchema)
        .output(listOpenClawSkillsResultSchema)
        .query(async ({ ctx, signal }) => {
            try {
                return await service(ctx).listSkills(signal);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    setSkillEnabled: controlProcedure
        .input(setOpenClawSkillEnabledInputSchema)
        .output(setOpenClawSkillEnabledResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeMutation(ctx);
            try {
                return await service(ctx).setSkillEnabled(
                    input,
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    updateConfiguration: controlProcedure
        .input(updateOpenClawConfigurationInputSchema)
        .output(updateOpenClawConfigurationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeMutation(ctx);
            try {
                return await service(ctx).updateConfiguration(
                    input,
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
};
