import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import {
    authSessionListSchema,
    authSessionRevokeResultSchema,
    authSessionsRevokeResultSchema,
    authSessionTouchResultSchema,
    passwordChangeInputSchema,
    passwordChangeResultSchema,
    sessionRevokeInputSchema,
} from "../../../contracts/auth.ts";
import { emptyInputSchema } from "../../../contracts/system.ts";
import { appendClearedPendingLoginCookie } from "../../rawHttp/pendingLoginCookie.ts";
import {
    appendClearedDashboardSessionCookie,
    appendDashboardSessionCookie,
} from "../../rawHttp/sessionCookie.ts";
import { authenticationPolicyError, sessionProcedure } from "../../trpc/trpc.ts";
import {
    authenticationRequestMetadata,
    throwAuthenticationRateLimit,
} from "./procedureSupport.ts";

/** Authenticated password-change and browser-session management routes. */
export const authSessionRoutes = {
    changePassword: sessionProcedure
        .input(passwordChangeInputSchema)
        .output(passwordChangeResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.authenticationLifecycle.changePassword(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
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
                    return throwAuthenticationRateLimit(ctx, result.retryAfterSeconds);
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
                case "step-up-required": {
                    throw authenticationPolicyError(
                        "step_up_required",
                        "Recent multi-factor authentication is required"
                    );
                }
            }
        }),
    revokeSession: sessionProcedure
        .input(sessionRevokeInputSchema)
        .output(authSessionRevokeResultSchema)
        .mutation(async ({ ctx, input }) => {
            const result = await ctx.authenticationLifecycle.revokeSession(
                ctx.sessionIdentity,
                input.sessionId,
                authenticationRequestMetadata(ctx, undefined)
            );
            if (result === undefined) {
                appendClearedDashboardSessionCookie(ctx.responseHeaders);
                throw new TRPCError({
                    code: "UNAUTHORIZED",
                    message: "Authentication state changed; sign in again",
                });
            }
            if ("status" in result) {
                throw authenticationPolicyError(
                    "step_up_required",
                    "Recent password or multi-factor authentication is required"
                );
            }
            if (input.sessionId === ctx.sessionIdentity.sessionId) {
                appendClearedDashboardSessionCookie(ctx.responseHeaders);
            }
            return result;
        }),
    revokeAllSessions: sessionProcedure
        .input(emptyInputSchema)
        .output(authSessionsRevokeResultSchema)
        .mutation(async ({ ctx }) => {
            const result = await ctx.authenticationLifecycle.revokeAllSessions(
                ctx.sessionIdentity,
                authenticationRequestMetadata(ctx, undefined)
            );
            if (result === undefined) {
                appendClearedDashboardSessionCookie(ctx.responseHeaders);
                appendClearedPendingLoginCookie(ctx.responseHeaders);
                throw new TRPCError({
                    code: "UNAUTHORIZED",
                    message: "Authentication state changed; sign in again",
                });
            }
            if ("status" in result) {
                throw authenticationPolicyError(
                    "step_up_required",
                    "Recent password or multi-factor authentication is required"
                );
            }
            const output = v.parse(authSessionsRevokeResultSchema, result);
            appendClearedDashboardSessionCookie(ctx.responseHeaders);
            appendClearedPendingLoginCookie(ctx.responseHeaders);
            return output;
        }),
    revokeOtherSessions: sessionProcedure
        .input(emptyInputSchema)
        .output(authSessionsRevokeResultSchema)
        .mutation(async ({ ctx }) => {
            const result = await ctx.authenticationLifecycle.revokeOtherSessions(
                ctx.sessionIdentity,
                authenticationRequestMetadata(ctx, undefined)
            );
            if (result === undefined) {
                appendClearedDashboardSessionCookie(ctx.responseHeaders);
                throw new TRPCError({
                    code: "UNAUTHORIZED",
                    message: "Authentication state changed; sign in again",
                });
            }
            if ("status" in result) {
                throw authenticationPolicyError(
                    "step_up_required",
                    "Recent password or multi-factor authentication is required"
                );
            }
            return v.parse(authSessionsRevokeResultSchema, result);
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
    touch: sessionProcedure
        .input(emptyInputSchema)
        .output(authSessionTouchResultSchema)
        .mutation(async ({ ctx }) => {
            const result = await ctx.authenticationLifecycle.touchSession(
                ctx.sessionIdentity
            );
            if (result === undefined) {
                appendClearedDashboardSessionCookie(ctx.responseHeaders);
                throw new TRPCError({
                    code: "UNAUTHORIZED",
                    message: "Browser session is no longer active",
                });
            }
            return result;
        }),
};
