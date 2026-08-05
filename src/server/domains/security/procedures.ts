import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import {
    authenticatedSessionResultSchema,
    authSessionListSchema,
    authSessionRevokeResultSchema,
    authSessionTouchResultSchema,
    authStatusSchema,
    firstUserBootstrapInputSchema,
    okResultSchema,
    passwordChangeInputSchema,
    passwordChangeResultSchema,
    passwordLoginInputSchema,
    sessionRevokeInputSchema,
} from "../../../contracts/auth.ts";
import { emptyInputSchema } from "../../../contracts/system.ts";
import {
    appendClearedDashboardSessionCookie,
    appendDashboardSessionCookie,
} from "../../rawHttp/sessionCookie.ts";
import type { RequestContext } from "../../trpc/context.ts";
import { publicProcedure, router, sessionProcedure } from "../../trpc/trpc.ts";
import type {
    AuthenticatedBrowserIdentity,
    AuthenticationRequestMetadata,
} from "./authenticationLifecycle.ts";

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

function requestMetadata(
    context: RequestContext,
    signal: AbortSignal | undefined
): AuthenticationRequestMetadata {
    return {
        clientSourceId: context.authenticationClientSourceId,
        requestId: context.requestId,
        ...(signal !== undefined && { signal }),
        ...(context.userAgent !== undefined && { userAgent: context.userAgent }),
    };
}

function rateLimited(context: RequestContext, retryAfterSeconds: number): never {
    context.responseHeaders.set("retry-after", String(retryAfterSeconds));
    throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Authentication attempts are temporarily limited",
    });
}

/** Browser authentication procedures with one-time cookie delivery. */
export const authRouter = router({
    bootstrap: publicProcedure
        .input(firstUserBootstrapInputSchema)
        .output(authenticatedSessionResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.authenticationLifecycle.bootstrap(
                input,
                requestMetadata(ctx, signal)
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
                    return rateLimited(ctx, result.retryAfterSeconds);
                }
            }
        }),
    changePassword: sessionProcedure
        .input(passwordChangeInputSchema)
        .output(passwordChangeResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.authenticationLifecycle.changePassword(
                ctx.sessionIdentity,
                input,
                requestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "changed": {
                    const output = v.parse(passwordChangeResultSchema, {
                        revokedSessions: result.revokedSessions,
                        session: result.session,
                    });
                    appendDashboardSessionCookie(ctx.responseHeaders, result.token);
                    return output;
                }
                case "invalid-current-password": {
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "Current password is invalid",
                    });
                }
                case "rate-limited": {
                    return rateLimited(ctx, result.retryAfterSeconds);
                }
                case "same-password": {
                    throw new TRPCError({
                        code: "CONFLICT",
                        message: "New password must differ from the current password",
                    });
                }
                case "session-changed": {
                    appendClearedDashboardSessionCookie(ctx.responseHeaders);
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "Authentication state changed; sign in again",
                    });
                }
            }
        }),
    login: publicProcedure
        .input(passwordLoginInputSchema)
        .output(authenticatedSessionResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.authenticationLifecycle.login(
                input,
                requestMetadata(ctx, signal),
                currentSessionIdentity(ctx)
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
                    return rateLimited(ctx, result.retryAfterSeconds);
                }
            }
        }),
    logout: publicProcedure
        .input(emptyInputSchema)
        .output(okResultSchema)
        .mutation(({ ctx }) => {
            ctx.authenticationLifecycle.logout(currentSessionIdentity(ctx), {
                clientSourceId: ctx.authenticationClientSourceId,
                requestId: ctx.requestId,
                ...(ctx.userAgent !== undefined && { userAgent: ctx.userAgent }),
            });
            appendClearedDashboardSessionCookie(ctx.responseHeaders);
            return { isOk: true } as const;
        }),
    revokeSession: sessionProcedure
        .input(sessionRevokeInputSchema)
        .output(authSessionRevokeResultSchema)
        .mutation(({ ctx, input }) => {
            const result = ctx.authenticationLifecycle.revokeSession(
                ctx.sessionIdentity,
                input.sessionId,
                {
                    clientSourceId: ctx.authenticationClientSourceId,
                    requestId: ctx.requestId,
                    ...(ctx.userAgent !== undefined && { userAgent: ctx.userAgent }),
                }
            );
            if (result === undefined) {
                appendClearedDashboardSessionCookie(ctx.responseHeaders);
                throw new TRPCError({
                    code: "UNAUTHORIZED",
                    message: "Authentication state changed; sign in again",
                });
            }
            if (input.sessionId === ctx.sessionIdentity.sessionId) {
                appendClearedDashboardSessionCookie(ctx.responseHeaders);
            }
            return result;
        }),
    sessions: sessionProcedure
        .input(emptyInputSchema)
        .output(authSessionListSchema)
        .query(({ ctx }) => {
            const sessions = ctx.authenticationLifecycle.listSessions(
                ctx.sessionIdentity
            );
            if (sessions === undefined) {
                appendClearedDashboardSessionCookie(ctx.responseHeaders);
                throw new TRPCError({
                    code: "UNAUTHORIZED",
                    message: "Authentication state changed; sign in again",
                });
            }
            return { sessions };
        }),
    status: publicProcedure
        .input(emptyInputSchema)
        .output(authStatusSchema)
        .query(({ ctx }) =>
            ctx.authenticationLifecycle.status(currentSessionIdentity(ctx))
        ),
    touch: sessionProcedure
        .input(emptyInputSchema)
        .output(authSessionTouchResultSchema)
        .mutation(({ ctx }) => {
            const result = ctx.authenticationLifecycle.touchSession(ctx.sessionIdentity);
            if (result === undefined) {
                appendClearedDashboardSessionCookie(ctx.responseHeaders);
                throw new TRPCError({
                    code: "UNAUTHORIZED",
                    message: "Browser session is no longer active",
                });
            }
            return result;
        }),
});
