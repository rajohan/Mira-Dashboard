import { TRPCError } from "@trpc/server";

import {
    runtimeIdentityContract,
    systemHealthDiagnosticsContract,
    systemMetricsContract,
} from "../../../contracts/system.ts";
import { readRuntimeIdentity } from "../../platform/runtime/readRuntimeIdentity.ts";
import { publicProcedure, router, sessionProcedure } from "../../trpc/trpc.ts";
import { SystemMetricsUnavailableError } from "./systemMetricsService.ts";

const systemRoutes = {
    healthDiagnostics: sessionProcedure
        .input(systemHealthDiagnosticsContract.input)
        .output(systemHealthDiagnosticsContract.output)
        .query(({ ctx }) => ctx.systemHealthDiagnosticsService.read()),
    metrics: sessionProcedure
        .input(systemMetricsContract.input)
        .output(systemMetricsContract.output)
        .query(async ({ ctx }) => {
            try {
                return await ctx.services.systemMetrics.read();
            } catch (error) {
                if (!(error instanceof SystemMetricsUnavailableError)) throw error;
                throw new TRPCError({
                    cause: error,
                    code: "SERVICE_UNAVAILABLE",
                    message: "System metrics are temporarily unavailable",
                });
            }
        }),
    runtimeIdentity: publicProcedure
        .input(runtimeIdentityContract.input)
        .output(runtimeIdentityContract.output)
        .query(() => readRuntimeIdentity()),
};

/** Leaf procedure names owned by the system-router composition. */
export const systemProcedureNames = Object.freeze(Object.keys(systemRoutes));

/** Public identity plus session-only health and system metric procedures. */
export const systemRouter = router(systemRoutes);
