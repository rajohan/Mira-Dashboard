import { getTime } from "date-fns";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import type { TaskDetail } from "../../../contracts/taskModel.ts";
import type {
    AssignTaskInput,
    CreateTaskInput,
    DeleteTaskInput,
    DeleteTaskResult,
    MoveTaskInput,
    UpdateTaskInput,
} from "../../../contracts/tasks.ts";
import type { JsonObject } from "../../../shared/json.ts";
import { TaskConflictError } from "./errors.ts";
import {
    requireTask,
    requireTaskAutomationWrite,
    requireTaskVersion,
    requireTaskWrite,
    runTaskMutation,
    taskAutomationInsert,
    taskLabelInserts,
    taskMutationDate,
    type TaskMutationCommit,
    type TaskMutationContext,
    type TaskMutationEnvironment,
} from "./mutationSupport.ts";
import type { TaskAggregateRecord, TaskMutableUpdate } from "./repositoryTypes.ts";
import { appendTaskEvent, appendTaskRealtimeEvent } from "./serviceEvents.ts";
import { taskAutomationEqual, taskLabelsEqual, toTaskDetail } from "./serviceRecords.ts";
import {
    taskNotificationIntent,
    type TaskNotificationTarget,
} from "./taskNotification.ts";

export interface TaskMutationOperations {
    readonly assignTask: (
        principal: AuthenticatedPrincipal,
        input: AssignTaskInput
    ) => Promise<TaskDetail>;
    readonly createTask: (
        principal: AuthenticatedPrincipal,
        input: CreateTaskInput
    ) => Promise<TaskDetail>;
    readonly deleteTask: (
        principal: AuthenticatedPrincipal,
        input: DeleteTaskInput
    ) => Promise<DeleteTaskResult>;
    readonly moveTask: (
        principal: AuthenticatedPrincipal,
        input: MoveTaskInput
    ) => Promise<TaskDetail>;
    readonly updateTask: (
        principal: AuthenticatedPrincipal,
        input: UpdateTaskInput
    ) => Promise<TaskDetail>;
}

function appendMutationRecords(
    context: TaskMutationContext,
    input: {
        readonly eventType: "assigned" | "created" | "deleted" | "moved" | "updated";
        readonly occurredAt: Date;
        readonly operation: "created" | "deleted" | "updated";
        readonly payload: JsonObject;
        readonly taskId: string;
        readonly target: TaskNotificationTarget;
    }
): void {
    const eventId = appendTaskEvent(context.unit, {
        actor: context.actor,
        eventType: input.eventType,
        generateId: context.environment.generateId,
        occurredAt: input.occurredAt,
        payload: input.payload,
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
        operation: input.operation,
        occurredAt: input.occurredAt,
        retentionMs: context.environment.realtimeRetentionMs,
        taskId: input.taskId,
    });
}

function requireUpdatedAggregate(
    context: TaskMutationContext,
    taskId: string
): TaskAggregateRecord {
    const record = context.unit.findTask(taskId);
    if (record === undefined) {
        throw new TaskConflictError({
            message: "Task relationships changed during mutation",
            resourceId: taskId,
        });
    }
    return record;
}

function createTask(
    context: TaskMutationContext,
    input: CreateTaskInput
): TaskMutationCommit<TaskDetail> {
    const occurredAt = taskMutationDate(context.environment);
    const taskId = context.environment.generateId();
    const inserted = context.unit.insertTask({
        assignee: input.assignee ?? null,
        bodyMarkdown: input.bodyMarkdown ?? null,
        createdAt: occurredAt,
        id: taskId,
        priority: input.priority ?? "medium",
        status: input.status ?? "todo",
        title: input.title,
        updatedAt: occurredAt,
    });
    if (inserted === undefined) {
        throw new TaskConflictError({
            message: "Task identity already exists",
            resourceId: taskId,
        });
    }
    context.unit.replaceTaskLabels(taskId, taskLabelInserts(taskId, input.labels ?? []));
    requireTaskAutomationWrite(
        context.unit.replaceTaskAutomation(
            taskId,
            input.automation === undefined
                ? undefined
                : taskAutomationInsert(taskId, input.automation)
        ),
        taskId
    );
    appendMutationRecords(context, {
        eventType: "created",
        occurredAt,
        operation: "created",
        payload: {
            priority: inserted.priority,
            status: inserted.status,
            version: inserted.version,
        },
        taskId,
        target: {
            assignee: inserted.assignee,
            taskId,
            title: inserted.title,
        },
    });
    return {
        changed: true,
        result: toTaskDetail(requireUpdatedAggregate(context, taskId)),
    };
}

function updateTask(
    context: TaskMutationContext,
    input: UpdateTaskInput
): TaskMutationCommit<TaskDetail> {
    const existing = requireTask(context.unit, input.id);
    requireTaskVersion(existing.task, input.expectedVersion);

    const changes: TaskMutableUpdate = {};
    const changedFields: string[] = [];
    if (
        input.patch.bodyMarkdown !== undefined &&
        input.patch.bodyMarkdown !== existing.task.bodyMarkdown
    ) {
        changes.bodyMarkdown = input.patch.bodyMarkdown;
        changedFields.push("bodyMarkdown");
    }
    if (
        input.patch.priority !== undefined &&
        input.patch.priority !== existing.task.priority
    ) {
        changes.priority = input.patch.priority;
        changedFields.push("priority");
    }
    if (input.patch.title !== undefined && input.patch.title !== existing.task.title) {
        changes.title = input.patch.title;
        changedFields.push("title");
    }
    const labelsChanged =
        input.patch.labels !== undefined &&
        !taskLabelsEqual(existing, input.patch.labels);
    if (labelsChanged) changedFields.push("labels");
    const automationChanged =
        input.patch.automation !== undefined &&
        !taskAutomationEqual(existing.automation, input.patch.automation);
    if (automationChanged) changedFields.push("automation");
    if (changedFields.length === 0) {
        return { changed: false, result: toTaskDetail(existing) };
    }

    const occurredAt = taskMutationDate(context.environment, existing.task.updatedAt);
    requireTaskWrite(
        context.unit.updateTask({
            changes,
            expectedVersion: input.expectedVersion,
            id: input.id,
            updatedAt: occurredAt,
        }),
        input.id
    );
    if (labelsChanged && input.patch.labels !== undefined) {
        context.unit.replaceTaskLabels(
            input.id,
            taskLabelInserts(input.id, input.patch.labels)
        );
    }
    if (automationChanged && input.patch.automation !== undefined) {
        requireTaskAutomationWrite(
            context.unit.replaceTaskAutomation(
                input.id,
                input.patch.automation === null
                    ? undefined
                    : taskAutomationInsert(input.id, input.patch.automation)
            ),
            input.id
        );
    }
    appendMutationRecords(context, {
        eventType: "updated",
        occurredAt,
        operation: "updated",
        payload: { changedFields },
        taskId: input.id,
        target: {
            assignee: existing.task.assignee,
            taskId: input.id,
            title: input.patch.title ?? existing.task.title,
        },
    });
    return {
        changed: true,
        result: toTaskDetail(requireUpdatedAggregate(context, input.id)),
    };
}

function assignTask(
    context: TaskMutationContext,
    input: AssignTaskInput
): TaskMutationCommit<TaskDetail> {
    const existing = requireTask(context.unit, input.id);
    requireTaskVersion(existing.task, input.expectedVersion);
    if (existing.task.assignee === input.assignee) {
        return { changed: false, result: toTaskDetail(existing) };
    }
    const occurredAt = taskMutationDate(context.environment, existing.task.updatedAt);
    const updated = requireTaskWrite(
        context.unit.updateTask({
            changes: { assignee: input.assignee },
            expectedVersion: input.expectedVersion,
            id: input.id,
            updatedAt: occurredAt,
        }),
        input.id
    );
    appendMutationRecords(context, {
        eventType: "assigned",
        occurredAt,
        operation: "updated",
        payload: {
            assignee: input.assignee,
            previousAssignee: existing.task.assignee,
            version: updated.version,
        },
        taskId: input.id,
        target: {
            assignee: input.assignee,
            detail: input.assignee ?? "unassigned",
            previousAssignee: existing.task.assignee,
            taskId: input.id,
            title: existing.task.title,
        },
    });
    return {
        changed: true,
        result: toTaskDetail(requireUpdatedAggregate(context, input.id)),
    };
}

function moveTask(
    context: TaskMutationContext,
    input: MoveTaskInput
): TaskMutationCommit<TaskDetail> {
    const existing = requireTask(context.unit, input.id);
    requireTaskVersion(existing.task, input.expectedVersion);
    if (existing.task.status === input.status) {
        return { changed: false, result: toTaskDetail(existing) };
    }
    const occurredAt = taskMutationDate(context.environment, existing.task.updatedAt);
    const updated = requireTaskWrite(
        context.unit.updateTask({
            changes: { status: input.status },
            expectedVersion: input.expectedVersion,
            id: input.id,
            updatedAt: occurredAt,
        }),
        input.id
    );
    appendMutationRecords(context, {
        eventType: "moved",
        occurredAt,
        operation: "updated",
        payload: {
            previousStatus: existing.task.status,
            status: input.status,
            version: updated.version,
        },
        taskId: input.id,
        target: {
            assignee: existing.task.assignee,
            detail: input.status,
            taskId: input.id,
            title: existing.task.title,
        },
    });
    return {
        changed: true,
        result: toTaskDetail(requireUpdatedAggregate(context, input.id)),
    };
}

function deleteTask(
    context: TaskMutationContext,
    input: DeleteTaskInput
): TaskMutationCommit<DeleteTaskResult> {
    const existing = requireTask(context.unit, input.id);
    requireTaskVersion(existing.task, input.expectedVersion);
    const occurredAt = taskMutationDate(context.environment, existing.task.updatedAt);
    requireTaskWrite(context.unit.deleteTask(input.id, input.expectedVersion), input.id);
    appendMutationRecords(context, {
        eventType: "deleted",
        occurredAt,
        operation: "deleted",
        payload: { version: existing.task.version },
        taskId: input.id,
        target: {
            assignee: existing.task.assignee,
            taskId: input.id,
            title: existing.task.title,
        },
    });
    return {
        changed: true,
        result: { deletedAtMs: getTime(occurredAt), id: input.id },
    };
}

/**
 * Creates all task-row mutation operations over one admitted environment.
 * @param environment Runtime-owned mutation boundaries.
 * @returns Task-row mutation operations.
 */
export function createTaskMutationOperations(
    environment: TaskMutationEnvironment
): TaskMutationOperations {
    const operations: TaskMutationOperations = {
        assignTask: (principal, input) =>
            runTaskMutation(environment, principal, (context) =>
                assignTask(context, input)
            ),
        createTask: (principal, input) =>
            runTaskMutation(environment, principal, (context) =>
                createTask(context, input)
            ),
        deleteTask: (principal, input) =>
            runTaskMutation(environment, principal, (context) =>
                deleteTask(context, input)
            ),
        moveTask: (principal, input) =>
            runTaskMutation(environment, principal, (context) =>
                moveTask(context, input)
            ),
        updateTask: (principal, input) =>
            runTaskMutation(environment, principal, (context) =>
                updateTask(context, input)
            ),
    };
    return Object.freeze(operations);
}
