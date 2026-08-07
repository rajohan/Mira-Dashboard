import { max as maximumDate } from "date-fns";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import type {
    TaskAutomationProfileInput,
    TaskProgressUpdate,
} from "../../../contracts/taskModel.ts";
import { TaskConflictError, TaskNotFoundError } from "./errors.ts";
import type {
    TaskAggregateRecord,
    TaskAutomationProfileInsert,
    TaskLabelInsert,
    TaskProgressRecord,
    TaskRecord,
    TaskRepository,
    TaskRepositoryUnitOfWork,
} from "./repositoryTypes.ts";
import { taskOperationActor, type TaskOperationActor } from "./serviceEvents.ts";
import { toTaskProgressUpdate } from "./serviceRecords.ts";

export interface TaskMutationEnvironment {
    readonly generateId: () => string;
    readonly now: () => Date;
    readonly realtimeRetentionMs: number;
    readonly repository: TaskRepository;
    readonly wakeEventPump?: () => Promise<void> | void;
}

export interface TaskMutationContext {
    readonly actor: TaskOperationActor;
    readonly environment: TaskMutationEnvironment;
    readonly unit: TaskRepositoryUnitOfWork;
}

export interface TaskMutationCommit<T> {
    readonly changed: boolean;
    readonly result: T;
}

/**
 * Runs one admitted transaction and wakes realtime delivery only after commit.
 * @param environment Runtime-owned mutation boundaries.
 * @param principal Authenticated task actor.
 * @param operation Synchronous transaction callback.
 * @returns Committed mutation result.
 */
export async function runTaskMutation<T>(
    environment: TaskMutationEnvironment,
    principal: AuthenticatedPrincipal,
    operation: (context: TaskMutationContext) => TaskMutationCommit<T>
): Promise<T> {
    const committed = await environment.repository.withImmediateTransaction((unit) =>
        operation({
            actor: taskOperationActor(principal),
            environment,
            unit,
        })
    );
    if (committed.changed && environment.wakeEventPump !== undefined) {
        try {
            await environment.wakeEventPump();
        } catch {
            // SQLite remains authoritative; adaptive polling recovers a missed wakeup.
        }
    }
    return committed.result;
}

/**
 * Uses a nondecreasing operation timestamp when the process clock moves backwards.
 * @param environment Runtime-owned clock.
 * @param existingDates Existing durable timestamps that must not move backwards.
 * @returns Current nondecreasing operation timestamp.
 */
export function taskMutationDate(
    environment: TaskMutationEnvironment,
    ...existingDates: readonly Date[]
): Date {
    return maximumDate([environment.now(), ...existingDates]);
}

export function requireTask(
    unit: TaskRepositoryUnitOfWork,
    taskId: string
): TaskAggregateRecord {
    const record = unit.findTask(taskId);
    if (record === undefined) {
        throw new TaskNotFoundError({
            message: "Task was not found",
            resourceId: taskId,
        });
    }
    return record;
}

export function requireTaskVersion(task: TaskRecord, expectedVersion: number): void {
    if (task.version !== expectedVersion) {
        throw new TaskConflictError({
            message: "Task version changed",
            resourceId: task.id,
        });
    }
}

export function requireTaskWrite(
    task: TaskRecord | undefined,
    taskId: string
): TaskRecord {
    if (task === undefined) {
        throw new TaskConflictError({
            message: "Task changed during mutation",
            resourceId: taskId,
        });
    }
    return task;
}

export function requireTaskProgress(
    unit: TaskRepositoryUnitOfWork,
    taskId: string,
    updateId: string
): TaskProgressRecord {
    const record = unit.findTaskProgress(taskId, updateId);
    if (record === undefined) {
        throw new TaskNotFoundError({
            message: "Task progress update was not found",
            resourceId: updateId,
        });
    }
    return record;
}

export function requireTaskProgressVersion(
    progress: TaskProgressRecord,
    expectedVersion: number
): void {
    if (progress.version !== expectedVersion) {
        throw new TaskConflictError({
            message: "Task progress version changed",
            resourceId: progress.id,
        });
    }
}

export function requireTaskProgressWrite(
    progress: TaskProgressRecord | undefined,
    updateId: string
): TaskProgressRecord {
    if (progress === undefined) {
        throw new TaskConflictError({
            message: "Task progress changed during mutation",
            resourceId: updateId,
        });
    }
    return progress;
}

export function taskLabelInserts(
    taskId: string,
    labels: readonly string[]
): readonly TaskLabelInsert[] {
    return labels.map((label) => ({ label, taskId }));
}

export function taskAutomationInsert(
    taskId: string,
    input: TaskAutomationProfileInput
): TaskAutomationProfileInsert {
    return {
        cronJobId: input.cronJobId,
        kind: input.kind,
        model: input.model ?? null,
        recurring: input.recurring,
        scheduleSummary: input.scheduleSummary ?? null,
        sessionTarget: input.sessionTarget ?? null,
        taskId,
        thinking: input.thinking ?? null,
    };
}

export function changedProgressResult(
    progress: TaskProgressRecord
): TaskMutationCommit<TaskProgressUpdate> {
    return { changed: true, result: toTaskProgressUpdate(progress) };
}
