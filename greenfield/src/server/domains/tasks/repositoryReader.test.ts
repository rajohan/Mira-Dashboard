import { describe, expect, test } from "bun:test";

import { automationPrincipals } from "../../database/schema/automationPrincipals.ts";
import { taskAutomationProfiles } from "../../database/schema/taskAutomationProfiles.ts";
import { taskLabels } from "../../database/schema/taskLabels.ts";
import { tasks } from "../../database/schema/tasks.ts";
import { taskUpdates } from "../../database/schema/taskUpdates.ts";
import { users } from "../../database/schema/users.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { testDashboardPasswordHash } from "../../test/support/securityPassword.ts";
import { createTaskRepository } from "./repository.ts";

function uuid(index: number): string {
    return `019fd984-63e8-7404-a7da-${String(index).padStart(12, "0")}`;
}

describe("task repository cron projection", () => {
    test("lists distinct persisted labels in canonical contract order", async () => {
        const database = await openFreshMigratedDatabase();
        const firstTaskId = uuid(390);
        const secondTaskId = uuid(391);
        try {
            database.orm
                .insert(tasks)
                .values([
                    {
                        createdAt: new Date(1000),
                        id: firstTaskId,
                        priority: "medium",
                        status: "todo",
                        title: "First labeled task",
                        updatedAt: new Date(1000),
                    },
                    {
                        createdAt: new Date(1000),
                        id: secondTaskId,
                        priority: "medium",
                        status: "todo",
                        title: "Second labeled task",
                        updatedAt: new Date(1000),
                    },
                ])
                .run();
            database.orm
                .insert(taskLabels)
                .values([
                    { label: "alpha", taskId: firstTaskId },
                    { label: "zeta", taskId: firstTaskId },
                    { label: "alpha", taskId: secondTaskId },
                    { label: "\uE000", taskId: firstTaskId },
                    { label: "\u{10000}", taskId: secondTaskId },
                ])
                .run();
            const repository = createTaskRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission
            );

            expect(repository.listTaskLabels()).toEqual([
                "alpha",
                "zeta",
                "\u{10000}",
                "\uE000",
            ]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("matches case-insensitive search against task labels", async () => {
        const database = await openFreshMigratedDatabase();
        const labelMatchId = uuid(400);
        const unrelatedId = uuid(401);
        try {
            database.orm
                .insert(tasks)
                .values([
                    {
                        createdAt: new Date(1000),
                        id: labelMatchId,
                        priority: "medium",
                        status: "todo",
                        title: "Inspect queue",
                        updatedAt: new Date(2000),
                    },
                    {
                        createdAt: new Date(1000),
                        id: unrelatedId,
                        priority: "medium",
                        status: "todo",
                        title: "Review worker",
                        updatedAt: new Date(1000),
                    },
                ])
                .run();
            database.orm
                .insert(taskLabels)
                .values([
                    { label: "Production-Ops", taskId: labelMatchId },
                    { label: "backend", taskId: unrelatedId },
                ])
                .run();
            const repository = createTaskRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission
            );

            expect(
                repository
                    .listTasks({ filters: { search: "DUCTION-o" }, limit: 10 })
                    .map(({ task }) => task.id)
            ).toEqual([labelMatchId]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("resolves progress display identities and fails closed for orphaned authors", async () => {
        const database = await openFreshMigratedDatabase();
        const taskId = uuid(500);
        const userId = uuid(501);
        const userUpdateId = uuid(502);
        const automationUpdateId = uuid(503);
        const orphanedUserUpdateId = uuid(504);
        const orphanedAutomationUpdateId = uuid(505);
        try {
            database.orm
                .insert(tasks)
                .values({
                    createdAt: new Date(1000),
                    id: taskId,
                    priority: "medium",
                    status: "in-progress",
                    title: "Resolve progress authors",
                    updatedAt: new Date(1000),
                })
                .run();
            database.orm
                .insert(users)
                .values({
                    createdAt: new Date(1000),
                    id: userId,
                    passwordHash: testDashboardPasswordHash,
                    updatedAt: new Date(1000),
                    username: "raymond",
                })
                .run();
            database.orm
                .insert(automationPrincipals)
                .values({
                    createdAt: new Date(1000),
                    id: "task-test-automation",
                    label: "Task test automation",
                    updatedAt: new Date(1000),
                })
                .run();
            database.orm
                .insert(taskUpdates)
                .values([
                    {
                        authorId: userId,
                        authorKind: "user",
                        createdAt: new Date(1000),
                        id: userUpdateId,
                        messageMarkdown: "User-authored update",
                        taskId,
                        updatedAt: new Date(1000),
                    },
                    {
                        authorId: "task-test-automation",
                        authorKind: "automation",
                        createdAt: new Date(1000),
                        id: automationUpdateId,
                        messageMarkdown: "Automation-authored update",
                        taskId,
                        updatedAt: new Date(1000),
                    },
                    {
                        authorId: uuid(506),
                        authorKind: "user",
                        createdAt: new Date(1000),
                        id: orphanedUserUpdateId,
                        messageMarkdown: "Orphaned user update",
                        taskId,
                        updatedAt: new Date(1000),
                    },
                    {
                        authorId: "orphaned-task-automation",
                        authorKind: "automation",
                        createdAt: new Date(1000),
                        id: orphanedAutomationUpdateId,
                        messageMarkdown: "Orphaned automation update",
                        taskId,
                        updatedAt: new Date(1000),
                    },
                ])
                .run();
            const repository = createTaskRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission
            );

            expect(repository.findTaskProgress(taskId, userUpdateId)).toMatchObject({
                authorId: userId,
                authorKind: "user",
                authorUsername: "raymond",
            });
            expect(repository.findTaskProgress(taskId, automationUpdateId)).toMatchObject(
                {
                    authorId: "task-test-automation",
                    authorKind: "automation",
                    authorLabel: "Task test automation",
                }
            );
            expect(() =>
                repository.findTaskProgress(taskId, orphanedUserUpdateId)
            ).toThrow();
            expect(() =>
                repository.findTaskProgress(taskId, orphanedAutomationUpdateId)
            ).toThrow();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("returns only exact unfinished task relationships in one bounded read", async () => {
        const database = await openFreshMigratedDatabase();
        const openId = "019fd984-63e8-7404-a7da-80c6f243794f";
        const doneId = "019fd984-63e8-7404-a7da-80c6f2437950";
        try {
            database.orm
                .insert(tasks)
                .values([
                    {
                        createdAt: new Date(1000),
                        id: openId,
                        priority: "high",
                        status: "blocked",
                        title: "Open linked task",
                        updatedAt: new Date(1000),
                    },
                    {
                        createdAt: new Date(1000),
                        id: doneId,
                        priority: "medium",
                        status: "done",
                        title: "Completed linked task",
                        updatedAt: new Date(1000),
                    },
                ])
                .run();
            database.orm
                .insert(taskAutomationProfiles)
                .values([
                    {
                        cronJobId: "open-cron",
                        kind: "openclaw-cron",
                        recurring: true,
                        taskId: openId,
                    },
                    {
                        cronJobId: "done-cron",
                        kind: "openclaw-cron",
                        recurring: true,
                        taskId: doneId,
                    },
                ])
                .run();
            const repository = createTaskRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission
            );

            expect(
                repository.listOpenTasksByCronJobIds([
                    "missing-cron",
                    "done-cron",
                    "open-cron",
                ])
            ).toMatchObject([
                {
                    cronJobId: "open-cron",
                    task: { id: openId, status: "blocked", title: "Open linked task" },
                },
            ]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("reads the exact bounded heartbeat policy in canonical order", async () => {
        const database = await openFreshMigratedDatabase();
        try {
            const policyRows = [
                { assignee: "mira-2026", priority: "medium", status: "todo" },
                { assignee: "rajohan", priority: "low", status: "blocked" },
                { assignee: "mira-2026", priority: "low", status: "todo" },
                { assignee: "rajohan", priority: "high", status: "in-progress" },
                { assignee: "mira-2026", priority: "high", status: "done" },
                { assignee: undefined, priority: "high", status: "done" },
            ] as const;
            database.orm
                .insert(tasks)
                .values([
                    ...policyRows.map((row, index) => ({
                        ...(row.assignee === undefined ? {} : { assignee: row.assignee }),
                        createdAt: new Date(1000),
                        id: uuid(index),
                        priority: row.priority,
                        status: row.status,
                        title: `Private policy task ${index}`,
                        updatedAt: new Date(1000),
                    })),
                    ...Array.from({ length: 101 }, (_, offset) => ({
                        createdAt: new Date(1000),
                        id: uuid(offset + 6),
                        priority: "low" as const,
                        status: "todo" as const,
                        title: `Private automation task ${offset}`,
                        updatedAt: new Date(1000),
                    })),
                ])
                .run();
            database.orm
                .insert(taskAutomationProfiles)
                .values(
                    Array.from({ length: 101 }, (_, offset) => ({
                        cronJobId: `private-cron-${offset}`,
                        kind: "openclaw-cron" as const,
                        recurring: offset % 2 === 0,
                        taskId: uuid(offset + 6),
                    }))
                )
                .run();
            const repository = createTaskRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission
            );

            const snapshot = repository.readHeartbeatCandidates();
            expect(snapshot.totalCount).toBe(103);
            expect(snapshot.rows).toHaveLength(100);
            expect(snapshot.rows.slice(0, 3)).toEqual([
                {
                    assignee: "mira-2026",
                    id: uuid(0),
                    priority: "medium",
                    status: "todo",
                },
                {
                    assignee: "rajohan",
                    id: uuid(1),
                    priority: "low",
                    status: "blocked",
                },
                {
                    automation: {
                        cronJobId: "private-cron-0",
                        recurring: true,
                    },
                    id: uuid(6),
                    priority: "low",
                    status: "todo",
                },
            ]);
            expect(snapshot.rows.at(-1)?.id).toBe(uuid(103));
            expect(JSON.stringify(snapshot)).not.toContain("Private");
        } finally {
            database.sqlite.close(true);
        }
    });
});
