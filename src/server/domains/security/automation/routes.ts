import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import {
    type AutomationPrincipalSummary,
    createAutomationCredentialInputSchema,
    createAutomationCredentialResultSchema,
    createAutomationPrincipalInputSchema,
    createAutomationPrincipalResultSchema,
    disableAutomationPrincipalInputSchema,
    disableAutomationPrincipalResultSchema,
    listAutomationCredentialsInputSchema,
    listAutomationCredentialsResultSchema,
    listAutomationPrincipalsInputSchema,
    listAutomationPrincipalsResultSchema,
    replaceAutomationCapabilitiesInputSchema,
    replaceAutomationCapabilitiesResultSchema,
    revokeAutomationCredentialInputSchema,
    revokeAutomationCredentialResultSchema,
    rotateAutomationCredentialInputSchema,
    rotateAutomationCredentialResultSchema,
} from "../../../../contracts/automationSecurity.ts";
import { appendClearedDashboardSessionCookie } from "../../../rawHttp/sessionCookie.ts";
import type { RequestContext } from "../../../trpc/context.ts";
import { authenticationPolicyError, sessionProcedure } from "../../../trpc/trpc.ts";
import { authenticationRequestMetadata } from "../procedureSupport.ts";

type AutomationLifecycleFailureStatus =
    | "conflict"
    | "invalid-expiry"
    | "mfa-enrollment-required"
    | "not-found"
    | "session-changed"
    | "step-up-required"
    | "unavailable";

function mutablePrincipalCapabilities(principal: AutomationPrincipalSummary) {
    return { ...principal, capabilities: [...principal.capabilities] };
}

function throwAutomationLifecycleFailure(
    context: RequestContext,
    status: AutomationLifecycleFailureStatus
): never {
    switch (status) {
        case "session-changed": {
            appendClearedDashboardSessionCookie(context.responseHeaders);
            throw new TRPCError({
                code: "UNAUTHORIZED",
                message: "Authentication state changed; sign in again",
            });
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
                "Recent authentication is required"
            );
        }
        case "not-found": {
            throw new TRPCError({
                code: "NOT_FOUND",
                message: "Automation security resource was not found",
            });
        }
        case "conflict": {
            throw new TRPCError({
                code: "CONFLICT",
                message: "Automation security state changed",
            });
        }
        case "invalid-expiry": {
            throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: "Automation credential expiry is invalid",
            });
        }
        case "unavailable": {
            throw new TRPCError({
                code: "SERVICE_UNAVAILABLE",
                message: "Automation credential generation is unavailable",
            });
        }
    }
}

/** Session-only automation principal and credential administration routes. */
export const automationSecurityRoutes = {
    listPrincipals: sessionProcedure
        .input(listAutomationPrincipalsInputSchema)
        .output(listAutomationPrincipalsResultSchema)
        .query(({ ctx, input }) => {
            const result = ctx.automationSecurityLifecycle.listPrincipals(
                ctx.sessionIdentity,
                input
            );
            if (result.status === "listed") {
                const output = v.parse(
                    listAutomationPrincipalsResultSchema,
                    result.result
                );
                return {
                    ...output,
                    principals: output.principals.map(mutablePrincipalCapabilities),
                };
            }
            return throwAutomationLifecycleFailure(ctx, result.status);
        }),
    listCredentials: sessionProcedure
        .input(listAutomationCredentialsInputSchema)
        .output(listAutomationCredentialsResultSchema)
        .query(({ ctx, input }) => {
            const result = ctx.automationSecurityLifecycle.listCredentials(
                ctx.sessionIdentity,
                input
            );
            if (result.status === "listed") {
                return v.parse(listAutomationCredentialsResultSchema, result.result);
            }
            return throwAutomationLifecycleFailure(ctx, result.status);
        }),
    createPrincipal: sessionProcedure
        .input(createAutomationPrincipalInputSchema)
        .output(createAutomationPrincipalResultSchema)
        .mutation(({ ctx, input, signal }) => {
            const result = ctx.automationSecurityLifecycle.createPrincipal(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            if (result.status === "created") {
                const output = v.parse(
                    createAutomationPrincipalResultSchema,
                    result.result
                );
                return {
                    ...output,
                    principal: mutablePrincipalCapabilities(output.principal),
                };
            }
            return throwAutomationLifecycleFailure(ctx, result.status);
        }),
    createCredential: sessionProcedure
        .input(createAutomationCredentialInputSchema)
        .output(createAutomationCredentialResultSchema)
        .mutation(({ ctx, input, signal }) => {
            const result = ctx.automationSecurityLifecycle.createCredential(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            if (result.status === "created") {
                return v.parse(createAutomationCredentialResultSchema, result.result);
            }
            return throwAutomationLifecycleFailure(ctx, result.status);
        }),
    rotateCredential: sessionProcedure
        .input(rotateAutomationCredentialInputSchema)
        .output(rotateAutomationCredentialResultSchema)
        .mutation(({ ctx, input, signal }) => {
            const result = ctx.automationSecurityLifecycle.rotateCredential(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            if (result.status === "rotated") {
                return v.parse(rotateAutomationCredentialResultSchema, result.result);
            }
            return throwAutomationLifecycleFailure(ctx, result.status);
        }),
    revokeCredential: sessionProcedure
        .input(revokeAutomationCredentialInputSchema)
        .output(revokeAutomationCredentialResultSchema)
        .mutation(({ ctx, input, signal }) => {
            const result = ctx.automationSecurityLifecycle.revokeCredential(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            if (result.status === "revoked") {
                return v.parse(revokeAutomationCredentialResultSchema, result.result);
            }
            return throwAutomationLifecycleFailure(ctx, result.status);
        }),
    replaceCapabilities: sessionProcedure
        .input(replaceAutomationCapabilitiesInputSchema)
        .output(replaceAutomationCapabilitiesResultSchema)
        .mutation(({ ctx, input, signal }) => {
            const result = ctx.automationSecurityLifecycle.replaceCapabilities(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            if (result.status === "replaced") {
                const output = v.parse(
                    replaceAutomationCapabilitiesResultSchema,
                    result.result
                );
                return {
                    ...output,
                    principal: mutablePrincipalCapabilities(output.principal),
                };
            }
            return throwAutomationLifecycleFailure(ctx, result.status);
        }),
    disablePrincipal: sessionProcedure
        .input(disableAutomationPrincipalInputSchema)
        .output(disableAutomationPrincipalResultSchema)
        .mutation(({ ctx, input, signal }) => {
            const result = ctx.automationSecurityLifecycle.disablePrincipal(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            if (result.status === "disabled") {
                const output = v.parse(
                    disableAutomationPrincipalResultSchema,
                    result.result
                );
                return {
                    ...output,
                    principal: mutablePrincipalCapabilities(output.principal),
                };
            }
            return throwAutomationLifecycleFailure(ctx, result.status);
        }),
};
