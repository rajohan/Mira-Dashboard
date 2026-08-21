import { getTime } from "date-fns";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import type { TaskProgressUpdate } from "../../../contracts/taskModel.ts";
import type {
    AddTaskProgressInput,
    DeleteTaskProgressInput,
    DeleteTaskProgressResult,
    UpdateTaskProgressInput,
} from "../../../contracts/tasks.ts";
import {
    changedProgressResult,
    requireTask,
    requireTaskProgress,
    requireTaskProgressVersion,
    requireTaskProgressWrite,
    requireTaskWrite,
    runTaskMutation,
    taskMutationDate,
    type TaskMutationCommit,
    type TaskMutationContext,
    type TaskMutationEnvironment,
} from "./mutationSupport.ts";
import { appendTaskEvent, appendTaskRealtimeEvent } from "./serviceEvents.ts";
import { toTaskProgressUpdate } from "./serviceRecords.ts";
import {
    taskNotificationIntent,
    type TaskNotificationTarget,
} from "./taskNotification.ts";

export interface TaskProgressMutationOperations {
    readonly addTaskProgress: (
        principal: AuthenticatedPrincipal,
        input: AddTaskProgressInput
    ) => Promise<TaskProgressUpdate>;
    readonly deleteTaskProgress: (
        principal: AuthenticatedPrincipal,
        input: DeleteTaskProgressInput
    ) => Promise<DeleteTaskProgressResult>;
    readonly updateTaskProgress: (
        principal: AuthenticatedPrincipal,
        input: UpdateTaskProgressInput
    ) => Promise<TaskProgressUpdate>;
}

function appendProgressMutationRecords(
    context: TaskMutationContext,
    input: {
        readonly eventType: "progress-added" | "progress-deleted" | "progress-updated";
        readonly occurredAt: Date;
        readonly progressVersion: number;
        readonly taskId: string;
        readonly target: TaskNotificationTarget;
        readonly updateId: string;
    }
): void {
    const eventId = appendTaskEvent(context.unit, {
        actor: context.actor,
        eventType: input.eventType,
        generateId: context.environment.generateId,
        occurredAt: input.occurredAt,
        payload: {
            progressVersion: input.progressVersion,
            updateId: input.updateId,
        },
        taskId: input.taskId,
    });
    const notification = taskNotificationIntent({
        actor: context.actor,
        createdAt: input.occurredAt,
        eventId,
        eventType: input.eventType,
        target: input.target,
    });
    if (notification !== undefined) {
        context.unit.insertTaskNotification(notification);
    }
    appendTaskRealtimeEvent(context.unit, {
        operation: "updated",
        occurredAt: input.occurredAt,
        retentionMs: context.environment.realtimeRetentionMs,
        taskId: input.taskId,
    });
}

function addTaskProgress(
    context: TaskMutationContext,
    input: AddTaskProgressInput
): TaskMutationCommit<TaskProgressUpdate> {
    const task = requireTask(context.unit, input.taskId);
    const occurredAt = taskMutationDate(context.environment, task.task.updatedAt);
    const updateId = context.environment.generateId();
    const progress = context.unit.insertTaskProgress({
        authorId: context.actor.id,
        authorKind: context.actor.kind,
        createdAt: occurredAt,
        id: updateId,
        messageMarkdown: input.messageMarkdown,
        taskId: input.taskId,
        updatedAt: occurredAt,
    });
    requireTaskWrite(context.unit.touchTask(input.taskId, occurredAt), input.taskId);
    appendProgressMutationRecords(context, {
        eventType: "progress-added",
        occurredAt,
        progressVersion: progress.version,
        taskId: input.taskId,
        target: {
            assignee: task.task.assignee,
            taskId: input.taskId,
            title: task.task.title,
        },
        updateId,
    });
    return changedProgressResult(
        requireTaskProgress(context.unit, input.taskId, progress.id)
    );
}

function updateTaskProgress(
    context: TaskMutationContext,
    input: UpdateTaskProgressInput
): TaskMutationCommit<TaskProgressUpdate> {
    const task = requireTask(context.unit, input.taskId);
    const existing = requireTaskProgress(context.unit, input.taskId, input.updateId);
    requireTaskProgressVersion(existing, input.expectedVersion);
    if (existing.messageMarkdown === input.messageMarkdown) {
        return { changed: false, result: toTaskProgressUpdate(existing) };
    }
    const occurredAt = taskMutationDate(
        context.environment,
        task.task.updatedAt,
        existing.updatedAt
    );
    const progress = requireTaskProgressWrite(
        context.unit.updateTaskProgress({
            expectedVersion: input.expectedVersion,
            messageMarkdown: input.messageMarkdown,
            taskId: input.taskId,
            updatedAt: occurredAt,
            updateId: input.updateId,
        }),
        input.updateId
    );
    requireTaskWrite(context.unit.touchTask(input.taskId, occurredAt), input.taskId);
    appendProgressMutationRecords(context, {
        eventType: "progress-updated",
        occurredAt,
        progressVersion: progress.version,
        taskId: input.taskId,
        target: {
            assignee: task.task.assignee,
            taskId: input.taskId,
            title: task.task.title,
        },
        updateId: input.updateId,
    });
    return changedProgressResult(
        requireTaskProgress(context.unit, input.taskId, progress.id)
    );
}

function deleteTaskProgress(
    context: TaskMutationContext,
    input: DeleteTaskProgressInput
): TaskMutationCommit<DeleteTaskProgressResult> {
    const task = requireTask(context.unit, input.taskId);
    const existing = requireTaskProgress(context.unit, input.taskId, input.updateId);
    requireTaskProgressVersion(existing, input.expectedVersion);
    const occurredAt = taskMutationDate(
        context.environment,
        task.task.updatedAt,
        existing.updatedAt
    );
    requireTaskProgressWrite(
        context.unit.deleteTaskProgress(
            input.taskId,
            input.updateId,
            input.expectedVersion
        ),
        input.updateId
    );
    requireTaskWrite(context.unit.touchTask(input.taskId, occurredAt), input.taskId);
    appendProgressMutationRecords(context, {
        eventType: "progress-deleted",
        occurredAt,
        progressVersion: existing.version,
        taskId: input.taskId,
        target: {
            assignee: task.task.assignee,
            taskId: input.taskId,
            title: task.task.title,
        },
        updateId: input.updateId,
    });
    return {
        changed: true,
        result: {
            deletedAtMs: getTime(occurredAt),
            taskId: input.taskId,
            updateId: input.updateId,
        },
    };
}

/**
 * Creates task-progress mutation operations over one admitted environment.
 * @param environment Runtime-owned mutation boundaries.
 * @returns Task-progress mutation operations.
 */
export function createTaskProgressMutationOperations(
    environment: TaskMutationEnvironment
): TaskProgressMutationOperations {
    const operations: TaskProgressMutationOperations = {
        addTaskProgress: (principal, input) =>
            runTaskMutation(environment, principal, (context) =>
                addTaskProgress(context, input)
            ),
        deleteTaskProgress: (principal, input) =>
            runTaskMutation(environment, principal, (context) =>
                deleteTaskProgress(context, input)
            ),
        updateTaskProgress: (principal, input) =>
            runTaskMutation(environment, principal, (context) =>
                updateTaskProgress(context, input)
            ),
    };
    return Object.freeze(operations);
}
