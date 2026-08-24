import { TRPCError } from "@trpc/server";

import {
    openClawTaskCancelInputSchema,
    openClawTaskCancelOutputSchema,
    openClawTaskGetInputSchema,
    openClawTaskGetOutputSchema,
    openClawTaskListInputSchema,
    openClawTaskListOutputSchema,
} from "../../../contracts/openClawTasks.ts";
import type { RequestContext } from "../../trpc/context.ts";
import { capabilityProcedure, operationOutcomeUnknownError } from "../../trpc/trpc.ts";
import { type OpenClawTasksService, OpenClawTasksServiceError } from "./service.ts";

interface OpenClawTasksContextPort {
    readonly openClawTasksService?: OpenClawTasksService;
}

function tasksService(context: RequestContext): OpenClawTasksService {
    const service = (context as RequestContext & OpenClawTasksContextPort)
        .openClawTasksService;
    if (service === undefined) {
        throw new Error("Request context is missing the OpenClaw tasks service");
    }
    return service;
}

function throwServiceFailure(error: unknown): never {
    if (!(error instanceof OpenClawTasksServiceError)) throw error;
    if (error.reason === "not-found") {
        throw new TRPCError({
            cause: error,
            code: "NOT_FOUND",
            message: "OpenClaw task was not found",
        });
    }
    if (error.reason === "unknown-outcome") {
        throw operationOutcomeUnknownError(
            "OpenClaw task cancellation outcome could not be confirmed"
        );
    }
    throw new TRPCError({
        cause: error,
        code: "SERVICE_UNAVAILABLE",
        message: "OpenClaw tasks are temporarily unavailable",
    });
}

const readProcedure = capabilityProcedure("openclaw-tasks:read");
const writeProcedure = capabilityProcedure("openclaw-tasks:write");

export const openClawTaskRoutes = {
    cancel: writeProcedure
        .input(openClawTaskCancelInputSchema)
        .output(openClawTaskCancelOutputSchema)
        .mutation(async ({ ctx, input, signal }) => {
            try {
                return await tasksService(ctx).cancel(input, signal);
            } catch (error) {
                if (
                    error instanceof OpenClawTasksServiceError &&
                    error.reason === "not-found"
                ) {
                    return { cancelled: false, found: false };
                }
                return throwServiceFailure(error);
            }
        }),
    get: readProcedure
        .input(openClawTaskGetInputSchema)
        .output(openClawTaskGetOutputSchema)
        .query(async ({ ctx, input, signal }) => {
            try {
                return await tasksService(ctx).get(input, signal);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    list: readProcedure
        .input(openClawTaskListInputSchema)
        .output(openClawTaskListOutputSchema)
        .query(async ({ ctx, input, signal }) => {
            try {
                return await tasksService(ctx).list(input, signal);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
};
