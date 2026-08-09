import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { ListTaskProgressInput, ListTasksInput } from "../../../contracts/tasks.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { DrizzleTaskRepositoryReader } from "./repositoryReader.ts";
import type {
    TaskRepository,
    TaskRepositoryReader,
    TaskRepositoryUnitOfWork,
    TaskTransaction,
} from "./repositoryTypes.ts";
import { DrizzleTaskRepositoryUnitOfWork } from "./repositoryUnitOfWork.ts";

type DrizzleTransactionCallback = Parameters<SQLiteBunDatabase["transaction"]>[0];
type SynchronousResult<T> = T extends Promise<unknown> ? never : T;

/**
 * Creates validated task reads and runtime-admitted task writes.
 * Multi-query reads run in one deferred transaction so the task row and its
 * normalized labels/automation profile always come from the same snapshot.
 * @param database Process-owned Drizzle SQLite database.
 * @param writeAdmission Process-owned bounded immediate-write admission.
 * @returns Task repository with synchronous read snapshots and admitted writes.
 */
export function createTaskRepository(
    database: SQLiteBunDatabase,
    writeAdmission: ImmediateDatabaseWriteAdmission
): TaskRepository {
    const withReadTransaction = <T>(
        callback: (reader: TaskRepositoryReader) => SynchronousResult<T>
    ): T => {
        const transactionCallback = ((transaction: TaskTransaction) =>
            callback(
                new DrizzleTaskRepositoryReader(transaction)
            )) as DrizzleTransactionCallback;
        return database.transaction(transactionCallback, {
            behavior: "deferred",
        }) as T;
    };

    return Object.freeze({
        findTask: (id: string) => withReadTransaction((reader) => reader.findTask(id)),
        findTaskProgress: (taskId: string, updateId: string) =>
            withReadTransaction((reader) => reader.findTaskProgress(taskId, updateId)),
        listTaskProgress: (input: ListTaskProgressInput) =>
            withReadTransaction((reader) => reader.listTaskProgress(input)),
        listOpenTasksByCronJobIds: (cronJobIds: readonly string[]) =>
            withReadTransaction((reader) => reader.listOpenTasksByCronJobIds(cronJobIds)),
        listTasks: (input: ListTasksInput) =>
            withReadTransaction((reader) => reader.listTasks(input)),
        withImmediateTransaction<T>(
            callback: (unit: TaskRepositoryUnitOfWork) => SynchronousResult<T>
        ): Promise<T> {
            return writeAdmission.run((markTransactionStarted) => {
                const transactionCallback = ((transaction: TaskTransaction) => {
                    markTransactionStarted();
                    return callback(new DrizzleTaskRepositoryUnitOfWork(transaction));
                }) as DrizzleTransactionCallback;
                return database.transaction(transactionCallback, {
                    behavior: "immediate",
                }) as T;
            });
        },
        withReadTransaction,
    });
}
