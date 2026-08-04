import { initTRPC } from "@trpc/server";
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
    transformer: superjson,
});

/** Public procedure builder. Authentication builders are added with the security domain. */
export const publicProcedure = trpc.procedure;

/** Application tRPC router factory. */
export const router = trpc.router;
