import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import {
    authenticatedSessionResultSchema,
    recoveryLoginInputSchema,
    totpLoginInputSchema,
} from "../../../contracts/auth.ts";
import { appendClearedPendingLoginCookie } from "../../rawHttp/pendingLoginCookie.ts";
import { appendDashboardSessionCookie } from "../../rawHttp/sessionCookie.ts";
import { pendingLoginProcedure } from "../../trpc/trpc.ts";
import {
    authenticationRequestMetadata,
    throwAuthenticationRateLimit,
} from "./procedureSupport.ts";

/** Pending-login routes that complete recovery-code or TOTP authentication. */
export const authPendingMfaRoutes = {
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
};
