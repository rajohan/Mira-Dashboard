import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import {
    authenticatedSessionResultSchema,
    beginWebAuthnLoginResultSchema,
    recoveryLoginInputSchema,
    totpLoginInputSchema,
    webAuthnLoginInputSchema,
} from "../../../contracts/auth.ts";
import { emptyInputSchema } from "../../../contracts/system.ts";
import { appendClearedPendingLoginCookie } from "../../rawHttp/pendingLoginCookie.ts";
import { appendDashboardSessionCookie } from "../../rawHttp/sessionCookie.ts";
import { pendingLoginProcedure } from "../../trpc/trpc.ts";
import {
    authenticationRequestMetadata,
    throwAuthenticationRateLimit,
} from "./procedureSupport.ts";

/** Pending-login routes that complete recovery-code, TOTP, or WebAuthn authentication. */
export const authPendingMfaRoutes = {
    beginWebAuthnLogin: pendingLoginProcedure
        .input(emptyInputSchema)
        .output(beginWebAuthnLoginResultSchema)
        .mutation(async ({ ctx, signal }) => {
            const result = await ctx.mfaLoginLifecycle.beginWebAuthnLogin(
                ctx.pendingLoginToken,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "created": {
                    return v.parse(beginWebAuthnLoginResultSchema, {
                        expiresAtMs: result.expiresAtMs,
                        options: result.options,
                    });
                }
                case "not-available": {
                    throw new TRPCError({
                        code: "CONFLICT",
                        message: "WebAuthn is not available for this pending login",
                    });
                }
                case "service-unavailable": {
                    throw new TRPCError({
                        code: "SERVICE_UNAVAILABLE",
                        message: "WebAuthn authentication is unavailable",
                    });
                }
                case "state-changed": {
                    appendClearedPendingLoginCookie(ctx.responseHeaders);
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "Pending authentication state changed",
                    });
                }
            }
        }),
    loginRecovery: pendingLoginProcedure
        .input(recoveryLoginInputSchema)
        .output(authenticatedSessionResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.mfaLoginLifecycle.completeRecoveryLogin(
                ctx.pendingLoginToken,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "authenticated": {
                    const output = v.parse(authenticatedSessionResultSchema, {
                        session: result.session,
                        user: result.user,
                    });
                    appendDashboardSessionCookie(ctx.responseHeaders, result.token);
                    appendClearedPendingLoginCookie(ctx.responseHeaders);
                    return output;
                }
                case "invalid-proof": {
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "Recovery code is invalid",
                    });
                }
                case "rate-limited": {
                    return throwAuthenticationRateLimit(ctx, result.retryAfterSeconds);
                }
                case "service-unavailable": {
                    throw new TRPCError({
                        code: "SERVICE_UNAVAILABLE",
                        message: "Multi-factor authentication is unavailable",
                    });
                }
                case "state-changed": {
                    appendClearedPendingLoginCookie(ctx.responseHeaders);
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "Pending authentication state changed",
                    });
                }
            }
        }),
    loginTotp: pendingLoginProcedure
        .input(totpLoginInputSchema)
        .output(authenticatedSessionResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.mfaLoginLifecycle.completeTotpLogin(
                ctx.pendingLoginToken,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "authenticated": {
                    const output = v.parse(authenticatedSessionResultSchema, {
                        session: result.session,
                        user: result.user,
                    });
                    appendDashboardSessionCookie(ctx.responseHeaders, result.token);
                    appendClearedPendingLoginCookie(ctx.responseHeaders);
                    return output;
                }
                case "invalid-proof": {
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "Authenticator code is invalid",
                    });
                }
                case "rate-limited": {
                    return throwAuthenticationRateLimit(ctx, result.retryAfterSeconds);
                }
                case "service-unavailable": {
                    throw new TRPCError({
                        code: "SERVICE_UNAVAILABLE",
                        message: "Multi-factor authentication is unavailable",
                    });
                }
                case "state-changed": {
                    appendClearedPendingLoginCookie(ctx.responseHeaders);
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "Pending authentication state changed",
                    });
                }
            }
        }),
    loginWebAuthn: pendingLoginProcedure
        .input(webAuthnLoginInputSchema)
        .output(authenticatedSessionResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.mfaLoginLifecycle.completeWebAuthnLogin(
                ctx.pendingLoginToken,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "authenticated": {
                    const output = v.parse(authenticatedSessionResultSchema, {
                        session: result.session,
                        user: result.user,
                    });
                    appendDashboardSessionCookie(ctx.responseHeaders, result.token);
                    appendClearedPendingLoginCookie(ctx.responseHeaders);
                    return output;
                }
                case "invalid-proof": {
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "WebAuthn proof is invalid",
                    });
                }
                case "rate-limited": {
                    return throwAuthenticationRateLimit(ctx, result.retryAfterSeconds);
                }
                case "service-unavailable": {
                    throw new TRPCError({
                        code: "SERVICE_UNAVAILABLE",
                        message: "WebAuthn authentication is unavailable",
                    });
                }
                case "state-changed": {
                    appendClearedPendingLoginCookie(ctx.responseHeaders);
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "Pending authentication state changed",
                    });
                }
            }
        }),
};
