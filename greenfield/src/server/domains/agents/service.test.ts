import { describe, expect, test } from "bun:test";

import { count, eq } from "drizzle-orm";

import { agentTaskRuns } from "../../database/schema/agentTaskRuns.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { AgentNotFoundError } from "./errors.ts";
import {
    agentServiceFor,
    agentTestUuid,
    agentTestPrincipal,
    openFreshMigratedDatabase,
    runAgentEffect,
} from "./testSupport/agentService.ts";

describe("agent service", () => {
    test("starts, touches, replaces, and clears one attributed current task", async () => {
        const database = await openFreshMigratedDatabase();
        let nowMs = 10_000;
        let wakeups = 0;
        const service = agentServiceFor(database, {
            nowMs: () => nowMs,
            wakeEventPump: () => {
                wakeups += 1;
            },
        });

        try {
            const started = await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: "Implement agent status",
                })
            );
            expect(started).toMatchObject({
                agentId: "main",
                currentTask: "Implement agent status",
                lastActivityAtMs: 10_000,
                startedAtMs: 10_000,
                state: "working",
            });

            nowMs = 9000;
            const touched = await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: "Implement agent status",
                })
            );
            expect(touched.lastActivityAtMs).toBe(10_000);

            nowMs = 20_000;
            const replaced = await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: "Review Phase 3",
                })
            );
            expect(replaced).toMatchObject({
                currentTask: "Review Phase 3",
                startedAtMs: 20_000,
                state: "working",
            });

            nowMs = 30_000;
            const cleared = await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: null,
                })
            );
            expect(cleared).toEqual({
                agentId: "main",
                lastActivityAtMs: 30_000,
                state: "idle",
            });

            nowMs = 25_000;
            const restarted = await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: "Start after clock regression",
                })
            );
            expect(restarted).toMatchObject({
                currentTask: "Start after clock regression",
                lastActivityAtMs: 30_001,
                startedAtMs: 30_001,
                state: "working",
            });

            const history = await runAgentEffect(
                service.listTaskHistory({ agentId: "main", limit: 10 })
            );
            expect(history.runs.map(({ status, task }) => ({ status, task }))).toEqual([
                { status: "active", task: "Start after clock regression" },
                { status: "completed", task: "Review Phase 3" },
                { status: "completed", task: "Implement agent status" },
            ]);
            const records = database.orm
                .select()
                .from(agentTaskRuns)
                .orderBy(agentTaskRuns.startedAt)
                .all();
            expect(records).toHaveLength(3);
            expect(records[0]).toMatchObject({
                completedById: "openclaw-task-tracking",
                completedByKind: "automation",
                lastUpdatedById: "openclaw-task-tracking",
                startedById: "openclaw-task-tracking",
            });
            expect(wakeups).toBe(4);
            expect(
                database.orm.select({ value: count() }).from(realtimeEvents).get()?.value
            ).toBe(4);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("returns canonical status pages and stable filtered cursors", async () => {
        const database = await openFreshMigratedDatabase();
        let nowMs = 1000;
        const service = agentServiceFor(database, { nowMs: () => nowMs });

        try {
            for (const currentTask of ["First", "Second", "Third"]) {
                await runAgentEffect(
                    service.updateMetadata(agentTestPrincipal, {
                        agentId: "researcher",
                        currentTask,
                    })
                );
                nowMs += 1000;
            }
            const statuses = await runAgentEffect(service.listStatuses());
            expect(statuses.statuses.map(({ agentId }) => agentId)).toEqual([
                "coder",
                "communicator",
                "main",
                "monitor",
                "researcher",
            ]);
            expect(statuses.statuses.at(-1)).toMatchObject({
                currentTask: "Third",
                state: "working",
            });

            const firstPage = await runAgentEffect(
                service.listTaskHistory({ agentId: "researcher", limit: 1 })
            );
            expect(firstPage.runs).toHaveLength(1);
            expect(firstPage.nextCursor).toBeDefined();
            const secondPage = await runAgentEffect(
                service.listTaskHistory({
                    agentId: "researcher",
                    cursor: firstPage.nextCursor,
                    limit: 1,
                })
            );
            expect(secondPage.runs).toHaveLength(1);
            expect(secondPage.runs[0]?.id).not.toBe(firstPage.runs[0]?.id);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("keeps exact, list, and history status consistent across equal timestamps", async () => {
        const database = await openFreshMigratedDatabase();
        let nowMs = 10_000;
        const ids = [agentTestUuid(900), agentTestUuid(1)];
        const service = agentServiceFor(database, {
            generateId: () => ids.shift()!,
            nowMs: () => nowMs,
        });

        try {
            await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: "First run",
                })
            );
            await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: null,
                })
            );

            nowMs = 1000;
            const restarted = await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: "Restart after clock regression",
                })
            );
            const exact = await runAgentEffect(service.getStatus({ id: "main" }));
            const listed = await runAgentEffect(service.listStatuses());
            const history = await runAgentEffect(
                service.listTaskHistory({ agentId: "main", limit: 10 })
            );

            if (restarted.state !== "working") {
                throw new TypeError("Restarted agent must be working");
            }
            expect(restarted.startedAtMs).toBe(10_001);
            expect(exact).toEqual(restarted);
            expect(listed.statuses.find(({ agentId }) => agentId === "main")).toEqual(
                restarted
            );
            expect(history.runs.map(({ id }) => id)).toEqual([
                agentTestUuid(1),
                agentTestUuid(900),
            ]);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("fails closed for unknown agents without persistence", async () => {
        const database = await openFreshMigratedDatabase();
        const service = agentServiceFor(database);
        try {
            expect(
                runAgentEffect(
                    service.updateMetadata(agentTestPrincipal, {
                        agentId: "unknown",
                        currentTask: "Should not persist",
                    })
                )
            ).rejects.toBeInstanceOf(AgentNotFoundError);
            expect(
                database.orm
                    .select({ value: count() })
                    .from(agentTaskRuns)
                    .where(eq(agentTaskRuns.agentId, "unknown"))
                    .get()?.value
            ).toBe(0);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("fails closed when persisted history references an unconfigured agent", async () => {
        const database = await openFreshMigratedDatabase();
        const service = agentServiceFor(database);
        try {
            database.sqlite.run(
                `INSERT INTO agent_task_runs (
                    agent_id, id, last_activity_at, last_updated_by_id,
                    last_updated_by_kind, started_at, started_by_id,
                    started_by_kind, task
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    "unconfigured",
                    "019fd100-0000-7000-8000-000000000099",
                    1000,
                    "openclaw-task-tracking",
                    "automation",
                    1000,
                    "openclaw-task-tracking",
                    "automation",
                    "Corrupt history row",
                ]
            );

            expect(
                runAgentEffect(service.listTaskHistory({ limit: 10 }))
            ).rejects.toThrow("Persisted agent task run references an unknown agent");
        } finally {
            database.sqlite.close(true);
        }
    });
});
