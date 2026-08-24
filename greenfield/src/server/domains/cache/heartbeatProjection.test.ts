import { describe, expect, test } from "bun:test";

import { jobActionDefinitions } from "../jobs/actionRegistry.ts";
import type {
    JobRepositoryReader,
    ScheduleRecordWithRelations,
} from "../jobs/repository.ts";
import type { TaskRepositoryReader } from "../tasks/repositoryTypes.ts";
import {
    readCacheHeartbeatDashboardJobs,
    readCacheHeartbeatTasks,
    readCacheHeartbeatTasksWithCronRefresh,
} from "./heartbeatProjection.ts";

function uuid(index: number): string {
    return `019fdf40-0000-7000-8000-${String(index).padStart(12, "0")}`;
}

function definition(scheduleId: string) {
    const found = jobActionDefinitions.find(
        (candidate) => candidate.scheduleId === scheduleId
    );
    if (found === undefined) throw new Error(`Missing test definition: ${scheduleId}`);
    return found;
}

function relation(
    scheduleId: string,
    input: {
        readonly activeDisableIntent?: Record<string, unknown>;
        readonly activeRun?: Record<string, unknown>;
        readonly enabled: boolean;
        readonly latestRun?: Record<string, unknown>;
        readonly nextRunAt?: Date;
    }
): ScheduleRecordWithRelations {
    return {
        ...(input.activeDisableIntent === undefined
            ? {}
            : { activeDisableIntent: input.activeDisableIntent }),
        ...(input.activeRun === undefined ? {} : { activeRun: input.activeRun }),
        ...(input.latestRun === undefined ? {} : { latestRun: input.latestRun }),
        schedule: {
            actionKey: definition(scheduleId).actionKey,
            actionPayloadJson: '{"private":"payload"}',
            description: "Private description",
            enabled: input.enabled,
            id: scheduleId,
            name: "Private schedule name",
            nextRunAt: input.nextRunAt ?? null,
            resourceKeysJson: '["private.resource"]',
        },
    } as unknown as ScheduleRecordWithRelations;
}

describe("cache heartbeat projection", () => {
    test("declassifies only canonical task identifiers and operational relevance", () => {
        const repository = {
            readHeartbeatCandidates: () => ({
                rows: [
                    {
                        assignee: "rajohan" as const,
                        id: uuid(3),
                        priority: "low" as const,
                        status: "blocked" as const,
                    },
                    {
                        assignee: "mira-2026" as const,
                        automation: {
                            cronJobId: "private-cron-1",
                            recurring: false,
                        },
                        id: uuid(1),
                        priority: "high" as const,
                        status: "in-progress" as const,
                    },
                    {
                        automation: {
                            cronJobId: "private-cron-2",
                            recurring: true,
                        },
                        id: uuid(2),
                        priority: "low" as const,
                        status: "todo" as const,
                    },
                ],
                totalCount: 3,
            }),
        } satisfies Pick<TaskRepositoryReader, "readHeartbeatCandidates">;

        const projection = readCacheHeartbeatTasks(repository, (cronJobId) =>
            cronJobId === "private-cron-1"
                ? {
                      desiredEnabled: false,
                      enabled: false,
                      state: "present",
                      synchronization: "confirmed",
                  }
                : { state: "missing" }
        );
        expect(projection).toEqual({
            items: [
                {
                    automation: {
                        cron: {
                            desiredEnabled: false,
                            enabled: false,
                            state: "present",
                            synchronization: "confirmed",
                        },
                        recurring: false,
                    },
                    id: uuid(1),
                    priority: "high",
                    relevance: ["automation-linked", "agent-priority"],
                    status: "in-progress",
                },
                {
                    automation: {
                        cron: { state: "missing" },
                        recurring: true,
                    },
                    id: uuid(2),
                    priority: "low",
                    relevance: ["automation-linked"],
                    status: "todo",
                },
                {
                    id: uuid(3),
                    priority: "low",
                    relevance: ["owner-blocked"],
                    status: "blocked",
                },
            ],
            state: "available",
            totalCount: 3,
            truncated: false,
        });
        expect(JSON.stringify(projection)).not.toContain("assignee");
        expect(JSON.stringify(projection)).not.toContain("cronJobId");
    });

    test("refreshes cron outside the task read and independently of task failures", async () => {
        const events: string[] = [];
        const snapshot = {
            rows: [],
            totalCount: 0,
        };
        const available = await readCacheHeartbeatTasksWithCronRefresh(
            () => {
                events.push("task-read");
                return snapshot;
            },
            () => {
                events.push("cron-refresh");
                return Promise.resolve();
            },
            () => ({ state: "unavailable" })
        );
        expect(events).toEqual(["task-read", "cron-refresh"]);
        expect(available).toEqual({
            items: [],
            state: "available",
            totalCount: 0,
            truncated: false,
        });

        events.length = 0;
        const unavailable = await readCacheHeartbeatTasksWithCronRefresh(
            () => {
                events.push("task-read-failed");
                throw new Error("private database detail");
            },
            () => {
                events.push("cron-refresh-after-failure");
                return Promise.resolve();
            },
            () => ({ state: "missing" })
        );
        expect(events).toEqual(["task-read-failed", "cron-refresh-after-failure"]);
        expect(unavailable).toEqual({ state: "unavailable" });
    });

    test("preserves readable tasks when cron refresh or lookup is unavailable", async () => {
        const snapshot = {
            rows: [
                {
                    automation: {
                        cronJobId: "private-cron",
                        recurring: true,
                    },
                    id: uuid(4),
                    priority: "low" as const,
                    status: "todo" as const,
                },
                {
                    assignee: "rajohan" as const,
                    id: uuid(5),
                    priority: "low" as const,
                    status: "blocked" as const,
                },
            ],
            totalCount: 2,
        };
        let cronLookups = 0;
        const refreshDegraded = await readCacheHeartbeatTasksWithCronRefresh(
            () => snapshot,
            () => Promise.reject(new Error("private cron refresh failure")),
            () => {
                cronLookups += 1;
                return { state: "missing" };
            }
        );
        const expected = {
            items: [
                {
                    automation: {
                        cron: { state: "unavailable" as const },
                        recurring: true,
                    },
                    id: uuid(4),
                    priority: "low" as const,
                    relevance: ["automation-linked" as const],
                    status: "todo" as const,
                },
                {
                    id: uuid(5),
                    priority: "low" as const,
                    relevance: ["owner-blocked" as const],
                    status: "blocked" as const,
                },
            ],
            state: "available" as const,
            totalCount: 2,
            truncated: false,
        };

        expect(refreshDegraded).toEqual(expected);
        expect(cronLookups).toBe(0);

        const lookupDegraded = await readCacheHeartbeatTasksWithCronRefresh(
            () => snapshot,
            () => Promise.resolve(),
            () => {
                throw new Error("private cron lookup failure");
            }
        );
        expect(lookupDegraded).toEqual(expected);
    });

    test("projects every code-owned schedule with compact run and expiry state", () => {
        const queuedRun = {
            firstStartedAt: null,
            finishedAt: null,
            payloadJson: '{"private":"queued-payload"}',
            queuedAt: new Date(4000),
            state: "queued",
            terminalCode: null,
            terminalMessage: "Private queued message",
            triggerType: "schedule",
            updatedAt: new Date(4500),
        };
        const runningRun = {
            firstStartedAt: new Date(4500),
            finishedAt: null,
            leaseOwnerId: "private-worker",
            queuedAt: new Date(4000),
            state: "running",
            terminalCode: null,
            terminalMessage: null,
            triggerType: "schedule",
            updatedAt: new Date(6000),
        };
        const failedRun = {
            firstStartedAt: new Date(3000),
            finishedAt: new Date(3500),
            queuedAt: new Date(2500),
            resultJson: '{"private":"result"}',
            state: "failed",
            terminalCode: "provider-unavailable",
            terminalMessage: "Private terminal message",
            triggerType: "schedule",
            updatedAt: new Date(3500),
        };
        const byId = new Map<string, ScheduleRecordWithRelations>([
            [
                "cache.moltbook-dashboard",
                relation("cache.moltbook-dashboard", {
                    activeRun: runningRun,
                    enabled: true,
                    latestRun: runningRun,
                    nextRunAt: new Date(10_000),
                }),
            ],
            [
                "cache.system-host",
                relation("cache.system-host", {
                    activeDisableIntent: {
                        createdAt: new Date(1000),
                        expiresAt: new Date(5500),
                        id: uuid(90),
                        reason: "Private reason",
                    },
                    activeRun: queuedRun,
                    enabled: false,
                    latestRun: queuedRun,
                    nextRunAt: new Date(9000),
                }),
            ],
            [
                "maintenance.rotate-managed-logs",
                relation("maintenance.rotate-managed-logs", {
                    activeDisableIntent: {
                        createdAt: new Date(1000),
                        expiresAt: null,
                        id: uuid(91),
                        reason: "Private indefinite reason",
                    },
                    enabled: false,
                    latestRun: failedRun,
                }),
            ],
        ]);
        const repository = {
            findSchedule: (id: string) => byId.get(id),
        } satisfies Pick<JobRepositoryReader, "findSchedule">;

        const result = readCacheHeartbeatDashboardJobs(repository, 5000);
        expect(result.generatedAtMs).toBe(6000);
        expect(result.dashboardJobs).toMatchObject({
            items: [
                {
                    defaultEnabled: true,
                    id: "cache.database-observability",
                    state: "missing",
                },
                {
                    defaultEnabled: true,
                    id: "cache.docker-overview",
                    state: "missing",
                },
                {
                    activeRun: { state: "running" },
                    defaultEnabled: true,
                    enabled: true,
                    id: "cache.moltbook-dashboard",
                    latestRun: { state: "running", triggerType: "schedule" },
                    nextRunAtMs: 10_000,
                    state: "present",
                },
                {
                    activeRun: { state: "queued" },
                    defaultEnabled: true,
                    disableIntent: { expiresAtMs: 5500, valid: false },
                    enabled: false,
                    id: "cache.system-host",
                    latestRun: { state: "queued", triggerType: "schedule" },
                    nextRunAtMs: null,
                    state: "present",
                },
                {
                    defaultEnabled: true,
                    id: "database.sqlite-maintenance",
                    state: "missing",
                },
                {
                    defaultEnabled: true,
                    id: "docker.updater",
                    state: "missing",
                },
                {
                    defaultEnabled: true,
                    disableIntent: { valid: true },
                    enabled: false,
                    id: "maintenance.rotate-managed-logs",
                    latestRun: {
                        state: "failed",
                        terminalCode: "provider-unavailable",
                        triggerType: "schedule",
                    },
                    nextRunAtMs: null,
                    state: "present",
                },
                {
                    defaultEnabled: false,
                    id: "system.worker-smoke",
                    state: "missing",
                },
            ],
            state: "available",
        });
        const serialized = JSON.stringify(result);
        for (const forbidden of [
            "Private",
            "payloadJson",
            "resultJson",
            "leaseOwnerId",
            "resourceKeys",
            uuid(90),
            uuid(91),
        ]) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    test("degrades inconsistent or failed Dashboard-job reads without failing heartbeat", () => {
        const selectedDefinition = definition("cache.moltbook-dashboard");
        const terminalActiveRun = relation(selectedDefinition.scheduleId, {
            activeRun: { state: "succeeded" },
            enabled: true,
        });

        expect(
            readCacheHeartbeatDashboardJobs(
                { findSchedule: () => terminalActiveRun },
                5000,
                [selectedDefinition]
            )
        ).toEqual({
            dashboardJobs: { state: "unavailable" },
            generatedAtMs: 5000,
        });
        expect(
            readCacheHeartbeatDashboardJobs(
                {
                    findSchedule() {
                        throw new Error("private repository failure");
                    },
                },
                6000,
                [selectedDefinition]
            )
        ).toEqual({
            dashboardJobs: { state: "unavailable" },
            generatedAtMs: 6000,
        });
    });
});
