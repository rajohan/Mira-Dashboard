import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";

const taskId = "019fd100-0000-7000-8000-000000000001";
const eventId = "019fd100-0000-7000-8000-000000000002";
const updateId = "019fd100-0000-7000-8000-000000000003";
const userId = "019fd100-0000-7000-8000-000000000004";

function insertTask(
    database: Awaited<ReturnType<typeof openFreshMigratedDatabase>>
): void {
    database.sqlite.run(
        `INSERT INTO tasks (
            assignee, body_markdown, created_at, id, priority, status, title,
            updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [null, null, 1000, taskId, "medium", "todo", "Schema task", 1000, 1]
    );
}

describe("task baseline schema", () => {
    test("creates strict task tables and their bounded query indexes", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            expect(
                database.sqlite
                    .query<{ name: string; strict: number; wr: number }, []>(`
                        SELECT name, strict, wr
                        FROM pragma_table_list
                        WHERE name GLOB 'task*'
                        ORDER BY name
                    `)
                    .all()
            ).toEqual([
                { name: "task_automation_profiles", strict: 1, wr: 0 },
                { name: "task_events", strict: 1, wr: 1 },
                { name: "task_labels", strict: 1, wr: 0 },
                { name: "task_notification_outbox", strict: 1, wr: 1 },
                { name: "task_updates", strict: 1, wr: 0 },
                { name: "tasks", strict: 1, wr: 0 },
            ]);
            const taskPlan = database.sqlite
                .query<{ detail: string }, [string, string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id FROM tasks
                    WHERE status = ? AND priority = ?
                    ORDER BY updated_at DESC, id DESC
                    LIMIT 50
                `)
                .all("todo", "medium");
            expect(
                taskPlan.some(({ detail }) =>
                    detail.includes("tasks_status_priority_updated_id_idx")
                )
            ).toBeTrue();
            const labelPlan = database.sqlite
                .query<{ detail: string }, [string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT task_id FROM task_labels WHERE label = ?
                `)
                .all("ops");
            expect(
                labelPlan.some(({ detail }) =>
                    detail.includes("task_labels_label_task_idx")
                )
            ).toBeTrue();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("cascades mutable task children while retaining append-only events", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            insertTask(database);
            database.sqlite.run(
                "INSERT INTO task_labels (label, task_id) VALUES (?, ?)",
                ["ops", taskId]
            );
            database.sqlite.run(
                `INSERT INTO task_automation_profiles (
                    cron_job_id, kind, recurring, task_id
                ) VALUES (?, ?, ?, ?)`,
                ["cron-schema", "openclaw-cron", 1, taskId]
            );
            database.sqlite.run(
                `INSERT INTO task_updates (
                    author_id, author_kind, created_at, id, message_markdown,
                    task_id, updated_at, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, "user", 1000, updateId, "Started", taskId, 1000, 1]
            );
            database.sqlite.run(
                `INSERT INTO task_events (
                    actor_id, actor_kind, created_at, event_type, id,
                    payload_json, task_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [userId, "user", 1000, "created", eventId, "{}", taskId]
            );
            database.sqlite.run(
                `INSERT INTO task_notification_outbox (
                    available_at, created_at, event_id, message
                ) VALUES (?, ?, ?, ?)`,
                [1000, 1000, eventId, "Task created: schema fixture"]
            );

            database.sqlite.run("DELETE FROM tasks WHERE id = ?", [taskId]);
            for (const table of [
                "task_automation_profiles",
                "task_labels",
                "task_updates",
                "tasks",
            ]) {
                expect(
                    database.sqlite
                        .query<{ count: number }, []>(
                            `SELECT count(*) AS count FROM ${table}`
                        )
                        .get()
                ).toEqual({ count: 0 });
            }
            expect(
                database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM task_events"
                    )
                    .get()
            ).toEqual({ count: 1 });
            expect(
                database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM task_notification_outbox"
                    )
                    .get()
            ).toEqual({ count: 1 });
            expect(() =>
                database.sqlite.run(
                    "UPDATE task_events SET payload_json = '{}' WHERE id = ?",
                    [eventId]
                )
            ).toThrow("task_events is append-only");
            expect(() =>
                database.sqlite.run("DELETE FROM task_events WHERE id = ?", [eventId])
            ).toThrow("task_events is append-only");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects invalid task state and noncanonical event JSON", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO tasks (
                        created_at, id, priority, status, title, updated_at, version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [1000, taskId, "medium", "todo", "Invalid\u200Btitle", 1000, 1]
                )
            ).toThrow("tasks_title_check");
            insertTask(database);
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO task_events (
                        actor_id, actor_kind, created_at, event_type, id,
                        payload_json, task_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        userId,
                        "user",
                        1000,
                        "created",
                        eventId,
                        '{"duplicate":1,"duplicate":2}',
                        taskId,
                    ]
                )
            ).toThrow("task_events payload must be a bounded JSON object");
        } finally {
            database.sqlite.close(true);
        }
    });
});
