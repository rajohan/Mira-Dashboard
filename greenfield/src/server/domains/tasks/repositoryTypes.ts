import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import type * as v from "valibot";

import type { ListTaskProgressInput, ListTasksInput } from "../../../contracts/tasks.ts";
import type { realtimeEventInsertSchema } from "../../database/validation/realtimeEvents.ts";
import type {
    taskAutomationProfileInsertSchema,
    taskAutomationProfileSelectSchema,
} from "../../database/validation/taskAutomationProfiles.ts";
import type { taskEventInsertSchema } from "../../database/validation/taskEvents.ts";
import type {
    taskLabelInsertSchema,
    taskLabelSelectSchema,
} from "../../database/validation/taskLabels.ts";
import type { taskNotificationOutboxInsertSchema } from "../../database/validation/taskNotificationOutbox.ts";
import type {
    taskInsertSchema,
    taskSelectSchema,
    taskUpdateSchema,
} from "../../database/validation/tasks.ts";
import type {
    taskProgressRowInsertSchema,
    taskProgressRowSelectSchema,
    taskProgressRowUpdateSchema,
} from "../../database/validation/taskUpdates.ts";

export type TaskRecord = v.InferOutput<typeof taskSelectSchema>;
export type TaskInsert = v.InferOutput<typeof taskInsertSchema>;
export type TaskMutableUpdate = v.InferOutput<typeof taskUpdateSchema>;
export type TaskLabelRecord = v.InferOutput<typeof taskLabelSelectSchema>;
export type TaskLabelInsert = v.InferOutput<typeof taskLabelInsertSchema>;
export type TaskAutomationProfileRecord = v.InferOutput<
    typeof taskAutomationProfileSelectSchema
>;
export type TaskAutomationProfileInsert = v.InferOutput<
    typeof taskAutomationProfileInsertSchema
>;
export type TaskProgressRecord = v.InferOutput<typeof taskProgressRowSelectSchema>;
export type TaskProgressInsert = v.InferOutput<typeof taskProgressRowInsertSchema>;
export type TaskProgressMutableUpdate = v.InferOutput<typeof taskProgressRowUpdateSchema>;
export type TaskEventInsert = v.InferOutput<typeof taskEventInsertSchema>;
export type TaskNotificationOutboxInsert = v.InferOutput<
    typeof taskNotificationOutboxInsertSchema
>;
export type TaskRealtimeEventInsert = v.InferOutput<typeof realtimeEventInsertSchema>;

type TransactionCallback = Parameters<SQLiteBunDatabase["transaction"]>[0];
export type TaskTransaction = Parameters<TransactionCallback>[0];
export type TaskPersistenceDatabase = TaskTransaction | SQLiteBunDatabase;
type SynchronousResult<T> = T extends Promise<unknown> ? never : T;

export interface TaskAggregateRecord {
    readonly automation?: TaskAutomationProfileRecord;
    readonly labels: readonly TaskLabelRecord[];
    readonly task: TaskRecord;
}

export interface TaskOpenCronLinkRecord {
    readonly cronJobId: string;
    readonly task: TaskRecord;
}

/** Minimal task row used only by the cache-read heartbeat declassification. */
export interface TaskHeartbeatCandidateRecord {
    readonly assignee?: TaskRecord["assignee"];
    readonly automation?: {
        readonly recurring: boolean;
    };
    readonly id: TaskRecord["id"];
    readonly priority: TaskRecord["priority"];
    readonly status: TaskRecord["status"];
}

/** Exact heartbeat-relevant task count plus its bounded canonical prefix. */
export interface TaskHeartbeatCandidateSnapshot {
    readonly rows: readonly TaskHeartbeatCandidateRecord[];
    readonly totalCount: number;
}

export interface VersionedTaskMutationInput {
    readonly changes: TaskMutableUpdate;
    readonly expectedVersion: number;
    readonly id: string;
    readonly updatedAt: Date;
}

export interface VersionedTaskProgressMutationInput {
    readonly expectedVersion: number;
    readonly messageMarkdown: string;
    readonly taskId: string;
    readonly updatedAt: Date;
    readonly updateId: string;
}

/** Consistent task-domain read surface shared by direct and transactional callers. */
export interface TaskRepositoryReader {
    findTask(id: string): TaskAggregateRecord | undefined;
    findTaskProgress(taskId: string, updateId: string): TaskProgressRecord | undefined;
    listTaskProgress(input: ListTaskProgressInput): TaskProgressRecord[];
    listTasks(input: ListTasksInput): TaskAggregateRecord[];
    listOpenTasksByCronJobIds(cronJobIds: readonly string[]): TaskOpenCronLinkRecord[];
    readHeartbeatCandidates(): TaskHeartbeatCandidateSnapshot;
}

/** Synchronous writes owned by one admitted SQLite IMMEDIATE transaction. */
export interface TaskRepositoryUnitOfWork extends TaskRepositoryReader {
    deleteTask(id: string, expectedVersion: number): TaskRecord | undefined;
    deleteTaskProgress(
        taskId: string,
        updateId: string,
        expectedVersion: number
    ): TaskProgressRecord | undefined;
    insertRealtimeEvent(input: TaskRealtimeEventInsert): number;
    insertTask(input: TaskInsert): TaskRecord | undefined;
    insertTaskEvent(input: TaskEventInsert): void;
    insertTaskNotification(input: TaskNotificationOutboxInsert): void;
    insertTaskProgress(input: TaskProgressInsert): TaskProgressRecord;
    replaceTaskAutomation(
        taskId: string,
        input: TaskAutomationProfileInsert | undefined
    ): boolean;
    replaceTaskLabels(taskId: string, inputs: readonly TaskLabelInsert[]): void;
    touchTask(id: string, updatedAt: Date): TaskRecord | undefined;
    updateTask(input: VersionedTaskMutationInput): TaskRecord | undefined;
    updateTaskProgress(
        input: VersionedTaskProgressMutationInput
    ): TaskProgressRecord | undefined;
}

/** Validated SQLite repository for task reads and admitted writes. */
export interface TaskRepository extends TaskRepositoryReader {
    withImmediateTransaction<T>(
        callback: (unit: TaskRepositoryUnitOfWork) => SynchronousResult<T>
    ): Promise<T>;
    withReadTransaction<T>(
        callback: (reader: TaskRepositoryReader) => SynchronousResult<T>
    ): T;
}
