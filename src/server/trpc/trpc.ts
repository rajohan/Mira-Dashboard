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
    return next({
        ctx: {
            ...ctx,
            principal: ctx.authentication.principal,
        },
    });
});

/** Application tRPC router factory. */
export const router = trpc.router;
