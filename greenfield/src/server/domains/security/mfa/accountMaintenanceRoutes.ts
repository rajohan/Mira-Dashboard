import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import {
    accountSecuritySummarySchema,
    disableMfaInputSchema,
    disableMfaResultSchema,
    rotateRecoveryCodesResultSchema,
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

/** MFA disablement, recovery rotation, and account-security summary routes. */
export const accountMaintenanceRoutes = {
    disableMfa: sessionProcedure
        .input(disableMfaInputSchema)
        .output(disableMfaResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.mfaAccountLifecycle.disableMfa(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "disabled": {
                    const output = v.parse(disableMfaResultSchema, {
                        disabled: result.disabled,
                        revokedSessions: result.revokedSessions,
                        session: result.session,
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
                    return stateChanged("Multi-factor authentication state changed");
                }
                case "step-up-required": {
                    return stepUpRequired();
                }
            }
        }),
    rotateRecoveryCodes: sessionProcedure
        .input(emptyInputSchema)
        .output(rotateRecoveryCodesResultSchema)
        .mutation(async ({ ctx, signal }) => {
            const result = await ctx.mfaAccountLifecycle.rotateRecoveryCodes(
                ctx.sessionIdentity,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "rotated": {
                    return v.parse(rotateRecoveryCodesResultSchema, {
                        recoveryCodes: result.recoveryCodes,
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
                case "step-up-required": {
                    return stepUpRequired();
                }
            }
        }),
    summary: sessionProcedure
        .input(emptyInputSchema)
        .output(accountSecuritySummarySchema)
        .query(({ ctx }) => {
            const result = ctx.mfaAccountLifecycle.summary(ctx.sessionIdentity);
            switch (result.status) {
                case "found": {
                    return v.parse(accountSecuritySummarySchema, result.summary);
                }
                case "session-changed": {
                    return sessionChanged(ctx);
                }
            }
        }),
};
