import { toDate } from "date-fns";
import {
    and,
    asc,
    desc,
    eq,
    exists,
    inArray,
    lt,
    ne,
    notExists,
    or,
    sql,
    type SQL,
} from "drizzle-orm";

import { taskMaximumLabels } from "../../../contracts/taskModel.ts";
import {
    taskPageMaximum,
    taskProgressPageMaximum,
    type ListTaskProgressInput,
    type ListTasksInput,
} from "../../../contracts/tasks.ts";
import { compareStrings } from "../../../shared/validation.ts";
import { taskAutomationProfiles } from "../../database/schema/taskAutomationProfiles.ts";
import { taskLabels } from "../../database/schema/taskLabels.ts";
import { tasks } from "../../database/schema/tasks.ts";
import { taskUpdates } from "../../database/schema/taskUpdates.ts";
import {
    parseTaskAutomationProfileRecord,
    parseTaskLabelRecord,
    parseTaskProgressRecord,
    parseTaskRecord,
} from "./repositoryRecords.ts";
import type {
    TaskAggregateRecord,
    TaskOpenCronLinkRecord,
    TaskPersistenceDatabase,
    TaskRecord,
    TaskRepositoryReader,
} from "./repositoryTypes.ts";

function assertPageLimit(limit: number, maximum: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
        throw new RangeError("Task repository page limit is invalid");
    }
}

function taskCursorBoundary(input: ListTasksInput): SQL | undefined {
    if (input.cursor === undefined) return undefined;
    const beforeUpdatedAt = toDate(input.cursor.updatedAtMs);
    return or(
        lt(tasks.updatedAt, beforeUpdatedAt),
        and(eq(tasks.updatedAt, beforeUpdatedAt), lt(tasks.id, input.cursor.id))
    );
}

function progressCursorBoundary(input: ListTaskProgressInput): SQL | undefined {
    if (input.cursor === undefined) return undefined;
    const beforeCreatedAt = toDate(input.cursor.createdAtMs);
    return or(
        lt(taskUpdates.createdAt, beforeCreatedAt),
        and(
            eq(taskUpdates.createdAt, beforeCreatedAt),
            lt(taskUpdates.id, input.cursor.id)
        )
    );
}

function taskFilterConditions(
    database: TaskPersistenceDatabase,
    input: ListTasksInput
): SQL[] {
    const filters = input.filters;
    if (filters === undefined) return [];

    const conditions: SQL[] = [];
    if (filters.assignees !== undefined) {
        conditions.push(inArray(tasks.assignee, [...filters.assignees]));
    }
    if (filters.priorities !== undefined) {
        conditions.push(inArray(tasks.priority, [...filters.priorities]));
    }
    if (filters.statuses !== undefined) {
        conditions.push(inArray(tasks.status, [...filters.statuses]));
    }
    if (filters.search !== undefined) {
        conditions.push(
            sql`instr(lower(${tasks.title} || char(10) || coalesce(${tasks.bodyMarkdown}, '')), lower(${filters.search})) > 0`
        );
    }
    if (filters.automation !== undefined) {
        const linkedRecurringAutomation = database
            .select({ taskId: taskAutomationProfiles.taskId })
            .from(taskAutomationProfiles)
            .where(
                and(
                    eq(taskAutomationProfiles.taskId, tasks.id),
                    eq(taskAutomationProfiles.recurring, true)
                )
            );
        conditions.push(
            filters.automation === "recurring"
                ? exists(linkedRecurringAutomation)
                : notExists(linkedRecurringAutomation)
        );
    }
    if (filters.labels !== undefined) {
        for (const label of filters.labels) {
            conditions.push(
                exists(
                    database
                        .select({ taskId: taskLabels.taskId })
                        .from(taskLabels)
                        .where(
                            and(
                                eq(taskLabels.taskId, tasks.id),
                                eq(taskLabels.label, label)
                            )
                        )
                )
            );
        }
    }
    return conditions;
}

/** Validated task-domain reads shared by direct and transactional callers. */
export class DrizzleTaskRepositoryReader implements TaskRepositoryReader {
    protected readonly database: TaskPersistenceDatabase;

    public constructor(database: TaskPersistenceDatabase) {
        this.database = database;
    }

    private loadAggregates(rows: readonly TaskRecord[]): TaskAggregateRecord[] {
        if (rows.length === 0) return [];
        const taskIds = rows.map(({ id }) => id);
        const labelRows = this.database
            .select()
            .from(taskLabels)
            .where(inArray(taskLabels.taskId, taskIds))
            .orderBy(asc(taskLabels.taskId), asc(taskLabels.label))
            .limit(taskIds.length * taskMaximumLabels + 1)
            .all()
            .map((row) => parseTaskLabelRecord(row));
        if (labelRows.length > taskIds.length * taskMaximumLabels) {
            throw new Error("Task label relationship count is outside its budget");
        }
        const automationRows = this.database
            .select()
            .from(taskAutomationProfiles)
            .where(inArray(taskAutomationProfiles.taskId, taskIds))
            .orderBy(asc(taskAutomationProfiles.taskId))
            .limit(taskIds.length + 1)
            .all()
            .map((row) => parseTaskAutomationProfileRecord(row));
        if (automationRows.length > taskIds.length) {
            throw new Error("Task automation relationship count is outside its budget");
        }

        const labelsByTask = new Map<string, typeof labelRows>();
        for (const label of labelRows) {
            const taskLabelsForId = labelsByTask.get(label.taskId) ?? [];
            taskLabelsForId.push(label);
            labelsByTask.set(label.taskId, taskLabelsForId);
        }
        const automationByTask = new Map(
            automationRows.map((automation) => [automation.taskId, automation])
        );
        return rows.map((task) => {
            const automation = automationByTask.get(task.id);
            return {
                ...(automation === undefined ? {} : { automation }),
                labels: (labelsByTask.get(task.id) ?? []).toSorted((left, right) =>
                    compareStrings(left.label, right.label)
                ),
                task,
            };
        });
    }

    public findTask(id: string): TaskAggregateRecord | undefined {
        const row = this.database.select().from(tasks).where(eq(tasks.id, id)).get();
        if (row === undefined) return undefined;
        return this.loadAggregates([parseTaskRecord(row)])[0];
    }

    public findTaskProgress(
        taskId: string,
        updateId: string
    ): ReturnType<typeof parseTaskProgressRecord> | undefined {
        const row = this.database
            .select()
            .from(taskUpdates)
            .where(and(eq(taskUpdates.taskId, taskId), eq(taskUpdates.id, updateId)))
            .get();
        return row === undefined ? undefined : parseTaskProgressRecord(row);
    }

    public listTaskProgress(input: ListTaskProgressInput) {
        assertPageLimit(input.limit, taskProgressPageMaximum);
        return this.database
            .select()
            .from(taskUpdates)
            .where(
                and(eq(taskUpdates.taskId, input.taskId), progressCursorBoundary(input))
            )
            .orderBy(desc(taskUpdates.createdAt), desc(taskUpdates.id))
            .limit(input.limit + 1)
            .all()
            .map((row) => parseTaskProgressRecord(row));
    }

    public listOpenTasksByCronJobIds(
        cronJobIds: readonly string[]
    ): TaskOpenCronLinkRecord[] {
        if (cronJobIds.length === 0) return [];
        assertPageLimit(cronJobIds.length, taskPageMaximum);
        const rows = this.database
            .select({
                assignee: tasks.assignee,
                bodyMarkdown: tasks.bodyMarkdown,
                createdAt: tasks.createdAt,
                cronJobId: taskAutomationProfiles.cronJobId,
                id: tasks.id,
                priority: tasks.priority,
                status: tasks.status,
                title: tasks.title,
                updatedAt: tasks.updatedAt,
                version: tasks.version,
            })
            .from(taskAutomationProfiles)
            .innerJoin(tasks, eq(taskAutomationProfiles.taskId, tasks.id))
            .where(
                and(
                    inArray(taskAutomationProfiles.cronJobId, [...cronJobIds]),
                    ne(tasks.status, "done")
                )
            )
            .orderBy(asc(taskAutomationProfiles.cronJobId))
            .limit(cronJobIds.length + 1)
            .all();
        if (rows.length > cronJobIds.length) {
            throw new Error("Task cron relationship count is outside its budget");
        }
        return rows.map(({ cronJobId, ...task }) => ({
            cronJobId,
            task: parseTaskRecord(task),
        }));
    }

    public listTasks(input: ListTasksInput): TaskAggregateRecord[] {
        assertPageLimit(input.limit, taskPageMaximum);
        const rows = this.database
            .select()
            .from(tasks)
            .where(
                and(
                    taskCursorBoundary(input),
                    ...taskFilterConditions(this.database, input)
                )
            )
            .orderBy(desc(tasks.updatedAt), desc(tasks.id))
            .limit(input.limit + 1)
            .all()
            .map((row) => parseTaskRecord(row));
        return this.loadAggregates(rows);
    }
}
