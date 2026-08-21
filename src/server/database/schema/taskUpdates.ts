import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { taskProgressMaximumLength } from "../../../contracts/taskModel.ts";
import {
    boundedNonBlankTextCheck,
    nulFreeTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";
import { tasks } from "./tasks.ts";

/** Editable progress content with immutable authenticated authorship. */
export const taskUpdates = sqliteTable(
    "task_updates",
    {
        authorId: text("author_id").notNull(),
        authorKind: text("author_kind", { enum: ["automation", "user"] }).notNull(),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        id: text("id").notNull().primaryKey(),
        messageMarkdown: text("message_markdown").notNull(),
        taskId: text("task_id")
            .notNull()
            .references(() => tasks.id, { onDelete: "cascade" }),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
        version: integer("version").notNull().default(1),
    },
    (table) => [
        check(
            "task_updates_author_check",
            sql`(${table.authorKind} = 'user' AND ${uuidV7TextCheck(table.authorId)}) OR (${table.authorKind} = 'automation' AND length(${table.authorId}) BETWEEN 1 AND 64 AND ${nulFreeTextCheck(table.authorId)} AND ${table.authorId} = lower(${table.authorId}) AND substr(${table.authorId}, 1, 1) GLOB '[a-z0-9]' AND ${table.authorId} NOT GLOB '*[^a-z0-9._-]*')`
        ),
        check("task_updates_id_check", uuidV7TextCheck(table.id)),
        check(
            "task_updates_message_markdown_check",
            boundedNonBlankTextCheck(table.messageMarkdown, taskProgressMaximumLength)
        ),
        check("task_updates_task_id_check", uuidV7TextCheck(table.taskId)),
        check(
            "task_updates_time_check",
            sql`${timestampMillisecondsCheck(table.createdAt)} AND ${timestampMillisecondsCheck(table.updatedAt)} AND ${table.updatedAt} >= ${table.createdAt}`
        ),
        check(
            "task_updates_version_check",
            sql`${table.version} BETWEEN 1 AND 9007199254740991`
        ),
        index("task_updates_task_created_id_idx").on(
            table.taskId,
            table.createdAt,
            table.id
        ),
    ]
);
