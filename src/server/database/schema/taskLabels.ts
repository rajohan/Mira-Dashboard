import { check, index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { taskLabelMaximumLength } from "../../../contracts/taskModel.ts";
import { boundedControlSafeTextCheck, uuidV7TextCheck } from "./checks.ts";
import { tasks } from "./tasks.ts";

/** Normalized searchable label attached to one task. */
export const taskLabels = sqliteTable(
    "task_labels",
    {
        label: text("label").notNull(),
        taskId: text("task_id")
            .notNull()
            .references(() => tasks.id, { onDelete: "cascade" }),
    },
    (table) => [
        check(
            "task_labels_label_check",
            boundedControlSafeTextCheck(table.label, taskLabelMaximumLength)
        ),
        check("task_labels_task_id_check", uuidV7TextCheck(table.taskId)),
        primaryKey({
            columns: [table.taskId, table.label],
            name: "task_labels_pk",
        }),
        index("task_labels_label_task_idx").on(table.label, table.taskId),
    ]
);
