import { describe, expect, test } from "bun:test";

import { taskAutomationProfiles } from "../../database/schema/taskAutomationProfiles.ts";
import { tasks } from "../../database/schema/tasks.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createTaskRepository } from "./repository.ts";

describe("task repository cron projection", () => {
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
});
