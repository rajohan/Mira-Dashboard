import { describe, expect, test } from "bun:test";

import { count, eq } from "drizzle-orm";

import { agentTaskRuns } from "../../database/schema/agentTaskRuns.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import type { GatewaySessionsProvider } from "../gatewaySessions/provider.ts";
import { createGatewaySessionsService } from "../gatewaySessions/service.ts";
import { AgentNotFoundError } from "./errors.ts";
import { createAgentRepository, type AgentRepository } from "./repository.ts";
import {
    agentServiceFor,
    agentTestUuid,
    agentTestPrincipal,
    openFreshMigratedDatabase,
    runAgentEffect,
} from "./testSupport/agentService.ts";

const unexpectedGatewaySessionControl = (): Promise<never> =>
    Promise.reject(new TypeError("Unexpected Gateway session control"));

describe("agent service", () => {
    test("keeps Dashboard task state while retaining stale Gateway session availability", async () => {
        const database = await openFreshMigratedDatabase();
        let sessionReadCount = 0;
        const provider: GatewaySessionsProvider = Object.freeze({
            compactSession: unexpectedGatewaySessionControl,
            deleteSessionTranscript: unexpectedGatewaySessionControl,
            listCurrentSessions: () => {
                sessionReadCount += 1;
                if (sessionReadCount > 1) {
                    return Promise.reject(new Error("private Gateway failure"));
                }
                return Promise.resolve({
                    sessions: [
                        {
                            displayName: "Mira",
                            hasActiveRun: false,
                            key: "agent:main:main",
                            kind: "main" as const,
                            model: "gpt-5.6-sol",
                            modelProvider: "openai",
                            totalTokensFresh: false,
                            updatedAtMs: 9000,
                        },
                        {
                            displayName: "Unreviewed",
                            hasActiveRun: true,
                            key: "agent:unreviewed:main",
                            kind: "main" as const,
                            totalTokensFresh: false,
                            updatedAtMs: 9500,
                        },
                    ],
                    truncated: false,
                });
            },
            resetSession: unexpectedGatewaySessionControl,
        });
        const gatewaySessionsService = createGatewaySessionsService({
            nowMs: () => 10_000,
            provider,
        });
        const service = agentServiceFor(database, { gatewaySessionsService });

        try {
            const mutationStatus = await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: "Keep task ownership separate",
                })
            );
            expect(mutationStatus).toMatchObject({ state: "working" });
            expect("gatewayAvailability" in mutationStatus).toBeFalse();

            const fresh = await runAgentEffect(service.listStatuses());
            expect(fresh.statuses).toHaveLength(5);
            expect(
                fresh.statuses.some(({ agentId }) => agentId === "unreviewed")
            ).toBeFalse();
            expect(
                fresh.statuses.find(({ agentId }) => agentId === "main")
            ).toMatchObject({
                freshness: "fresh",
                gatewayAvailability: "idle",
                hasActiveRun: false,
                providerModel: "openai/gpt-5.6-sol",
                sessionKey: "agent:main:main",
                state: "working",
            });

            const stale = await runAgentEffect(service.getStatus({ id: "main" }));
            expect(stale).toMatchObject({
                currentTask: "Keep task ownership separate",
                freshness: "stale",
                gatewayAvailability: "stale",
                hasActiveRun: false,
                sessionKey: "agent:main:main",
                state: "working",
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("ends only the current-task interval after a fresh Gateway active-to-idle transition", async () => {
        const database = await openFreshMigratedDatabase();
        let hasActiveRun = true;
        let wakeups = 0;
        const provider: GatewaySessionsProvider = Object.freeze({
            compactSession: unexpectedGatewaySessionControl,
            deleteSessionTranscript: unexpectedGatewaySessionControl,
            listCurrentSessions: () =>
                Promise.resolve({
                    sessions: [
                        {
                            displayName: "Mira",
                            hasActiveRun,
                            key: "agent:main:main",
                            kind: "main" as const,
                            totalTokensFresh: false,
                            updatedAtMs: hasActiveRun ? 9000 : 10_000,
                        },
                    ],
                    truncated: false,
                }),
            resetSession: unexpectedGatewaySessionControl,
        });
        const service = agentServiceFor(database, {
            gatewaySessionsService: createGatewaySessionsService({
                nowMs: () => 10_000,
                provider,
            }),
            nowMs: () => 10_000,
            wakeEventPump: () => {
                wakeups += 1;
            },
        });

        try {
            await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: "Keep taskboard ownership separate",
                })
            );
            const active = await runAgentEffect(service.getStatus({ id: "main" }));
            expect(active).toMatchObject({
                currentTask: "Keep taskboard ownership separate",
                gatewayAvailability: "active",
                state: "working",
            });

            hasActiveRun = false;
            const idle = await runAgentEffect(service.getStatus({ id: "main" }));
            expect(idle).toMatchObject({
                agentId: "main",
                gatewayAvailability: "idle",
                state: "idle",
            });
            expect(idle).not.toHaveProperty("currentTask");

            const history = await runAgentEffect(
                service.listTaskHistory({ agentId: "main", limit: 10 })
            );
            expect(history.runs).toEqual([
                expect.objectContaining({
                    completedAtMs: 10_000,
                    status: "completed",
                    task: "Keep taskboard ownership separate",
                }),
            ]);
            expect(database.orm.select().from(agentTaskRuns).get()).toMatchObject({
                completedById: "gateway-session-fallback",
                completedByKind: "automation",
            });
            expect(wakeups).toBe(2);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("retries an idle fallback after write admission recovers", async () => {
        const database = await openFreshMigratedDatabase();
        let hasActiveRun = true;
        let rejectNextWrite = false;
        const baseRepository = createAgentRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const repository: AgentRepository = {
            findActiveRun: (agentId) => baseRepository.findActiveRun(agentId),
            findLatestRun: (agentId) => baseRepository.findLatestRun(agentId),
            listActiveRuns: (agentIds) => baseRepository.listActiveRuns(agentIds),
            listTaskRuns: (input) => baseRepository.listTaskRuns(input),
            withImmediateTransaction: (callback) => {
                if (rejectNextWrite) {
                    rejectNextWrite = false;
                    return Promise.reject(new Error("temporary write admission failure"));
                }
                return baseRepository.withImmediateTransaction(callback);
            },
            withReadTransaction: (callback) =>
                baseRepository.withReadTransaction(callback),
        };
        const provider: GatewaySessionsProvider = Object.freeze({
            compactSession: unexpectedGatewaySessionControl,
            deleteSessionTranscript: unexpectedGatewaySessionControl,
            listCurrentSessions: () =>
                Promise.resolve({
                    sessions: [
                        {
                            displayName: "Mira",
                            hasActiveRun,
                            key: "agent:main:main",
                            kind: "main" as const,
                            totalTokensFresh: false,
                        },
                    ],
                    truncated: false,
                }),
            resetSession: unexpectedGatewaySessionControl,
        });
        const service = agentServiceFor(database, {
            gatewaySessionsService: createGatewaySessionsService({ provider }),
            repository,
        });

        try {
            await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: "Retry fallback",
                })
            );
            await runAgentEffect(service.getStatus({ id: "main" }));
            hasActiveRun = false;
            rejectNextWrite = true;
            const rejected = await runAgentEffect(service.getStatus({ id: "main" })).then(
                () => null,
                (error: unknown) => error
            );
            expect(rejected).toBeInstanceOf(Error);
            expect(rejected).toHaveProperty(
                "message",
                "temporary write admission failure"
            );

            const idle = await runAgentEffect(service.getStatus({ id: "main" }));
            expect(idle).toMatchObject({ state: "idle" });
            const history = await runAgentEffect(
                service.listTaskHistory({ agentId: "main", limit: 10 })
            );
            expect(history).toMatchObject({ runs: [{ status: "completed" }] });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("does not close a replacement task that was never observed active", async () => {
        const database = await openFreshMigratedDatabase();
        let hasActiveRun = true;
        const provider: GatewaySessionsProvider = Object.freeze({
            compactSession: unexpectedGatewaySessionControl,
            deleteSessionTranscript: unexpectedGatewaySessionControl,
            listCurrentSessions: () =>
                Promise.resolve({
                    sessions: [
                        {
                            displayName: "Mira",
                            hasActiveRun,
                            key: "agent:main:main",
                            kind: "main" as const,
                            totalTokensFresh: false,
                        },
                    ],
                    truncated: false,
                }),
            resetSession: unexpectedGatewaySessionControl,
        });
        const service = agentServiceFor(database, {
            gatewaySessionsService: createGatewaySessionsService({ provider }),
        });

        try {
            await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: "Observed active task",
                })
            );
            await runAgentEffect(service.getStatus({ id: "main" }));
            await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: "Replacement task",
                })
            );
            hasActiveRun = false;

            const idle = await runAgentEffect(service.getStatus({ id: "main" }));
            expect(idle).toMatchObject({
                currentTask: "Replacement task",
                gatewayAvailability: "idle",
                state: "working",
            });
            const history = await runAgentEffect(
                service.listTaskHistory({ agentId: "main", limit: 10 })
            );
            expect(history).toMatchObject({
                runs: [
                    { status: "active", task: "Replacement task" },
                    { status: "completed", task: "Observed active task" },
                ],
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("does not let an older idle fallback override a newer active observation", async () => {
        const database = await openFreshMigratedDatabase();
        let hasActiveRun = true;
        let holdNextWrite = false;
        const writeWaiting = Promise.withResolvers<void>();
        const writeRelease = Promise.withResolvers<void>();
        const baseRepository = createAgentRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const repository: AgentRepository = {
            findActiveRun: (agentId) => baseRepository.findActiveRun(agentId),
            findLatestRun: (agentId) => baseRepository.findLatestRun(agentId),
            listActiveRuns: (agentIds) => baseRepository.listActiveRuns(agentIds),
            listTaskRuns: (input) => baseRepository.listTaskRuns(input),
            withImmediateTransaction: async (callback) => {
                if (holdNextWrite) {
                    holdNextWrite = false;
                    writeWaiting.resolve();
                    await writeRelease.promise;
                }
                return baseRepository.withImmediateTransaction(callback);
            },
            withReadTransaction: (callback) =>
                baseRepository.withReadTransaction(callback),
        };
        const provider: GatewaySessionsProvider = Object.freeze({
            compactSession: unexpectedGatewaySessionControl,
            deleteSessionTranscript: unexpectedGatewaySessionControl,
            listCurrentSessions: () =>
                Promise.resolve({
                    sessions: [
                        {
                            displayName: "Mira",
                            hasActiveRun,
                            key: "agent:main:main",
                            kind: "main" as const,
                            totalTokensFresh: false,
                        },
                    ],
                    truncated: false,
                }),
            resetSession: unexpectedGatewaySessionControl,
        });
        const service = agentServiceFor(database, {
            gatewaySessionsService: createGatewaySessionsService({ provider }),
            repository,
        });

        try {
            await runAgentEffect(
                service.updateMetadata(agentTestPrincipal, {
                    agentId: "main",
                    currentTask: "Generation-fenced fallback",
                })
            );
            await runAgentEffect(service.getStatus({ id: "main" }));

            holdNextWrite = true;
            hasActiveRun = false;
            const olderIdleRead = runAgentEffect(service.getStatus({ id: "main" }));
            await writeWaiting.promise;
            hasActiveRun = true;
            const active = await runAgentEffect(service.getStatus({ id: "main" }));
            expect(active).toMatchObject({
                gatewayAvailability: "active",
                state: "working",
            });
            writeRelease.resolve();
            await olderIdleRead;

            const history = await runAgentEffect(
                service.listTaskHistory({ agentId: "main", limit: 10 })
            );
            expect(history).toMatchObject({
                runs: [{ status: "active", task: "Generation-fenced fallback" }],
            });
        } finally {
            writeRelease.resolve();
            database.sqlite.close(true);
        }
    });

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
            const expectedReadStatus = {
                ...restarted,
                freshness: "unavailable",
                gatewayAvailability: "disconnected",
            };
            expect(exact).toEqual(expectedReadStatus);
            expect(listed.statuses.find(({ agentId }) => agentId === "main")).toEqual(
                expectedReadStatus
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
