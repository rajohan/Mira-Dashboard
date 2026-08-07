import { and, eq, lt, lte, sql } from "drizzle-orm";
import * as v from "valibot";

import { realtimeEvents } from "../../database/schema/realtime.ts";
import { taskAutomationProfiles } from "../../database/schema/taskAutomationProfiles.ts";
import { taskEvents } from "../../database/schema/taskEvents.ts";
import { taskLabels } from "../../database/schema/taskLabels.ts";
import { taskNotificationOutbox } from "../../database/schema/taskNotificationOutbox.ts";
import { tasks } from "../../database/schema/tasks.ts";
import { taskUpdates } from "../../database/schema/taskUpdates.ts";
import {
    realtimeEventInsertSchema,
    realtimeEventSelectSchema,
} from "../../database/validation/realtimeEvents.ts";
import { taskAutomationProfileInsertSchema } from "../../database/validation/taskAutomationProfiles.ts";
import { taskEventInsertSchema } from "../../database/validation/taskEvents.ts";
import { taskLabelInsertSchema } from "../../database/validation/taskLabels.ts";
import { taskNotificationOutboxInsertSchema } from "../../database/validation/taskNotificationOutbox.ts";
import { taskInsertSchema, taskUpdateSchema } from "../../database/validation/tasks.ts";
import {
    taskProgressRowInsertSchema,
    taskProgressRowUpdateSchema,
} from "../../database/validation/taskUpdates.ts";
import { DrizzleTaskRepositoryReader } from "./repositoryReader.ts";
import { parseTaskProgressRecord, parseTaskRecord } from "./repositoryRecords.ts";
import type {
    TaskAutomationProfileInsert,
    TaskEventInsert,
    TaskLabelInsert,
    TaskNotificationOutboxInsert,
    TaskProgressInsert,
    TaskProgressRecord,
    TaskRecord,
    TaskInsert,
    TaskRealtimeEventInsert,
    TaskRepositoryUnitOfWork,
    TaskTransaction,
    VersionedTaskMutationInput,
    VersionedTaskProgressMutationInput,
} from "./repositoryTypes.ts";

const maximumVersion = Number.MAX_SAFE_INTEGER;

function requiredRow<T>(row: T | undefined, operation: string): T {
    if (row === undefined) {
        throw new Error(`Task repository ${operation} returned no row`);
    }
    return row;
}

/** Synchronous task writes scoped to one admitted SQLite IMMEDIATE transaction. */
export class DrizzleTaskRepositoryUnitOfWork
    extends DrizzleTaskRepositoryReader
    implements TaskRepositoryUnitOfWork
{
    readonly #transaction: TaskTransaction;

    public constructor(transaction: TaskTransaction) {
        super(transaction);
        this.#transaction = transaction;
    }

    public deleteTask(id: string, expectedVersion: number): TaskRecord | undefined {
        const row = this.#transaction
            .delete(tasks)
            .where(and(eq(tasks.id, id), eq(tasks.version, expectedVersion)))
            .returning()
            .get();
        return row === undefined ? undefined : parseTaskRecord(row);
    }

    public deleteTaskProgress(
        taskId: string,
        updateId: string,
        expectedVersion: number
    ): TaskProgressRecord | undefined {
        const row = this.#transaction
            .delete(taskUpdates)
            .where(
                and(
                    eq(taskUpdates.taskId, taskId),
                    eq(taskUpdates.id, updateId),
                    eq(taskUpdates.version, expectedVersion)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseTaskProgressRecord(row);
    }

    public insertRealtimeEvent(input: TaskRealtimeEventInsert): number {
        const row = this.#transaction
            .insert(realtimeEvents)
            .values(v.parse(realtimeEventInsertSchema, input))
            .returning()
            .get();
        return v.parse(
            realtimeEventSelectSchema,
            requiredRow(row, "realtime event insert")
        ).id;
    }

    public insertTask(input: TaskInsert): TaskRecord | undefined {
        const row = this.#transaction
            .insert(tasks)
            .values(v.parse(taskInsertSchema, input))
            .onConflictDoNothing()
            .returning()
            .get();
        return row === undefined ? undefined : parseTaskRecord(row);
    }

    public insertTaskEvent(input: TaskEventInsert): void {
        this.#transaction
            .insert(taskEvents)
            .values(v.parse(taskEventInsertSchema, input))
            .run();
    }

    public insertTaskNotification(input: TaskNotificationOutboxInsert): void {
        this.#transaction
            .insert(taskNotificationOutbox)
            .values(v.parse(taskNotificationOutboxInsertSchema, input))
            .run();
    }

    public insertTaskProgress(input: TaskProgressInsert): TaskProgressRecord {
        const row = this.#transaction
            .insert(taskUpdates)
            .values(v.parse(taskProgressRowInsertSchema, input))
            .returning()
            .get();
        return parseTaskProgressRecord(requiredRow(row, "progress insert"));
    }

    public replaceTaskAutomation(
        taskId: string,
        input: TaskAutomationProfileInsert | undefined
    ): void {
        if (input !== undefined && input.taskId !== taskId) {
            throw new TypeError("Task automation profile belongs to another task");
        }
        this.#transaction
            .delete(taskAutomationProfiles)
            .where(eq(taskAutomationProfiles.taskId, taskId))
            .run();
        if (input === undefined) return;
        this.#transaction
            .insert(taskAutomationProfiles)
            .values(v.parse(taskAutomationProfileInsertSchema, input))
            .run();
    }

    public replaceTaskLabels(taskId: string, inputs: readonly TaskLabelInsert[]): void {
        if (inputs.some((input) => input.taskId !== taskId)) {
            throw new TypeError("Task label belongs to another task");
        }
        this.#transaction.delete(taskLabels).where(eq(taskLabels.taskId, taskId)).run();
        if (inputs.length === 0) return;
        this.#transaction
            .insert(taskLabels)
            .values(inputs.map((input) => v.parse(taskLabelInsertSchema, input)))
            .run();
    }

    public touchTask(id: string, updatedAt: Date): TaskRecord | undefined {
        const row = this.#transaction
            .update(tasks)
            .set({
                updatedAt,
                version: sql`${tasks.version} + 1`,
            })
            .where(
                and(
                    eq(tasks.id, id),
                    lte(tasks.createdAt, updatedAt),
                    lte(tasks.updatedAt, updatedAt),
                    lt(tasks.version, maximumVersion)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseTaskRecord(row);
    }

    public updateTask(input: VersionedTaskMutationInput): TaskRecord | undefined {
        const nextVersion = input.expectedVersion + 1;
        const validated = v.parse(taskUpdateSchema, {
            ...input.changes,
            updatedAt: input.updatedAt,
            version: nextVersion,
        });
        const row = this.#transaction
            .update(tasks)
            .set({
                assignee: validated.assignee,
                bodyMarkdown: validated.bodyMarkdown,
                priority: validated.priority,
                status: validated.status,
                title: validated.title,
                updatedAt: validated.updatedAt,
                version: sql`${tasks.version} + 1`,
            })
            .where(
                and(
                    eq(tasks.id, input.id),
                    eq(tasks.version, input.expectedVersion),
                    lte(tasks.createdAt, input.updatedAt),
                    lte(tasks.updatedAt, input.updatedAt),
                    lt(tasks.version, maximumVersion)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseTaskRecord(row);
    }

    public updateTaskProgress(
        input: VersionedTaskProgressMutationInput
    ): TaskProgressRecord | undefined {
        const nextVersion = input.expectedVersion + 1;
        const validated = v.parse(taskProgressRowUpdateSchema, {
            messageMarkdown: input.messageMarkdown,
            updatedAt: input.updatedAt,
            version: nextVersion,
        });
        const row = this.#transaction
            .update(taskUpdates)
            .set({
                messageMarkdown: validated.messageMarkdown,
                updatedAt: validated.updatedAt,
                version: sql`${taskUpdates.version} + 1`,
            })
            .where(
                and(
                    eq(taskUpdates.taskId, input.taskId),
                    eq(taskUpdates.id, input.updateId),
                    eq(taskUpdates.version, input.expectedVersion),
                    lte(taskUpdates.createdAt, input.updatedAt),
                    lte(taskUpdates.updatedAt, input.updatedAt),
                    lt(taskUpdates.version, maximumVersion)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseTaskProgressRecord(row);
    }
}
