import { TRPCError } from "@trpc/server";
import { Effect } from "effect";

import {
    cacheEntrySchema,
    cacheStatusResultSchema,
    getCacheEntryInputSchema,
    refreshCacheEntryInputSchema,
} from "../../../contracts/cache.ts";
import { jobRunSummarySchema } from "../../../contracts/jobModel.ts";
import { emptyInputSchema } from "../../../contracts/system.ts";
import { capabilityProcedure } from "../../trpc/trpc.ts";
import { CacheConflictError, CacheNotFoundError } from "./errors.ts";

async function runCacheEffect<T, E>(effect: Effect.Effect<T, E>): Promise<T> {
    try {
        return await Effect.runPromise(effect);
    } catch (error) {
        if (error instanceof CacheNotFoundError) {
            throw new TRPCError({
                cause: error,
                code: "NOT_FOUND",
                message: "Cache entry was not found",
            });
        }
        if (error instanceof CacheConflictError) {
            throw new TRPCError({
                cause: error,
                code: "CONFLICT",
                message: "Cache refresh state changed",
            });
        }
        throw error;
    }
}

const cacheReadProcedure = capabilityProcedure("cache:read");
const cacheWriteProcedure = capabilityProcedure("cache:write");

/** Capability-scoped cache projection and durable refresh routes. */
export const cacheRoutes = {
    getEntry: cacheReadProcedure
        .input(getCacheEntryInputSchema)
        .output(cacheEntrySchema)
        .query(({ ctx, input }) => runCacheEffect(ctx.cacheService.getEntry(input))),
    getStatus: cacheReadProcedure
        .input(emptyInputSchema)
        .output(cacheStatusResultSchema)
        .query(({ ctx }) => runCacheEffect(ctx.cacheService.getStatus())),
    refreshEntry: cacheWriteProcedure
        .input(refreshCacheEntryInputSchema)
        .output(jobRunSummarySchema)
        .mutation(({ ctx, input }) =>
            runCacheEffect(ctx.cacheService.refreshEntry(ctx.principal, input))
        ),
};
