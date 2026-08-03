import { initTRPC } from "@trpc/server";

import type { RequestContext } from "./context.ts";

const trpc = initTRPC.context<RequestContext>().create();

/** Public procedure builder. Authentication builders are added with the security domain. */
export const publicProcedure = trpc.procedure;

/** Greenfield tRPC router factory. */
export const router = trpc.router;
