import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import {
    authenticatedSessionResultSchema,
    authStatusSchema,
    firstUserBootstrapInputSchema,
    okResultSchema,
    passwordLoginInputSchema,
    passwordLoginResultSchema,
} from "../../../contracts/auth.ts";
import { emptyInputSchema } from "../../../contracts/system.ts";
import {
    appendClearedPendingLoginCookie,
    appendPendingLoginCookie,
} from "../../rawHttp/pendingLoginCookie.ts";
import {
    appendClearedDashboardSessionCookie,
    appendDashboardSessionCookie,
} from "../../rawHttp/sessionCookie.ts";
import type { RequestContext } from "../../trpc/context.ts";
import { publicProcedure } from "../../trpc/trpc.ts";
import type { AuthenticatedBrowserIdentity } from "./authenticationLifecycle.ts";
import {
    authenticationRequestMetadata,
    throwAuthenticationRateLimit,
} from "./procedureSupport.ts";

function currentSessionIdentity(
    context: RequestContext
): AuthenticatedBrowserIdentity | undefined {
    return context.authentication.kind === "authenticated" &&
        context.authentication.principal.kind === "session"
        ? {
              sessionId: context.authentication.principal.authenticatorId,
              userId: context.authentication.principal.id,
          }
        : undefined;
}

/** Public bootstrap, password-login, logout, and authentication-status routes. */
export const authPublicRoutes = {
    bootstrap: publicProcedure
        .input(firstUserBootstrapInputSchema)
        .output(authenticatedSessionResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.authenticationLifecycle.bootstrap(
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "created": {
                    const output = v.parse(authenticatedSessionResultSchema, {
                        session: result.session,
                        user: result.user,
                    });
                    appendDashboardSessionCookie(ctx.responseHeaders, result.token);
                    return output;
                }
                case "closed": {
                    throw new TRPCError({
                        code: "CONFLICT",
                        message: "First-user bootstrap is already complete",
                    });
                }
                case "gateway-unavailable": {
                    throw new TRPCError({
                        code: "SERVICE_UNAVAILABLE",
                        message: "Gateway credential verification is unavailable",
                    });
                }
                case "invalid-gateway": {
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "Gateway credential is invalid",
                    });
                }
                case "rate-limited": {
                    return throwAuthenticationRateLimit(ctx, result.retryAfterSeconds);
                }
            }
        }),
    login: publicProcedure
        .input(passwordLoginInputSchema)
        .output(passwordLoginResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.authenticationLifecycle.login(
                input,
                authenticationRequestMetadata(ctx, signal),
                currentSessionIdentity(ctx)
            );
            switch (result.status) {
                case "created": {
                    const output = v.parse(passwordLoginResultSchema, {
                        session: result.session,
                        status: "authenticated",
                        user: result.user,
                    });
                    appendDashboardSessionCookie(ctx.responseHeaders, result.token);
                    appendClearedPendingLoginCookie(ctx.responseHeaders);
                    return output;
                }
                case "mfa-required": {
                    const output = v.parse(passwordLoginResultSchema, {
                        pendingLogin: result.pendingLogin,
                        status: "mfa-required",
                    });
                    appendPendingLoginCookie(ctx.responseHeaders, result.token);
                    return output;
                }
                case "bootstrap-required": {
                    throw new TRPCError({
                        code: "CONFLICT",
                        message: "First-user bootstrap is required",
                    });
                }
                case "invalid-credentials": {
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "Username or password is invalid",
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
            }
        }),
    logout: publicProcedure
        .input(emptyInputSchema)
        .output(okResultSchema)
        .mutation(async ({ ctx }) => {
            await ctx.authenticationLifecycle.logout(
                currentSessionIdentity(ctx),
                authenticationRequestMetadata(ctx, undefined)
            );
            if (ctx.pendingLoginCredential.kind === "present") {
                await ctx.mfaLoginLifecycle.revokePendingLogin(
                    ctx.pendingLoginCredential.token,
                    authenticationRequestMetadata(ctx, undefined)
                );
            }
            appendClearedDashboardSessionCookie(ctx.responseHeaders);
            appendClearedPendingLoginCookie(ctx.responseHeaders);
            return { isOk: true } as const;
        }),
    status: publicProcedure
        .input(emptyInputSchema)
        .output(authStatusSchema)
        .query(({ ctx }) => {
            const sessionStatus = ctx.authenticationLifecycle.status(
                currentSessionIdentity(ctx)
            );
            const pendingLogin =
                ctx.pendingLoginCredential.kind === "present"
                    ? ctx.mfaLoginLifecycle.pendingLoginSummary(
                          ctx.pendingLoginCredential.token
                      )
                    : undefined;
            if (sessionStatus.isBootstrapRequired) {
                return { state: "bootstrap-required" } as const;
            }
            if (sessionStatus.authenticated) {
                return {
                    ...(pendingLogin !== undefined && { pendingLogin }),
                    session: sessionStatus.session,
                    state: "authenticated" as const,
                    user: sessionStatus.user,
                };
            }
            return pendingLogin === undefined
                ? ({ state: "anonymous" } as const)
                : ({ pendingLogin, state: "pending-mfa" } as const);
        }),
};
