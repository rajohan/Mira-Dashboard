import { TRPCError } from "@trpc/server";

import {
    completeMonitoringSnapshotInputSchema,
    monitoringSubmissionResultSchema,
} from "../../../contracts/monitoring.ts";
import { capabilityProcedure } from "../../trpc/trpc.ts";
import { runMonitoringEffect } from "./routeEffects.ts";

const monitoringProducerProcedure = capabilityProcedure("monitoring:write").use(
    ({ ctx, next }) => {
        if (ctx.principal.kind !== "automation") {
            throw new TRPCError({
                code: "FORBIDDEN",
                message: "An automation principal is required",
            });
        }
        return next({ ctx });
    }
);

/** Automation-only complete-snapshot ingestion routes. */
export const monitoringRoutes = {
    submitCompleteSnapshot: monitoringProducerProcedure
        .input(completeMonitoringSnapshotInputSchema)
        .output(monitoringSubmissionResultSchema)
        .mutation(({ ctx, input }) =>
            runMonitoringEffect(ctx.monitoringService.submitCompleteSnapshot(input))
        ),
};
