import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import {
    passwordReauthenticationInputSchema,
    passwordReauthenticationResultSchema,
    recoveryStepUpInputSchema,
    recoveryStepUpResultSchema,
    totpStepUpInputSchema,
    totpStepUpResultSchema,
} from "../../../../contracts/accountSecurity.ts";
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
} from "./accountProcedureResponses.ts";

/** Password, recovery-code, and TOTP account step-up routes. */
export const accountProofRoutes = {
    reauthenticatePassword: sessionProcedure
        .input(passwordReauthenticationInputSchema)
        .output(passwordReauthenticationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.mfaAccountLifecycle.reauthenticatePassword(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "verified": {
                    const output = v.parse(passwordReauthenticationResultSchema, {
                        session: result.session,
                        verifiedAtMs: result.verifiedAtMs,
                    });
                    appendDashboardSessionCookie(ctx.responseHeaders, result.token);
                    return output;
                }
                case "invalid-password": {
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "Current password is invalid",
                    });
                }
                case "rate-limited": {
                    return throwAuthenticationRateLimit(ctx, result.retryAfterSeconds);
                }
                case "session-changed": {
                    return sessionChanged(ctx);
                }
            }
        }),
    stepUpRecovery: sessionProcedure
        .input(recoveryStepUpInputSchema)
        .output(recoveryStepUpResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.mfaAccountLifecycle.stepUpRecovery(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "verified": {
                    const output = v.parse(recoveryStepUpResultSchema, {
                        method: result.method,
                        recoveryCodesRemaining: result.recoveryCodesRemaining,
                        session: result.session,
                        verifiedAtMs: result.verifiedAtMs,
                    });
                    appendDashboardSessionCookie(ctx.responseHeaders, result.token);
                    return output;
                }
                case "invalid-proof": {
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "Recovery code is invalid",
                    });
                }
                case "mfa-enrollment-required": {
                    return enrollmentRequired();
                }
                case "rate-limited": {
                    return throwAuthenticationRateLimit(ctx, result.retryAfterSeconds);
                }
                case "session-changed": {
                    return sessionChanged(ctx);
                }
                case "state-changed": {
                    return stateChanged("Recovery-code state changed");
                }
            }
        }),
    stepUpTotp: sessionProcedure
        .input(totpStepUpInputSchema)
        .output(totpStepUpResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.mfaAccountLifecycle.stepUpTotp(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "verified": {
                    const output = v.parse(totpStepUpResultSchema, {
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
                        message: "Authenticator code is invalid",
                    });
                }
                case "mfa-enrollment-required": {
                    return enrollmentRequired();
                }
                case "rate-limited": {
                    return throwAuthenticationRateLimit(ctx, result.retryAfterSeconds);
                }
                case "service-unavailable": {
                    throw new TRPCError({
                        code: "SERVICE_UNAVAILABLE",
                        message: "Authenticator verification is unavailable",
                    });
                }
                case "session-changed": {
                    return sessionChanged(ctx);
                }
                case "state-changed": {
                    return stateChanged("Authenticator state changed");
                }
            }
        }),
};
