import { TRPCError } from "@trpc/server";
import { Effect } from "effect";

import {
    jobRunSummarySchema,
    jobWorkerControlSchema,
    scheduleSummarySchema,
} from "../../../contracts/jobModel.ts";
import {
    cancelJobRunInputSchema,
    getJobRunInputSchema,
    jobRunDetailSchema,
    listJobRunsInputSchema,
    listJobRunsResultSchema,
    setJobClaimingPausedInputSchema,
} from "../../../contracts/jobs.ts";
import {
    getScheduleInputSchema,
    listScheduleRunsInputSchema,
    listScheduleRunsResultSchema,
    listSchedulesInputSchema,
    listSchedulesResultSchema,
    runScheduleInputSchema,
    updateScheduleInputSchema,
} from "../../../contracts/schedules.ts";
import { capabilityProcedure, principalKindProcedure } from "../../trpc/trpc.ts";
import { JobConflictError, JobNotFoundError, JobValidationError } from "./errors.ts";

async function runJobEffect<T, E>(effect: Effect.Effect<T, E>): Promise<T> {
    try {
        return await Effect.runPromise(effect);
    } catch (error) {
        if (error instanceof JobNotFoundError) {
            throw new TRPCError({
                cause: error,
                code: "NOT_FOUND",
                message: "Job resource was not found",
            });
        }
        if (error instanceof JobConflictError) {
            throw new TRPCError({
                cause: error,
                code: "CONFLICT",
                message: "Job state changed concurrently",
            });
        }
        if (error instanceof JobValidationError) {
            throw new TRPCError({
                cause: error,
                code: "BAD_REQUEST",
                message: "Schedule update is no longer valid",
            });
        }
        throw error;
    }
}

const readProcedure = capabilityProcedure("jobs:read");
const sessionWriteProcedure = principalKindProcedure(
    "jobs:write",
    "session",
    "A user session is required"
);
const runProcedure = capabilityProcedure("jobs:write");

/** Capability-scoped durable run and worker-control routes. */
export const jobRoutes = {
    cancelRun: sessionWriteProcedure
        .input(cancelJobRunInputSchema)
        .output(jobRunSummarySchema)
        .mutation(({ ctx, input }) =>
            runJobEffect(ctx.jobService.cancelRun(ctx.principal, input))
        ),
    getRun: readProcedure
        .input(getJobRunInputSchema)
        .output(jobRunDetailSchema)
        .query(({ ctx, input }) => runJobEffect(ctx.jobService.getRun(input))),
    listRuns: readProcedure
        .input(listJobRunsInputSchema)
        .output(listJobRunsResultSchema)
        .query(({ ctx, input }) => runJobEffect(ctx.jobService.listRuns(input))),
    setClaimingPaused: sessionWriteProcedure
        .input(setJobClaimingPausedInputSchema)
        .output(jobWorkerControlSchema)
        .mutation(({ ctx, input }) =>
            runJobEffect(ctx.jobService.setClaimingPaused(ctx.principal, input))
        ),
};

/** Capability-scoped Dashboard-local schedule routes. */
export const scheduleRoutes = {
    get: readProcedure
        .input(getScheduleInputSchema)
        .output(scheduleSummarySchema)
        .query(({ ctx, input }) => runJobEffect(ctx.jobService.getSchedule(input))),
    list: readProcedure
        .input(listSchedulesInputSchema)
        .output(listSchedulesResultSchema)
        .query(({ ctx, input }) => runJobEffect(ctx.jobService.listSchedules(input))),
    listRuns: readProcedure
        .input(listScheduleRunsInputSchema)
        .output(listScheduleRunsResultSchema)
        .query(({ ctx, input }) => runJobEffect(ctx.jobService.listScheduleRuns(input))),
    run: runProcedure
        .input(runScheduleInputSchema)
        .output(jobRunSummarySchema)
        .mutation(({ ctx, input }) =>
            runJobEffect(ctx.jobService.runSchedule(ctx.principal, input))
        ),
    update: sessionWriteProcedure
        .input(updateScheduleInputSchema)
        .output(scheduleSummarySchema)
        .mutation(({ ctx, input }) =>
            runJobEffect(ctx.jobService.updateSchedule(ctx.principal, input))
        ),
};
