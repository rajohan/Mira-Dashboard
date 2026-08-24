import {
    completeMonitoringSnapshotInputSchema,
    monitoringSubmissionResultSchema,
} from "../../../contracts/monitoring.ts";
import { principalKindProcedure } from "../../trpc/trpc.ts";
import { runMonitoringEffect } from "./routeEffects.ts";

const monitoringProducerProcedure = principalKindProcedure(
    "monitoring:write",
    "automation",
    "An automation principal is required"
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
