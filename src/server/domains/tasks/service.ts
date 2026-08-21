import { toDate } from "date-fns";
import { Context, Data, Effect, Layer } from "effect";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import type { TaskDetail, TaskProgressUpdate } from "../../../contracts/taskModel.ts";
import type {
    AddTaskProgressInput,
    AssignTaskInput,
    CreateTaskInput,
    DeleteTaskInput,
    DeleteTaskProgressInput,
    DeleteTaskProgressResult,
    DeleteTaskResult,
    GetTaskInput,
    ListTaskLabelsResult,
    ListTaskProgressInput,
    ListTaskProgressResult,
    ListTasksInput,
    ListTasksResult,
    MoveTaskInput,
    UpdateTaskInput,
    UpdateTaskProgressInput,
} from "../../../contracts/tasks.ts";
import { timestampMillisecondsSchema } from "../../../shared/dateTime.ts";
import {
    parseSchemaWithRangeError,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import { isDatabaseRuntimeWriteUnavailableError } from "../../database/runtime/databaseErrors.ts";
import { defaultRealtimeRetentionMilliseconds } from "../realtime/retention.ts";
import {
    TaskConflictError,
    TaskNotFoundError,
    type TaskOperationError,
} from "./errors.ts";
import { createTaskQueryOperations } from "./queries.ts";
import type { TaskRepository } from "./repositoryTypes.ts";
import { createTaskMutationOperations } from "./taskMutations.ts";
import { createTaskProgressMutationOperations } from "./taskProgressMutations.ts";

const realtimeRetentionSchema = positiveSafeIntegerSchema(
    "Task realtime retention must be a positive integer"
);
const clockMillisecondsSchema = timestampMillisecondsSchema(
    "Task clock must return valid Date milliseconds"
);

class TaskUnexpectedOperationError extends Data.TaggedError(
    "TaskUnexpectedOperationError"
)<{ readonly cause: unknown }> {}

interface TaskServiceShape {
    readonly addTaskProgress: (
        principal: AuthenticatedPrincipal,
        input: AddTaskProgressInput
    ) => Effect.Effect<TaskProgressUpdate, TaskOperationError>;
    readonly assignTask: (
        principal: AuthenticatedPrincipal,
        input: AssignTaskInput
    ) => Effect.Effect<TaskDetail, TaskOperationError>;
    readonly createTask: (
        principal: AuthenticatedPrincipal,
        input: CreateTaskInput
    ) => Effect.Effect<TaskDetail, TaskOperationError>;
    readonly deleteTask: (
        principal: AuthenticatedPrincipal,
        input: DeleteTaskInput
    ) => Effect.Effect<DeleteTaskResult, TaskOperationError>;
    readonly deleteTaskProgress: (
        principal: AuthenticatedPrincipal,
        input: DeleteTaskProgressInput
    ) => Effect.Effect<DeleteTaskProgressResult, TaskOperationError>;
    readonly getTask: (
        input: GetTaskInput
    ) => Effect.Effect<TaskDetail, TaskNotFoundError>;
    readonly listTaskLabels: () => Effect.Effect<ListTaskLabelsResult>;
    readonly listTaskProgress: (
        input: ListTaskProgressInput
    ) => Effect.Effect<ListTaskProgressResult, TaskNotFoundError>;
    readonly listTasks: (input: ListTasksInput) => Effect.Effect<ListTasksResult>;
    readonly moveTask: (
        principal: AuthenticatedPrincipal,
        input: MoveTaskInput
    ) => Effect.Effect<TaskDetail, TaskOperationError>;
    readonly updateTask: (
        principal: AuthenticatedPrincipal,
        input: UpdateTaskInput
    ) => Effect.Effect<TaskDetail, TaskOperationError>;
    readonly updateTaskProgress: (
        principal: AuthenticatedPrincipal,
        input: UpdateTaskProgressInput
    ) => Effect.Effect<TaskProgressUpdate, TaskOperationError>;
}

/** Effect service for task queries and admitted task-domain mutations. */
export class TaskService extends Context.Service<TaskService, TaskServiceShape>()(
    "mira-dashboard/server/domains/tasks/TaskService"
) {}

export interface TaskServiceDependencies {
    readonly generateId?: () => string;
    readonly nowMs?: () => number;
    readonly realtimeRetentionMs?: number;
    readonly repository: TaskRepository;
    readonly wakeEventPump?: () => Promise<void> | void;
}

function isTaskOperationError(error: unknown): error is TaskOperationError {
    return (
        error instanceof TaskConflictError ||
        error instanceof TaskNotFoundError ||
        isDatabaseRuntimeWriteUnavailableError(error)
    );
}

function readEffect<T>(operation: () => T): Effect.Effect<T, TaskNotFoundError> {
    return Effect.try({
        catch: (error) =>
            error instanceof TaskNotFoundError
                ? error
                : new TaskUnexpectedOperationError({ cause: error }),
        try: operation,
    }).pipe(
        Effect.catchTag("TaskUnexpectedOperationError", (error) =>
            Effect.die(error.cause)
        )
    );
}

function listEffect<T>(operation: () => T): Effect.Effect<T> {
    return Effect.try({
        catch: (error) => new TaskUnexpectedOperationError({ cause: error }),
        try: operation,
    }).pipe(
        Effect.catchTag("TaskUnexpectedOperationError", (error) =>
            Effect.die(error.cause)
        )
    );
}

function mutationEffect<T>(
    operation: () => Promise<T>
): Effect.Effect<T, TaskOperationError> {
    return Effect.tryPromise({
        catch: (error) =>
            isTaskOperationError(error)
                ? error
                : new TaskUnexpectedOperationError({ cause: error }),
        try: operation,
    }).pipe(
        Effect.catchTag("TaskUnexpectedOperationError", (error) =>
            Effect.die(error.cause)
        )
    );
}

/**
 * Creates one task application service over validated persistence boundaries.
 * @param dependencies Repository plus replaceable clock, IDs, and realtime wakeup.
 * @returns Effect service with typed expected task-domain failures.
 */
export function createTaskService(
    dependencies: TaskServiceDependencies
): TaskService["Service"] {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = dependencies.nowMs ?? Date.now;
    const realtimeRetentionMs = parseSchemaWithRangeError(
        realtimeRetentionSchema,
        dependencies.realtimeRetentionMs ?? defaultRealtimeRetentionMilliseconds
    );
    const queries = createTaskQueryOperations(dependencies.repository);
    const mutationEnvironment = Object.freeze({
        generateId,
        now: () => toDate(parseSchemaWithRangeError(clockMillisecondsSchema, nowMs())),
        realtimeRetentionMs,
        repository: dependencies.repository,
        ...(dependencies.wakeEventPump === undefined
            ? {}
            : { wakeEventPump: dependencies.wakeEventPump }),
    });
    const tasks = createTaskMutationOperations(mutationEnvironment);
    const progress = createTaskProgressMutationOperations(mutationEnvironment);

    return TaskService.of({
        addTaskProgress: (principal, input) =>
            mutationEffect(() => progress.addTaskProgress(principal, input)),
        assignTask: (principal, input) =>
            mutationEffect(() => tasks.assignTask(principal, input)),
        createTask: (principal, input) =>
            mutationEffect(() => tasks.createTask(principal, input)),
        deleteTask: (principal, input) =>
            mutationEffect(() => tasks.deleteTask(principal, input)),
        deleteTaskProgress: (principal, input) =>
            mutationEffect(() => progress.deleteTaskProgress(principal, input)),
        getTask: (input) => readEffect(() => queries.getTask(input)),
        listTaskLabels: () => listEffect(() => queries.listTaskLabels()),
        listTaskProgress: (input) => readEffect(() => queries.listTaskProgress(input)),
        listTasks: (input) => listEffect(() => queries.listTasks(input)),
        moveTask: (principal, input) =>
            mutationEffect(() => tasks.moveTask(principal, input)),
        updateTask: (principal, input) =>
            mutationEffect(() => tasks.updateTask(principal, input)),
        updateTaskProgress: (principal, input) =>
            mutationEffect(() => progress.updateTaskProgress(principal, input)),
    });
}

/**
 * Provides the task service as a reusable Effect layer.
 * @param dependencies Repository plus replaceable clock, IDs, and wakeup.
 * @returns Layer containing one task service.
 */
export function taskServiceLayer(
    dependencies: TaskServiceDependencies
): Layer.Layer<TaskService> {
    return Layer.succeed(TaskService, createTaskService(dependencies));
}
