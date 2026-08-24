import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import {
    beginWebAuthnEnrollmentResultSchema,
    beginWebAuthnStepUpResultSchema,
    confirmWebAuthnEnrollmentInputSchema,
    confirmWebAuthnEnrollmentResultSchema,
    removeWebAuthnCredentialInputSchema,
    removeWebAuthnCredentialResultSchema,
    webAuthnStepUpInputSchema,
    webAuthnStepUpResultSchema,
} from "../../../../contracts/accountSecurity.ts";
import { emptyInputSchema } from "../../../../contracts/system.ts";
import { appendDashboardSessionCookie } from "../../../rawHttp/sessionCookie.ts";
import { sessionProcedure } from "../../../trpc/trpc.ts";
import {
    authenticationRequestMetadata,
    throwAuthenticationRateLimit,
} from "../procedureSupport.ts";
import {
    enrollmentRequired,
    sessionChanged,
    stateChanged,
    stepUpRequired,
} from "./accountProcedureResponses.ts";

function factorLimit(): never {
    throw new TRPCError({
        code: "CONFLICT",
        message: "The authenticator-factor limit has been reached",
    });
}

function verificationUnavailable(): never {
    throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: "WebAuthn verification is unavailable",
    });
}

/** Account-side WebAuthn enrollment, step-up, and credential-removal routes. */
export const accountWebAuthnRoutes = {
    beginWebAuthnStepUp: sessionProcedure
        .input(emptyInputSchema)
        .output(beginWebAuthnStepUpResultSchema)
        .mutation(async ({ ctx, signal }) => {
            const result = await ctx.mfaAccountLifecycle.beginWebAuthnStepUp(
                ctx.sessionIdentity,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "created": {
                    return v.parse(beginWebAuthnStepUpResultSchema, {
                        expiresAtMs: result.expiresAtMs,
                        options: result.options,
                    });
                }
                case "mfa-enrollment-required": {
                    return enrollmentRequired();
                }
                case "service-unavailable": {
                    return verificationUnavailable();
                }
                case "session-changed": {
                    return sessionChanged(ctx);
                }
                case "state-changed": {
                    return stateChanged("WebAuthn step-up state changed");
                }
            }
        }),
    stepUpWebAuthn: sessionProcedure
        .input(webAuthnStepUpInputSchema)
        .output(webAuthnStepUpResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.mfaAccountLifecycle.stepUpWebAuthn(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "verified": {
                    const output = v.parse(webAuthnStepUpResultSchema, {
                        method: result.method,
                        session: result.session,
                        verifiedAtMs: result.verifiedAtMs,
                    });
                    appendDashboardSessionCookie(ctx.responseHeaders, result.token);
                    return output;
                }
                case "invalid-proof": {
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "WebAuthn assertion is invalid",
                    });
                }
                case "mfa-enrollment-required": {
                    return enrollmentRequired();
                }
                case "rate-limited": {
                    return throwAuthenticationRateLimit(ctx, result.retryAfterSeconds);
                }
                case "service-unavailable": {
                    return verificationUnavailable();
                }
                case "session-changed": {
                    return sessionChanged(ctx);
                }
                case "state-changed": {
                    return stateChanged("WebAuthn step-up state changed");
                }
            }
        }),
    beginWebAuthnEnrollment: sessionProcedure
        .input(emptyInputSchema)
        .output(beginWebAuthnEnrollmentResultSchema)
        .mutation(async ({ ctx, signal }) => {
            const result = await ctx.mfaAccountLifecycle.beginWebAuthnEnrollment(
                ctx.sessionIdentity,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "created": {
                    return v.parse(beginWebAuthnEnrollmentResultSchema, {
                        expiresAtMs: result.expiresAtMs,
                        options: result.options,
                    });
                }
                case "factor-limit": {
                    return factorLimit();
                }
                case "service-unavailable": {
                    throw new TRPCError({
                        code: "SERVICE_UNAVAILABLE",
                        message: "WebAuthn enrollment is unavailable",
                    });
                }
                case "session-changed": {
                    return sessionChanged(ctx);
                }
                case "state-changed": {
                    return stateChanged("WebAuthn enrollment state changed");
                }
                case "step-up-required": {
                    return stepUpRequired();
                }
            }
        }),
    confirmWebAuthnEnrollment: sessionProcedure
        .input(confirmWebAuthnEnrollmentInputSchema)
        .output(confirmWebAuthnEnrollmentResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.mfaAccountLifecycle.confirmWebAuthnEnrollment(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "confirmed": {
                    if (result.enabledNow) {
                        const output = v.parse(confirmWebAuthnEnrollmentResultSchema, {
                            credential: result.credential,
                            enabledNow: true,
                            recoveryCodes: result.recoveryCodes,
                            revokedSessions: result.revokedSessions,
                            session: result.session,
                        });
                        appendDashboardSessionCookie(ctx.responseHeaders, result.token);
                        return output;
                    }
                    return v.parse(confirmWebAuthnEnrollmentResultSchema, {
                        credential: result.credential,
                        enabledNow: false,
                    });
                }
                case "factor-limit": {
                    return factorLimit();
                }
                case "invalid-proof": {
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "WebAuthn registration is invalid",
                    });
                }
                case "rate-limited": {
                    return throwAuthenticationRateLimit(ctx, result.retryAfterSeconds);
                }
                case "service-unavailable": {
                    throw new TRPCError({
                        code: "SERVICE_UNAVAILABLE",
                        message: "WebAuthn enrollment is unavailable",
                    });
                }
                case "session-changed": {
                    return sessionChanged(ctx);
                }
                case "state-changed": {
                    return stateChanged("WebAuthn enrollment state changed");
                }
                case "step-up-required": {
                    return stepUpRequired();
                }
            }
        }),
    removeWebAuthnCredential: sessionProcedure
        .input(removeWebAuthnCredentialInputSchema)
        .output(removeWebAuthnCredentialResultSchema)
        .mutation(({ ctx, input, signal }) => {
            const result = ctx.mfaAccountLifecycle.removeWebAuthnCredential(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "removed": {
                    return v.parse(removeWebAuthnCredentialResultSchema, {
                        credentialId: result.credentialId,
                        removed: result.removed,
                    });
                }
                case "final-factor": {
                    throw new TRPCError({
                        code: "CONFLICT",
                        message: "The final authenticator factor cannot be removed",
                    });
                }
                case "mfa-enrollment-required": {
                    return enrollmentRequired();
                }
                case "not-found": {
                    throw new TRPCError({
                        code: "NOT_FOUND",
                        message: "WebAuthn credential was not found",
                    });
                }
                case "session-changed": {
                    return sessionChanged(ctx);
                }
                case "step-up-required": {
                    return stepUpRequired();
                }
            }
        }),
};
