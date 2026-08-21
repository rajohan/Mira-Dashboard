import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import {
    beginTotpEnrollmentInputSchema,
    beginTotpEnrollmentResultSchema,
    confirmTotpEnrollmentInputSchema,
    confirmTotpEnrollmentResultSchema,
    removeTotpFactorInputSchema,
    removeTotpFactorResultSchema,
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
    stepUpRequired,
} from "./accountProcedureResponses.ts";

/** Authenticator-factor enrollment, confirmation, and removal routes. */
export const accountFactorRoutes = {
    beginTotpEnrollment: sessionProcedure
        .input(beginTotpEnrollmentInputSchema)
        .output(beginTotpEnrollmentResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.mfaAccountLifecycle.beginTotpEnrollment(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "created": {
                    return v.parse(beginTotpEnrollmentResultSchema, {
                        enrollment: result.enrollment,
                    });
                }
                case "factor-limit": {
                    throw new TRPCError({
                        code: "CONFLICT",
                        message: "The authenticator-factor limit has been reached",
                    });
                }
                case "service-unavailable": {
                    throw new TRPCError({
                        code: "SERVICE_UNAVAILABLE",
                        message: "Authenticator enrollment is unavailable",
                    });
                }
                case "session-changed": {
                    return sessionChanged(ctx);
                }
                case "state-changed": {
                    return stateChanged("Authenticator enrollment state changed");
                }
                case "step-up-required": {
                    return stepUpRequired();
                }
            }
        }),
    confirmTotpEnrollment: sessionProcedure
        .input(confirmTotpEnrollmentInputSchema)
        .output(confirmTotpEnrollmentResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.mfaAccountLifecycle.confirmTotpEnrollment(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "confirmed": {
                    if (result.enabledNow) {
                        const output = v.parse(confirmTotpEnrollmentResultSchema, {
                            enabledNow: true,
                            factor: result.factor,
                            recoveryCodes: result.recoveryCodes,
                            revokedSessions: result.revokedSessions,
                            session: result.session,
                        });
                        appendDashboardSessionCookie(ctx.responseHeaders, result.token);
                        return output;
                    }
                    return v.parse(confirmTotpEnrollmentResultSchema, {
                        enabledNow: false,
                        factor: result.factor,
                    });
                }
                case "factor-limit": {
                    throw new TRPCError({
                        code: "CONFLICT",
                        message: "The authenticator-factor limit has been reached",
                    });
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
                        message: "Authenticator enrollment is unavailable",
                    });
                }
                case "session-changed": {
                    return sessionChanged(ctx);
                }
                case "state-changed": {
                    return stateChanged("Authenticator enrollment state changed");
                }
                case "step-up-required": {
                    return stepUpRequired();
                }
            }
        }),
    removeTotpFactor: sessionProcedure
        .input(removeTotpFactorInputSchema)
        .output(removeTotpFactorResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            const result = await ctx.mfaAccountLifecycle.removeTotpFactor(
                ctx.sessionIdentity,
                input,
                authenticationRequestMetadata(ctx, signal)
            );
            switch (result.status) {
                case "removed": {
                    return v.parse(removeTotpFactorResultSchema, {
                        factorId: result.factorId,
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
                        message: "Authenticator factor was not found",
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
