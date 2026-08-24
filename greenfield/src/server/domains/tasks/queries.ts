import { getTime } from "date-fns";

import type { TaskDetail } from "../../../contracts/taskModel.ts";
import type {
    GetTaskInput,
    ListTaskProgressInput,
    ListTaskProgressResult,
    ListTasksInput,
    ListTasksResult,
} from "../../../contracts/tasks.ts";
import { TaskNotFoundError } from "./errors.ts";
import type { TaskRepository } from "./repositoryTypes.ts";
import { toTaskDetail, toTaskProgressUpdate, toTaskSummary } from "./serviceRecords.ts";

/** Synchronous, snapshot-consistent task queries used by the Effect service. */
export interface TaskQueryOperations {
    readonly getTask: (input: GetTaskInput) => TaskDetail;
    readonly listTaskProgress: (input: ListTaskProgressInput) => ListTaskProgressResult;
    readonly listTasks: (input: ListTasksInput) => ListTasksResult;
}

/**
 * Creates task query operations over one validated repository.
 * @param repository Snapshot-capable task persistence boundary.
 * @returns Synchronous task query operations.
 */
export function createTaskQueryOperations(
    repository: TaskRepository
): TaskQueryOperations {
    const operations: TaskQueryOperations = {
        getTask(input) {
            const record = repository.findTask(input.id);
            if (record === undefined) {
                throw new TaskNotFoundError({
                    message: "Task was not found",
                    resourceId: input.id,
                });
            }
            return toTaskDetail(record);
        },
        listTaskProgress(input) {
            return repository.withReadTransaction((reader) => {
                if (reader.findTask(input.taskId) === undefined) {
                    throw new TaskNotFoundError({
                        message: "Task was not found",
                        resourceId: input.taskId,
                    });
                }
                const records = reader.listTaskProgress(input);
                const hasNextPage = records.length > input.limit;
                const page = records.slice(0, input.limit);
                const last = page.at(-1);
                return {
                    ...(hasNextPage && last !== undefined
                        ? {
                              nextCursor: {
                                  createdAtMs: getTime(last.createdAt),
                                  id: last.id,
                              },
                          }
                        : {}),
                    updates: page.map((record) => toTaskProgressUpdate(record)),
                };
            });
        },
        listTasks(input) {
            const records = repository.listTasks(input);
            const hasNextPage = records.length > input.limit;
            const page = records.slice(0, input.limit);
            const last = page.at(-1);
            return {
                ...(hasNextPage && last !== undefined
                    ? {
                          nextCursor: {
                              id: last.task.id,
                              updatedAtMs: getTime(last.task.updatedAt),
                          },
                      }
                    : {}),
                tasks: page.map((record) => toTaskSummary(record)),
            };
        },
    };
    return Object.freeze(operations);
}
