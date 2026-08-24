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
import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { appendClearedDashboardSessionCookie } from "../../rawHttp/sessionCookie.ts";
import type { RequestContext } from "../../trpc/context.ts";
import {
    authenticationPolicyError,
    capabilityProcedure,
    sessionCapabilityProcedure,
} from "../../trpc/trpc.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";
import {
    jobScheduleAllowsAutomationManualRun,
    jobScheduleManualRunCapability,
} from "./actionRegistry.ts";
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
const sessionWriteProcedure = sessionCapabilityProcedure("jobs:write");
const runProcedure = capabilityProcedure("jobs:write");

function authorizeManualScheduleRun(
    context: RequestContext & {
        readonly principal: AuthenticatedPrincipal;
    },
    schedule: { readonly actionKey: string; readonly id: string }
): void {
    if (jobScheduleAllowsAutomationManualRun(schedule.id, schedule.actionKey)) {
        return;
    }
    if (context.principal.kind === "automation") {
        throw new TRPCError({
            code: "FORBIDDEN",
            message: "A browser session is required",
        });
    }
    if (
        !context.principal.capabilities.includes(
            jobScheduleManualRunCapability(schedule.actionKey)
        )
    ) {
        throw new TRPCError({
            code: "FORBIDDEN",
            message: "Required schedule capability is not granted",
        });
    }
    const sessionIdentity: AuthenticatedBrowserIdentity = {
        sessionId: context.principal.authenticatorId,
        userId: context.principal.id,
    };
    const status = context.authenticationLifecycle.authorizeRecentMfa(sessionIdentity);
    if (status === "authorized") return;
    if (status === "mfa-enrollment-required") {
        throw authenticationPolicyError(
            "mfa_enrollment_required",
            "Multi-factor authentication enrollment is required"
        );
    }
    if (status === "step-up-required") {
        throw authenticationPolicyError(
            "step_up_required",
            "Recent multi-factor authentication is required"
        );
    }
    appendClearedDashboardSessionCookie(context.responseHeaders);
    throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Authentication state changed; sign in again",
    });
}

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
        .mutation(async ({ ctx, input }) => {
            const schedule = await runJobEffect(ctx.jobService.getSchedule(input));
            authorizeManualScheduleRun(ctx, schedule);
            return runJobEffect(ctx.jobService.runSchedule(ctx.principal, input));
        }),
    update: sessionWriteProcedure
        .input(updateScheduleInputSchema)
        .output(scheduleSummarySchema)
        .mutation(({ ctx, input }) =>
            runJobEffect(ctx.jobService.updateSchedule(ctx.principal, input))
        ),
};
