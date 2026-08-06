import { initTRPC, TRPCError } from "@trpc/server";
import { secondsToMilliseconds } from "date-fns";
import superjson from "superjson";

import {
    contractAuthenticationErrorReasons,
    type ContractAuthenticationErrorReason,
} from "../../contracts/registry.ts";
import type { ApplicationCapability } from "../../contracts/security.ts";
import type { RequestContext } from "./context.ts";
import {
    applyProcedureExpectedErrorPolicy,
    applyProcedureExpectedErrorPolicyToOutput,
} from "./procedureErrorPolicy.ts";

const internalErrorMessage = "Internal server error";
const contractAuthenticationErrorReasonSet: ReadonlySet<string> = new Set(
    contractAuthenticationErrorReasons
);

class AuthenticationPolicyErrorCause extends Error {
    public readonly reason: ContractAuthenticationErrorReason;

    public constructor(reason: ContractAuthenticationErrorReason) {
        super("Authentication policy requirement was not met");
        this.name = "AuthenticationPolicyErrorCause";
        this.reason = reason;
    }
}

function authenticationPolicyReason(
    error: TRPCError
): ContractAuthenticationErrorReason | undefined {
    if (
        error.code !== "FORBIDDEN" ||
        !(error.cause instanceof AuthenticationPolicyErrorCause) ||
        !contractAuthenticationErrorReasonSet.has(error.cause.reason)
    ) {
        return undefined;
    }
    return error.cause.reason;
}

const trpc = initTRPC.context<RequestContext>().create({
    errorFormatter({ error, shape }) {
        const { path: _path, stack: _stack, ...safeData } = shape.data;
        const reason = authenticationPolicyReason(error);
        return {
            ...shape,
            data: {
                ...safeData,
                ...(reason !== undefined && { reason }),
            },
            message:
                error.code === "INTERNAL_SERVER_ERROR"
                    ? internalErrorMessage
                    : shape.message,
        };
    },
    sse: {
        client: {
            reconnectAfterInactivityMs: secondsToMilliseconds(45),
        },
        ping: {
            enabled: true,
            intervalMs: secondsToMilliseconds(15),
        },
    },
    transformer: superjson,
});

/** Base procedure builder with fail-closed expected-error enforcement. */
export const publicProcedure = trpc.procedure.use(async ({ next, path }) => {
    const result = await next();
    if (!result.ok) {
        const error = applyProcedureExpectedErrorPolicy(path, result.error);
        return error === result.error ? result : { ...result, error };
    }
    return {
        ...result,
        data: applyProcedureExpectedErrorPolicyToOutput(path, result.data),
    };
});

/**
 * Builds one client-actionable authentication-policy rejection.
 * @param reason Allowlisted client action required before retry.
 * @param message Safe human-readable policy failure.
 * @returns Stable FORBIDDEN error with a private typed cause.
 */
export function authenticationPolicyError(
    reason: ContractAuthenticationErrorReason,
    message: string
): TRPCError {
    return new TRPCError({
        cause: new AuthenticationPolicyErrorCause(reason),
        code: "FORBIDDEN",
        message,
    });
}

/** Procedure builder requiring one valid password-first pending-login cookie. */
export const pendingLoginProcedure = publicProcedure.use(({ ctx, next }) => {
    if (ctx.pendingLoginCredential.kind !== "present") {
        throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Pending multi-factor authentication is required",
        });
    }
    return next({
        ctx: {
            ...ctx,
            pendingLoginToken: ctx.pendingLoginCredential.token,
        },
    });
});

/** Procedure builder requiring a validated session or automation principal. */
export const authenticatedProcedure = publicProcedure.use(({ ctx, next }) => {
    if (ctx.authentication.kind !== "authenticated") {
        throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Authentication required",
        });
    }
    if (ctx.authenticationLease === undefined) {
        throw new Error("Authenticated request context is missing its lease");
    }
    return next({
        ctx: {
            ...ctx,
            authenticationLease: ctx.authenticationLease,
            principal: ctx.authentication.principal,
        },
    });
});

/**
 * Builds a procedure requiring one exact capability on the validated principal.
 * Browser sessions and automation callers pass through the same explicit grant check.
 * @param capability Registered application capability required by the procedure.
 * @returns Authenticated procedure builder narrowed to a principal with the grant.
 */
export function capabilityProcedure(capability: ApplicationCapability) {
    return authenticatedProcedure.use(({ ctx, next }) => {
        if (!ctx.principal.capabilities.includes(capability)) {
            throw new TRPCError({
                code: "FORBIDDEN",
                message: "Required application capability is not granted",
            });
        }
        return next({ ctx });
    });
}

/** Procedure builder restricted to an authenticated browser session. */
export const sessionProcedure = authenticatedProcedure.use(({ ctx, next }) => {
    if (ctx.principal.kind !== "session") {
        throw new TRPCError({
            code: "FORBIDDEN",
            message: "A browser session is required",
        });
    }
    return next({
        ctx: {
            ...ctx,
            sessionIdentity: {
                sessionId: ctx.principal.authenticatorId,
                userId: ctx.principal.id,
            },
        },
    });
});

/** Application tRPC router factory. */
export const router = trpc.router;
