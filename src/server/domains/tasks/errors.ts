import { Schema } from "effect";

import type { DatabaseRuntimeWriteUnavailableError } from "../../database/runtime/databaseErrors.ts";

const TaggedErrorClass = Schema.TaggedError;

/** A task-domain resource was absent at the admitted decision point. */
export class TaskNotFoundError extends TaggedErrorClass<TaskNotFoundError>(
    "mira-dashboard/server/domains/tasks/TaskNotFoundError"
)("TaskNotFoundError", {
    message: Schema.String,
    resourceId: Schema.String,
}) {}

/** A task-domain identity or optimistic version no longer matched. */
export class TaskConflictError extends TaggedErrorClass<TaskConflictError>(
    "mira-dashboard/server/domains/tasks/TaskConflictError"
)("TaskConflictError", {
    message: Schema.String,
    resourceId: Schema.String,
}) {}

export type TaskOperationError =
    | DatabaseRuntimeWriteUnavailableError
    | TaskConflictError
    | TaskNotFoundError;
