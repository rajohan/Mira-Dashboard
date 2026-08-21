import { TRPCError } from "@trpc/server";
import { Effect } from "effect";
import * as v from "valibot";

import {
    type TaskDetail,
    type TaskSummary,
    taskDetailSchema,
    taskProgressUpdateSchema,
    taskSummarySchema,
} from "../../../contracts/taskModel.ts";
import {
    addTaskProgressInputSchema,
    assignTaskInputSchema,
    createTaskInputSchema,
    deleteTaskInputSchema,
    deleteTaskProgressInputSchema,
    getTaskInputSchema,
    listTaskLabelsInputSchema,
    listTaskLabelsResultSchema,
    listTaskProgressInputSchema,
    listTaskProgressResultSchema,
    listTasksInputSchema,
    listTasksResultSchema,
    moveTaskInputSchema,
    taskDeletionResultSchema,
    taskProgressDeletionResultSchema,
    updateTaskInputSchema,
    updateTaskProgressInputSchema,
} from "../../../contracts/tasks.ts";
import { capabilityProcedure } from "../../trpc/trpc.ts";
import { TaskConflictError, TaskNotFoundError } from "./errors.ts";

async function runTaskEffect<T, E>(effect: Effect.Effect<T, E>): Promise<T> {
    try {
        return await Effect.runPromise(effect);
    } catch (error) {
        if (error instanceof TaskNotFoundError) {
            throw new TRPCError({
                cause: error,
                code: "NOT_FOUND",
                message: "Task resource was not found",
            });
        }
        if (error instanceof TaskConflictError) {
            throw new TRPCError({
                cause: error,
                code: "CONFLICT",
                message: "Task state changed",
            });
        }
        throw error;
    }
}

function mutableTaskSummary(task: TaskSummary): v.InferInput<typeof taskSummarySchema> {
    return { ...task, labels: [...task.labels] };
}

function mutableTaskDetail(task: TaskDetail): v.InferInput<typeof taskDetailSchema> {
    return { ...task, labels: [...task.labels] };
}

const taskReadProcedure = capabilityProcedure("tasks:read");
const taskWriteProcedure = capabilityProcedure("tasks:write");

/** Capability-scoped task board and progress routes. */
export const taskRoutes = {
    addUpdate: taskWriteProcedure
        .input(addTaskProgressInputSchema)
        .output(taskProgressUpdateSchema)
        .mutation(({ ctx, input }) =>
            runTaskEffect(ctx.taskService.addTaskProgress(ctx.principal, input))
        ),
    assign: taskWriteProcedure
        .input(assignTaskInputSchema)
        .output(taskDetailSchema)
        .mutation(async ({ ctx, input }) =>
            mutableTaskDetail(
                await runTaskEffect(ctx.taskService.assignTask(ctx.principal, input))
            )
        ),
    create: taskWriteProcedure
        .input(createTaskInputSchema)
        .output(taskDetailSchema)
        .mutation(async ({ ctx, input }) =>
            mutableTaskDetail(
                await runTaskEffect(ctx.taskService.createTask(ctx.principal, input))
            )
        ),
    delete: taskWriteProcedure
        .input(deleteTaskInputSchema)
        .output(taskDeletionResultSchema)
        .mutation(({ ctx, input }) =>
            runTaskEffect(ctx.taskService.deleteTask(ctx.principal, input))
        ),
    deleteProgress: taskWriteProcedure
        .input(deleteTaskProgressInputSchema)
        .output(taskProgressDeletionResultSchema)
        .mutation(({ ctx, input }) =>
            runTaskEffect(ctx.taskService.deleteTaskProgress(ctx.principal, input))
        ),
    get: taskReadProcedure
        .input(getTaskInputSchema)
        .output(taskDetailSchema)
        .query(async ({ ctx, input }) =>
            mutableTaskDetail(await runTaskEffect(ctx.taskService.getTask(input)))
        ),
    list: taskReadProcedure
        .input(listTasksInputSchema)
        .output(listTasksResultSchema)
        .query(async ({ ctx, input }) => {
            const result = await runTaskEffect(ctx.taskService.listTasks(input));
            return {
                ...result,
                tasks: result.tasks.map((task) => mutableTaskSummary(task)),
            };
        }),
    listLabels: taskReadProcedure
        .input(listTaskLabelsInputSchema)
        .output(listTaskLabelsResultSchema)
        .query(async ({ ctx }) => {
            const result = await runTaskEffect(ctx.taskService.listTaskLabels());
            return { ...result, labels: [...result.labels] };
        }),
    listUpdates: taskReadProcedure
        .input(listTaskProgressInputSchema)
        .output(listTaskProgressResultSchema)
        .query(({ ctx, input }) =>
            runTaskEffect(ctx.taskService.listTaskProgress(input))
        ),
    move: taskWriteProcedure
        .input(moveTaskInputSchema)
        .output(taskDetailSchema)
        .mutation(async ({ ctx, input }) =>
            mutableTaskDetail(
                await runTaskEffect(ctx.taskService.moveTask(ctx.principal, input))
            )
        ),
    update: taskWriteProcedure
        .input(updateTaskInputSchema)
        .output(taskDetailSchema)
        .mutation(async ({ ctx, input }) =>
            mutableTaskDetail(
                await runTaskEffect(ctx.taskService.updateTask(ctx.principal, input))
            )
        ),
    updateProgress: taskWriteProcedure
        .input(updateTaskProgressInputSchema)
        .output(taskProgressUpdateSchema)
        .mutation(({ ctx, input }) =>
            runTaskEffect(ctx.taskService.updateTaskProgress(ctx.principal, input))
        ),
};
