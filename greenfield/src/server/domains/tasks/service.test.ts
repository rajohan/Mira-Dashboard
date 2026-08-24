import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit } from "effect";

import { realtimeEvents } from "../../database/schema/realtime.ts";
import { taskEvents } from "../../database/schema/taskEvents.ts";
import { taskLabels } from "../../database/schema/taskLabels.ts";
import { tasks } from "../../database/schema/tasks.ts";
import { taskUpdates } from "../../database/schema/taskUpdates.ts";
import { TaskConflictError } from "./errors.ts";
import {
    openFreshMigratedDatabase,
    runTaskEffect,
    taskServiceFor,
    taskTestIdGenerator,
    taskTestPrincipal,
    taskTestUuid,
} from "./testSupport/taskService.ts";

function rowCount(
    database: Awaited<ReturnType<typeof openFreshMigratedDatabase>>,
    table: string
) {
    return database.sqlite
        .query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
        .get()!.count;
}

describe("task service", () => {
    test("commits the complete task and progress lifecycle with audit and realtime", async () => {
        const database = await openFreshMigratedDatabase();
        let nowMs = 10_000;
        let wakeups = 0;
        const service = taskServiceFor(database, {
            nowMs: () => nowMs,
            wakeEventPump: () => {
                wakeups += 1;
            },
        });

        try {
            const created = await runTaskEffect(
                service.createTask(taskTestPrincipal, {
                    assignee: "mira-2026",
                    automation: {
                        cronJobId: "cron-task-1",
                        kind: "openclaw-cron",
                        recurring: true,
                        scheduleSummary: "Every hour",
                    },
                    bodyMarkdown: "Initial task body",
                    labels: ["automation", "ops"],
                    priority: "high",
                    title: "Investigate host pressure",
                })
            );
            expect(created).toMatchObject({
                assignee: "mira-2026",
                labels: ["automation", "ops"],
                priority: "high",
                status: "todo",
                version: 1,
            });

            nowMs = 20_000;
            const updated = await runTaskEffect(
                service.updateTask(taskTestPrincipal, {
                    expectedVersion: created.version,
                    id: created.id,
                    patch: {
                        bodyMarkdown: "Updated task body",
                        labels: ["ops"],
                        title: "Investigate production host pressure",
                    },
                })
            );
            const assigned = await runTaskEffect(
                service.assignTask(taskTestPrincipal, {
                    assignee: "rajohan",
                    expectedVersion: updated.version,
                    id: updated.id,
                })
            );
            const assignedBack = await runTaskEffect(
                service.assignTask(taskTestPrincipal, {
                    assignee: "mira-2026",
                    expectedVersion: assigned.version,
                    id: assigned.id,
                })
            );
            const moved = await runTaskEffect(
                service.moveTask(taskTestPrincipal, {
                    expectedVersion: assignedBack.version,
                    id: assignedBack.id,
                    status: "in-progress",
                })
            );
            const progress = await runTaskEffect(
                service.addTaskProgress(taskTestPrincipal, {
                    messageMarkdown: "Started diagnosis",
                    taskId: moved.id,
                })
            );
            const editedProgress = await runTaskEffect(
                service.updateTaskProgress(taskTestPrincipal, {
                    expectedVersion: progress.version,
                    messageMarkdown: "Diagnosis completed",
                    taskId: moved.id,
                    updateId: progress.id,
                })
            );
            await runTaskEffect(
                service.deleteTaskProgress(taskTestPrincipal, {
                    expectedVersion: editedProgress.version,
                    taskId: moved.id,
                    updateId: editedProgress.id,
                })
            );
            const retainedProgress = await runTaskEffect(
                service.addTaskProgress(taskTestPrincipal, {
                    messageMarkdown: "Ready for task deletion",
                    taskId: moved.id,
                })
            );
            const finalTask = await runTaskEffect(service.getTask({ id: moved.id }));
            expect(finalTask).toMatchObject({
                assignee: "mira-2026",
                automation: { cronJobId: "cron-task-1" },
                bodyMarkdown: "Updated task body",
                labels: ["ops"],
                status: "in-progress",
                version: 9,
            });
            expect(
                await runTaskEffect(
                    service.listTaskProgress({ limit: 20, taskId: moved.id })
                )
            ).toMatchObject({ updates: [{ id: retainedProgress.id }] });

            await runTaskEffect(
                service.deleteTask(taskTestPrincipal, {
                    expectedVersion: finalTask.version,
                    id: finalTask.id,
                })
            );

            expect(rowCount(database, "tasks")).toBe(0);
            expect(rowCount(database, "task_labels")).toBe(0);
            expect(rowCount(database, "task_updates")).toBe(0);
            expect(rowCount(database, "task_automation_profiles")).toBe(0);
            expect(rowCount(database, "task_events")).toBe(10);
            expect(rowCount(database, "realtime_events")).toBe(10);
            expect(wakeups).toBe(10);
            expect(database.orm.select().from(taskEvents).all()).toHaveLength(10);
            const notifications = database.sqlite
                .query<{ message: string }, []>(`
                    SELECT message
                    FROM task_notification_outbox
                    ORDER BY created_at, event_id
                `)
                .all();
            expect(notifications).toHaveLength(10);
            expect(notifications.map(({ message }) => message)).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('event="created"'),
                    expect.stringContaining('event="updated"'),
                    expect.stringContaining('event="assigned"'),
                    expect.stringContaining('event="moved"'),
                    expect.stringContaining('event="comment added"'),
                    expect.stringContaining('event="comment edited"'),
                    expect.stringContaining('event="comment deleted"'),
                    expect.stringContaining('event="deleted"'),
                ])
            );
        } finally {
            database.sqlite.close(true);
        }
    });

    test("keeps no-op mutations quiet and rejects stale versions", async () => {
        const database = await openFreshMigratedDatabase();
        let wakeups = 0;
        const service = taskServiceFor(database, {
            wakeEventPump: () => {
                wakeups += 1;
            },
        });

        try {
            const created = await runTaskEffect(
                service.createTask(taskTestPrincipal, { title: "Stable task" })
            );
            expect(
                await runTaskEffect(
                    service.moveTask(taskTestPrincipal, {
                        expectedVersion: created.version,
                        id: created.id,
                        status: "todo",
                    })
                )
            ).toEqual(created);
            expect(
                await runTaskEffect(
                    service.assignTask(taskTestPrincipal, {
                        assignee: null,
                        expectedVersion: created.version,
                        id: created.id,
                    })
                )
            ).toEqual(created);
            expect(
                await runTaskEffect(
                    service.updateTask(taskTestPrincipal, {
                        expectedVersion: created.version,
                        id: created.id,
                        patch: { title: created.title },
                    })
                )
            ).toEqual(created);
            const moved = await runTaskEffect(
                service.moveTask(taskTestPrincipal, {
                    expectedVersion: created.version,
                    id: created.id,
                    status: "done",
                })
            );
            const stale = Effect.runPromise(
                Effect.flip(
                    service.moveTask(taskTestPrincipal, {
                        expectedVersion: created.version,
                        id: created.id,
                        status: "blocked",
                    })
                )
            );
            expect(await stale).toBeInstanceOf(TaskConflictError);
            expect(moved.version).toBe(2);
            expect(rowCount(database, "task_events")).toBe(2);
            expect(rowCount(database, "realtime_events")).toBe(2);
            expect(rowCount(database, "task_notification_outbox")).toBe(0);
            expect(wakeups).toBe(2);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("loads labels in contract order when SQLite collation differs", async () => {
        const database = await openFreshMigratedDatabase();
        const service = taskServiceFor(database);
        const labels = ["\u{10000}", "\uE000"];

        try {
            const created = await runTaskEffect(
                service.createTask(taskTestPrincipal, {
                    labels,
                    title: "Unicode label order",
                })
            );

            expect(created.labels).toEqual(labels);
            expect(
                await runTaskEffect(service.getTask({ id: created.id }))
            ).toMatchObject({ labels });
            expect(await runTaskEffect(service.listTasks({ limit: 10 }))).toMatchObject({
                tasks: [{ labels }],
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("returns domain conflicts for duplicate cron job relationships", async () => {
        const database = await openFreshMigratedDatabase();
        const service = taskServiceFor(database);

        try {
            const linked = await runTaskEffect(
                service.createTask(taskTestPrincipal, {
                    automation: {
                        cronJobId: "shared-cron-job",
                        kind: "openclaw-cron",
                        recurring: true,
                    },
                    title: "Linked task",
                })
            );
            const duplicateCreate = await Effect.runPromise(
                Effect.flip(
                    service.createTask(taskTestPrincipal, {
                        automation: {
                            cronJobId: "shared-cron-job",
                            kind: "openclaw-cron",
                            recurring: true,
                        },
                        title: "Duplicate task",
                    })
                )
            );
            const other = await runTaskEffect(
                service.createTask(taskTestPrincipal, {
                    automation: {
                        cronJobId: "other-cron-job",
                        kind: "openclaw-cron",
                        recurring: true,
                    },
                    title: "Other task",
                })
            );
            const duplicateUpdate = await Effect.runPromise(
                Effect.flip(
                    service.updateTask(taskTestPrincipal, {
                        expectedVersion: other.version,
                        id: other.id,
                        patch: {
                            automation: {
                                cronJobId: "shared-cron-job",
                                kind: "openclaw-cron",
                                recurring: true,
                            },
                        },
                    })
                )
            );

            expect(duplicateCreate).toBeInstanceOf(TaskConflictError);
            expect(duplicateUpdate).toBeInstanceOf(TaskConflictError);
            expect(duplicateUpdate).toMatchObject({
                message: "Task automation cron job is already linked",
                resourceId: other.id,
            });
            expect(await runTaskEffect(service.getTask({ id: linked.id }))).toMatchObject(
                { automation: { cronJobId: "shared-cron-job" } }
            );
            const unchanged = await runTaskEffect(service.getTask({ id: other.id }));
            expect(unchanged.version).toBe(1);
            expect(unchanged.automation).toMatchObject({
                cronJobId: "other-cron-job",
            });
            expect(rowCount(database, "tasks")).toBe(2);
            expect(rowCount(database, "task_automation_profiles")).toBe(2);
            expect(rowCount(database, "task_events")).toBe(2);
            expect(rowCount(database, "realtime_events")).toBe(2);
            expect(rowCount(database, "task_notification_outbox")).toBe(0);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rolls back progress insertion when the parent version is exhausted", async () => {
        const database = await openFreshMigratedDatabase();
        const service = taskServiceFor(database);

        try {
            const created = await runTaskEffect(
                service.createTask(taskTestPrincipal, { title: "Exhausted task" })
            );
            database.sqlite.run("UPDATE tasks SET version = ? WHERE id = ?", [
                Number.MAX_SAFE_INTEGER,
                created.id,
            ]);

            const failure = await Effect.runPromise(
                Effect.flip(
                    service.addTaskProgress(taskTestPrincipal, {
                        messageMarkdown: "This write must roll back",
                        taskId: created.id,
                    })
                )
            );

            expect(failure).toBeInstanceOf(TaskConflictError);
            expect(rowCount(database, "task_updates")).toBe(0);
            expect(rowCount(database, "task_events")).toBe(1);
            expect(rowCount(database, "realtime_events")).toBe(1);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rolls back a late append-only event failure as an Effect defect", async () => {
        const database = await openFreshMigratedDatabase();
        const first = taskServiceFor(database);

        try {
            await runTaskEffect(
                first.createTask(taskTestPrincipal, { title: "Existing task" })
            );
            const existingEventId = database.orm
                .select({ id: taskEvents.id })
                .from(taskEvents)
                .get()!.id;
            const generatedIds = [taskTestUuid(10_000), existingEventId];
            const failing = taskServiceFor(database, {
                generateId: () => generatedIds.shift()!,
            });
            const exit = await Effect.runPromiseExit(
                failing.createTask(taskTestPrincipal, { title: "Rolled back task" })
            );

            expect(Exit.isFailure(exit)).toBeTrue();
            if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBeTrue();
            expect(database.orm.select().from(tasks).all()).toHaveLength(1);
            expect(database.orm.select().from(taskLabels).all()).toHaveLength(0);
            expect(database.orm.select().from(taskUpdates).all()).toHaveLength(0);
            expect(database.orm.select().from(realtimeEvents).all()).toHaveLength(1);
            expect(database.orm.select().from(taskEvents).all()).toHaveLength(1);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("pages newest-first and combines bounded task filters", async () => {
        const database = await openFreshMigratedDatabase();
        let nowMs = 1000;
        const service = taskServiceFor(database, {
            generateId: taskTestIdGenerator(20_000),
            nowMs: () => nowMs,
        });

        try {
            const oldest = await runTaskEffect(
                service.createTask(taskTestPrincipal, {
                    labels: ["ops"],
                    priority: "low",
                    title: "Old manual task",
                })
            );
            nowMs = 2000;
            await runTaskEffect(
                service.createTask(taskTestPrincipal, {
                    assignee: "mira-2026",
                    automation: {
                        cronJobId: "cron-filter",
                        kind: "openclaw-cron",
                        recurring: true,
                    },
                    labels: ["automation", "ops"],
                    priority: "high",
                    title: "Automated pressure check",
                })
            );
            nowMs = 3000;
            const newest = await runTaskEffect(
                service.createTask(taskTestPrincipal, {
                    labels: ["ops"],
                    priority: "medium",
                    title: "Newest manual pressure check",
                })
            );

            const firstPage = await runTaskEffect(service.listTasks({ limit: 2 }));
            expect(firstPage.tasks.map(({ id }) => id)).toEqual([
                newest.id,
                taskTestUuid(20_002),
            ]);
            expect(firstPage.nextCursor).toEqual({
                id: taskTestUuid(20_002),
                updatedAtMs: 2000,
            });
            expect(
                await runTaskEffect(
                    service.listTasks({ cursor: firstPage.nextCursor, limit: 2 })
                )
            ).toMatchObject({ tasks: [{ id: oldest.id }] });
            expect(
                await runTaskEffect(
                    service.listTasks({
                        filters: {
                            assignees: ["mira-2026"],
                            automation: "recurring",
                            labels: ["automation", "ops"],
                            priorities: ["high"],
                            search: "PRESSURE",
                            statuses: ["todo"],
                        },
                        limit: 10,
                    })
                )
            ).toMatchObject({ tasks: [{ title: "Automated pressure check" }] });

            nowMs = 4000;
            await runTaskEffect(
                service.createTask(taskTestPrincipal, {
                    automation: {
                        cronJobId: "one-shot-filter",
                        kind: "openclaw-cron",
                        recurring: false,
                    },
                    labels: ["automation"],
                    priority: "medium",
                    title: "One-shot automated task",
                })
            );
            expect(
                await runTaskEffect(
                    service.listTasks({
                        filters: { automation: "manual" },
                        limit: 10,
                    })
                )
            ).toMatchObject({
                tasks: [
                    { title: "One-shot automated task" },
                    { title: "Newest manual pressure check" },
                    { title: "Old manual task" },
                ],
            });
        } finally {
            database.sqlite.close(true);
        }
    });
});
