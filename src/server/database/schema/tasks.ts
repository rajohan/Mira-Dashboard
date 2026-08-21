import { sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

import {
    taskAssigneeIds,
    taskBodyMaximumLength,
    taskPriorities,
    taskStatuses,
    taskTitleMaximumLength,
} from "../../../contracts/taskModel.ts";
import {
    boundedControlSafeTextCheck,
    boundedNonBlankTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";

/** Authoritative task-board row with optimistic-concurrency versioning. */
export const tasks = sqliteTable(
    "tasks",
    {
        assignee: text("assignee", { enum: taskAssigneeIds }),
        bodyMarkdown: text("body_markdown"),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        id: text("id").notNull(),
        number: integer("number").primaryKey({ autoIncrement: true }),
        priority: text("priority", { enum: taskPriorities }).notNull(),
        status: text("status", { enum: taskStatuses }).notNull(),
        title: text("title").notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
        version: integer("version").notNull().default(1),
    },
    (table) => [
        check(
            "tasks_assignee_check",
            sql`${table.assignee} IS NULL OR ${table.assignee} IN ('mira-2026', 'rajohan')`
        ),
        check(
            "tasks_body_markdown_check",
            sql`${table.bodyMarkdown} IS NULL OR (${boundedNonBlankTextCheck(table.bodyMarkdown, taskBodyMaximumLength)})`
        ),
        check("tasks_id_check", uuidV7TextCheck(table.id)),
        check("tasks_number_check", sql`${table.number} BETWEEN 1 AND 9007199254740991`),
        check(
            "tasks_priority_check",
            sql`${table.priority} IN ('low', 'medium', 'high')`
        ),
        check(
            "tasks_status_check",
            sql`${table.status} IN ('todo', 'in-progress', 'blocked', 'done')`
        ),
        check(
            "tasks_title_check",
            boundedControlSafeTextCheck(table.title, taskTitleMaximumLength)
        ),
        check(
            "tasks_time_check",
            sql`${timestampMillisecondsCheck(table.createdAt)} AND ${timestampMillisecondsCheck(table.updatedAt)} AND ${table.updatedAt} >= ${table.createdAt}`
        ),
        check(
            "tasks_version_check",
            sql`${table.version} BETWEEN 1 AND 9007199254740991`
        ),
        index("tasks_updated_id_idx").on(table.updatedAt, table.id),
        index("tasks_status_priority_updated_id_idx").on(
            table.status,
            table.priority,
            table.updatedAt,
            table.id
        ),
        index("tasks_assignee_status_updated_id_idx").on(
            table.assignee,
            table.status,
            table.updatedAt,
            table.id
        ),
        uniqueIndex("tasks_id_unique").on(table.id),
    ]
);
