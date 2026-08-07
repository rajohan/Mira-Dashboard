import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";

const firstRunId = "019fd200-0000-7000-8000-000000000001";
const secondRunId = "019fd200-0000-7000-8000-000000000002";

function insertActiveRun(
    database: Awaited<ReturnType<typeof openFreshMigratedDatabase>>,
    id: string,
    actorKind = "automation",
    actorId = "openclaw-task-tracking"
): void {
    database.sqlite.run(
        `INSERT INTO agent_task_runs (
            agent_id, id, last_activity_at, last_updated_by_id,
            last_updated_by_kind, started_at, started_by_id, started_by_kind, task
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["main", id, 1000, actorId, actorKind, 1000, actorId, actorKind, "Test run"]
    );
}

describe("agent task-run baseline schema", () => {
    test("enforces active-run, actor, and completed-history invariants", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            insertActiveRun(database, firstRunId);
            expect(() => insertActiveRun(database, secondRunId)).toThrow(
                "UNIQUE constraint failed"
            );
            expect(() =>
                insertActiveRun(database, secondRunId, "user", "automation-id")
            ).toThrow("agent_task_runs_last_updated_actor_check");
            expect(() =>
                database.sqlite.run(
                    "UPDATE agent_task_runs SET last_activity_at = ? WHERE id = ?",
                    [999, firstRunId]
                )
            ).toThrow("agent_task_runs activity is monotonic");
            expect(() =>
                database.sqlite.run("DELETE FROM agent_task_runs WHERE id = ?", [
                    firstRunId,
                ])
            ).toThrow("agent_task_runs history cannot be deleted");

            database.sqlite.run(
                `UPDATE agent_task_runs
                 SET completed_at = ?, completed_by_id = ?, completed_by_kind = ?,
                     last_activity_at = ?, last_updated_by_id = ?,
                     last_updated_by_kind = ?
                 WHERE id = ?`,
                [
                    2000,
                    "openclaw-task-tracking",
                    "automation",
                    2000,
                    "openclaw-task-tracking",
                    "automation",
                    firstRunId,
                ]
            );
            expect(() =>
                database.sqlite.run(
                    "UPDATE agent_task_runs SET last_activity_at = ? WHERE id = ?",
                    [3000, firstRunId]
                )
            ).toThrow("completed agent_task_runs are immutable");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("uses the declared indexes for active and history reads", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            const activeRunPlan = database.sqlite
                .query<{ detail: string }, [string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM agent_task_runs
                    WHERE agent_id = ? AND completed_at IS NULL
                    LIMIT 1
                `)
                .all("main");
            const globalHistoryPlan = database.sqlite
                .query<{ detail: string }, []>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM agent_task_runs
                    ORDER BY started_at DESC, id DESC
                    LIMIT 50
                `)
                .all();
            const agentHistoryPlan = database.sqlite
                .query<{ detail: string }, [string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM agent_task_runs
                    WHERE agent_id = ?
                    ORDER BY started_at DESC, id DESC
                    LIMIT 50
                `)
                .all("main");

            expect(
                activeRunPlan.some(({ detail }) =>
                    detail.includes("agent_task_runs_one_active_agent_idx")
                )
            ).toBeTrue();
            expect(
                globalHistoryPlan.some(({ detail }) =>
                    detail.includes("agent_task_runs_started_id_idx")
                )
            ).toBeTrue();
            expect(
                agentHistoryPlan.some(({ detail }) =>
                    detail.includes("agent_task_runs_agent_started_id_idx")
                )
            ).toBeTrue();
        } finally {
            database.sqlite.close(true);
        }
    });
});
