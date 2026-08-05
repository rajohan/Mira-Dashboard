import { initTRPC, TRPCError } from "@trpc/server";
import { secondsToMilliseconds } from "date-fns";
import superjson from "superjson";

import type { RequestContext } from "./context.ts";

const internalErrorMessage = "Internal server error";

const trpc = initTRPC.context<RequestContext>().create({
    errorFormatter({ error, shape }) {
        const { path: _path, stack: _stack, ...safeData } = shape.data;
        return {
            ...shape,
            data: safeData,
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

/** Base procedure builder for explicitly public contracts. */
export const publicProcedure = trpc.procedure;

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
