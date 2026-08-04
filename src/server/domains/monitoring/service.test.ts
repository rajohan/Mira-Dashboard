import { describe, expect, test } from "bun:test";

import { asc, eq } from "drizzle-orm";
import * as v from "valibot";

import { monitoringChangePayloadSchema } from "../../../contracts/monitoring.ts";
import { openFreshMigratedDatabase } from "../../database/migrations/freshDatabaseFixture.ts";
import { incidentObservations } from "../../database/schema/incidentObservations.ts";
import { incidents } from "../../database/schema/incidents.ts";
import { notifications } from "../../database/schema/notifications.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { createMonitoringRepository, type MonitoringRepository } from "./repository.ts";
import { createMonitoringService, MonitoringRunConflictError } from "./service.ts";

const eventNowMs = 10_000;
const oneDayMs = 24 * 60 * 60 * 1000;

function uuid(index: number): string {
    return `019fcb96-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

function idGenerator(start = 10_000): () => string {
    let next = start;
    return () => uuid(next++);
}

function problem(key: "backup" | "filesystem", overrides: Record<string, unknown> = {}) {
    const baseline =
        key === "filesystem"
            ? {
                  condition: "pressure",
                  details: { usagePercent: 91 },
                  entityKey: "filesystem:root",
                  kind: "system",
                  severity: "warning" as const,
                  title: "Root filesystem pressure",
              }
            : {
                  condition: "overdue",
                  details: { hours: 26 },
                  entityKey: "backup:primary",
                  kind: "backup",
                  severity: "error" as const,
                  title: "Primary backup overdue",
              };
    return { ...baseline, ...overrides };
}

function snapshot(input: {
    completedAtMs: number;
    monitorKey?: string;
    problems?: readonly ReturnType<typeof problem>[];
    run: number;
}) {
    return {
        completedAtMs: input.completedAtMs,
        monitorKey: input.monitorKey ?? "ops-check:primary",
        problems: input.problems ?? [problem("filesystem")],
        report: {
            bodyMarkdown: `# Health at ${input.completedAtMs}`,
            kind: "heartbeat",
            metadata: { complete: true },
            source: "openclaw",
            sourceJobId: input.monitorKey ?? "ops-check:primary",
            title: "System health",
        },
        runId: uuid(input.run),
        startedAtMs: input.completedAtMs - 100,
    };
}

type TestDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

function rowCount(database: TestDatabase, table: string): number {
    return database.sqlite
        .query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
        .get()!.count;
}

function allRowCounts(database: TestDatabase) {
    return {
        incidents: rowCount(database, "incidents"),
        monitorRuns: rowCount(database, "monitor_runs"),
        notifications: rowCount(database, "notifications"),
        observations: rowCount(database, "incident_observations"),
        realtimeEvents: rowCount(database, "realtime_events"),
        reports: rowCount(database, "reports"),
    };
}

function serviceFor(
    database: TestDatabase,
    overrides: {
        generateId?: () => string;
        wakeEventPump?: () => void;
    } = {}
) {
    return createMonitoringService({
        generateId: overrides.generateId ?? idGenerator(),
        nowMs: () => eventNowMs,
        realtimeRetentionMs: oneDayMs,
        repository: createMonitoringRepository(database.orm),
        wakeEventPump: overrides.wakeEventPump,
    });
}

describe("monitoring service", () => {
    test("applies complete snapshots across open, repeat, recovery, and recurrence", async () => {
        const database = await openFreshMigratedDatabase();
        let wakeups = 0;
        const service = serviceFor(database, {
            wakeEventPump: () => {
                wakeups += 1;
            },
        });

        try {
            expect(
                service.submitCompleteSnapshot(
                    snapshot({ completedAtMs: 2000, run: 101 })
                )
            ).toMatchObject({
                createdIncidents: 1,
                observedIncidents: 1,
                realtimeEvents: 3,
                status: "accepted",
            });

            const initialIncident = database.orm.select().from(incidents).get()!;
            const initialNotification = database.orm.select().from(notifications).get()!;
            const manuallyReadAt = new Date(2500);
            database.orm
                .update(notifications)
                .set({ readAt: manuallyReadAt })
                .where(eq(notifications.id, initialNotification.id))
                .run();
            const manuallyReadNotification = database.orm
                .select()
                .from(notifications)
                .get()!;

            const criticalFilesystemProblem = problem("filesystem", {
                details: { usagePercent: 97 },
                severity: "critical",
                title: "Root filesystem almost full",
            });
            expect(
                service.submitCompleteSnapshot(
                    snapshot({
                        completedAtMs: 3000,
                        problems: [criticalFilesystemProblem],
                        run: 102,
                    })
                )
            ).toMatchObject({
                createdIncidents: 0,
                observedIncidents: 1,
                realtimeEvents: 2,
                status: "accepted",
            });

            const repeatedIncident = database.orm.select().from(incidents).get()!;
            expect(repeatedIncident).toMatchObject({
                detailsJson: '{"usagePercent":97}',
                firstSeenAt: new Date(2000),
                generation: 1,
                id: initialIncident.id,
                lastSeenAt: new Date(3000),
                occurrenceCount: 2,
                severity: "critical",
                state: "active",
                title: "Root filesystem almost full",
            });
            expect(database.orm.select().from(notifications).get()).toEqual(
                manuallyReadNotification
            );

            const filesystemProblem = problem("filesystem");
            const backupProblem = problem("backup");
            expect(
                service.submitCompleteSnapshot(
                    snapshot({
                        completedAtMs: 4000,
                        problems: [filesystemProblem, backupProblem],
                        run: 103,
                    })
                )
            ).toMatchObject({
                createdIncidents: 1,
                observedIncidents: 2,
                realtimeEvents: 4,
            });

            expect(
                service.submitCompleteSnapshot(
                    snapshot({
                        completedAtMs: 5000,
                        problems: [backupProblem],
                        run: 104,
                    })
                )
            ).toMatchObject({
                observedIncidents: 1,
                realtimeEvents: 3,
                resolvedIncidents: 1,
            });
            const afterPartialRecovery = database.orm
                .select()
                .from(incidents)
                .orderBy(asc(incidents.title))
                .all();
            expect(afterPartialRecovery.map((incident) => incident.state)).toEqual([
                "active",
                "resolved",
            ]);
            expect(
                database.orm
                    .select()
                    .from(notifications)
                    .where(eq(notifications.id, initialNotification.id))
                    .get()!.readAt
            ).toEqual(manuallyReadAt);

            expect(
                service.submitCompleteSnapshot(
                    snapshot({
                        completedAtMs: 6000,
                        problems: [],
                        run: 105,
                    })
                )
            ).toMatchObject({
                observedIncidents: 0,
                realtimeEvents: 3,
                resolvedIncidents: 1,
            });

            expect(
                service.submitCompleteSnapshot(
                    snapshot({
                        completedAtMs: 7000,
                        problems: [filesystemProblem],
                        run: 106,
                    })
                )
            ).toMatchObject({
                observedIncidents: 1,
                realtimeEvents: 3,
                reopenedIncidents: 1,
            });

            const finalIncidents = database.orm
                .select()
                .from(incidents)
                .orderBy(asc(incidents.title))
                .all();
            const filesystemIncident = finalIncidents.find(
                (incident) => incident.id === initialIncident.id
            )!;
            expect(filesystemIncident).toMatchObject({
                firstSeenAt: new Date(2000),
                generation: 2,
                lastSeenAt: new Date(7000),
                occurrenceCount: 4,
                resolvedAt: null,
                state: "active",
            });
            expect(database.orm.select().from(notifications).all()).toHaveLength(3);
            expect(
                database.orm
                    .select()
                    .from(notifications)
                    .where(eq(notifications.incidentId, filesystemIncident.id))
                    .all()
                    .map((notification) => ({
                        generation: notification.incidentGeneration,
                        readAt: notification.readAt,
                    }))
            ).toEqual([
                { generation: 1, readAt: manuallyReadAt },
                { generation: 2, readAt: null },
            ]);

            expect(allRowCounts(database)).toEqual({
                incidents: 2,
                monitorRuns: 6,
                notifications: 3,
                observations: 6,
                realtimeEvents: 18,
                reports: 6,
            });
            expect(wakeups).toBe(6);

            for (const event of database.orm.select().from(realtimeEvents).all()) {
                expect(
                    v.parse(
                        monitoringChangePayloadSchema,
                        JSON.parse(event.payloadJson) as unknown
                    )
                ).toEqual({ id: event.entityId });
                expect(event.expiresAt.getTime() - event.occurredAt.getTime()).toBe(
                    oneDayMs
                );
            }
            const observations = database.orm.select().from(incidentObservations).all();
            expect(
                observations.some(
                    (observation) =>
                        observation.severity === "critical" &&
                        observation.title === "Root filesystem almost full"
                )
            ).toBeTrue();
        } finally {
            database.sqlite.close(true);
        }
    });

    test("isolates identical fingerprints between monitor streams", async () => {
        const database = await openFreshMigratedDatabase();
        const service = serviceFor(database);

        try {
            service.submitCompleteSnapshot(
                snapshot({ completedAtMs: 2000, monitorKey: "stream:a", run: 201 })
            );
            service.submitCompleteSnapshot(
                snapshot({ completedAtMs: 2100, monitorKey: "stream:b", run: 202 })
            );

            const rows = database.orm.select().from(incidents).all();
            expect(rows).toHaveLength(2);
            expect(new Set(rows.map((row) => row.monitorKey))).toEqual(
                new Set(["stream:a", "stream:b"])
            );
            expect(new Set(rows.map((row) => row.fingerprint)).size).toBe(1);
            expect(database.orm.select().from(notifications).all()).toHaveLength(2);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("makes retries no-ops, rejects run conflicts, and retains stale reports", async () => {
        const database = await openFreshMigratedDatabase();
        let wakeups = 0;
        const service = serviceFor(database, {
            wakeEventPump: () => {
                wakeups += 1;
            },
        });
        const first = snapshot({ completedAtMs: 2000, run: 310 });

        try {
            const accepted = service.submitCompleteSnapshot(first);
            const afterAccepted = allRowCounts(database);
            expect(service.submitCompleteSnapshot(first)).toMatchObject({
                duplicateRunId: true,
                realtimeEvents: 0,
                reportId: accepted.reportId,
                status: "duplicate",
            });
            expect(allRowCounts(database)).toEqual(afterAccepted);
            expect(wakeups).toBe(1);

            expect(() =>
                service.submitCompleteSnapshot({
                    ...first,
                    report: { ...first.report, bodyMarkdown: "# Corrected" },
                })
            ).toThrow(MonitoringRunConflictError);
            expect(allRowCounts(database)).toEqual(afterAccepted);
            expect(wakeups).toBe(1);

            expect(
                service.submitCompleteSnapshot(
                    snapshot({ completedAtMs: 1500, problems: [], run: 309 })
                )
            ).toMatchObject({
                observedIncidents: 0,
                realtimeEvents: 1,
                status: "stale",
            });
            expect(allRowCounts(database)).toEqual({
                ...afterAccepted,
                monitorRuns: afterAccepted.monitorRuns + 1,
                realtimeEvents: afterAccepted.realtimeEvents + 1,
                reports: afterAccepted.reports + 1,
            });
            expect(database.orm.select().from(incidents).get()).toMatchObject({
                occurrenceCount: 1,
                state: "active",
            });

            expect(
                service.submitCompleteSnapshot(
                    snapshot({ completedAtMs: 2000, problems: [], run: 311 })
                )
            ).toMatchObject({
                resolvedIncidents: 1,
                status: "accepted",
            });
            expect(database.orm.select().from(incidents).get()?.state).toBe("resolved");
            expect(wakeups).toBe(3);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("orders snapshots with equal completion times by immutable run id", async () => {
        const database = await openFreshMigratedDatabase();
        const service = serviceFor(database);

        try {
            service.submitCompleteSnapshot(snapshot({ completedAtMs: 2000, run: 710 }));

            const backupProblem = problem("backup");
            const staleResult = service.submitCompleteSnapshot(
                snapshot({
                    completedAtMs: 2000,
                    problems: [backupProblem],
                    run: 709,
                })
            );
            expect(staleResult).toMatchObject({
                createdIncidents: 0,
                observedIncidents: 0,
                realtimeEvents: 1,
                status: "stale",
            });
            expect(database.orm.select().from(incidents).all()).toHaveLength(1);
            expect(database.orm.select().from(incidents).get()).toMatchObject({
                kind: "system",
                state: "active",
            });

            expect(
                service.submitCompleteSnapshot(
                    snapshot({ completedAtMs: 2000, problems: [], run: 711 })
                )
            ).toMatchObject({
                resolvedIncidents: 1,
                status: "accepted",
            });
            expect(database.orm.select().from(incidents).get()?.state).toBe("resolved");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rolls back every domain and outbox write when a late insert fails", async () => {
        const database = await openFreshMigratedDatabase();
        const service = serviceFor(database);

        try {
            service.submitCompleteSnapshot(snapshot({ completedAtMs: 2000, run: 401 }));
            const before = allRowCounts(database);
            const existingNotificationId = database.orm
                .select({ id: notifications.id })
                .from(notifications)
                .get()!.id;
            const generatedIds = [uuid(50_000), uuid(50_001), existingNotificationId];
            const failingService = serviceFor(database, {
                generateId: () => generatedIds.shift()!,
            });

            expect(() =>
                failingService.submitCompleteSnapshot(
                    snapshot({
                        completedAtMs: 3000,
                        problems: [problem("backup")],
                        run: 402,
                    })
                )
            ).toThrow();
            expect(allRowCounts(database)).toEqual(before);
            expect(database.orm.select().from(incidents).get()).toMatchObject({
                occurrenceCount: 1,
                state: "active",
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects malformed snapshots before entering the repository", () => {
        let repositoryEntries = 0;
        const repository: MonitoringRepository = {
            withImmediateTransaction() {
                repositoryEntries += 1;
                throw new Error("repository should not be entered");
            },
        };
        const service = createMonitoringService({ repository });

        expect(() =>
            service.submitCompleteSnapshot({
                ...snapshot({ completedAtMs: 2000, run: 501 }),
                problems: [problem("filesystem"), problem("filesystem")],
            })
        ).toThrow("duplicate problem identities");
        expect(repositoryEntries).toBe(0);
    });

    test("rejects a future watermark before entering the repository", () => {
        let repositoryEntries = 0;
        const repository: MonitoringRepository = {
            withImmediateTransaction() {
                repositoryEntries += 1;
                throw new Error("repository should not be entered");
            },
        };
        const service = createMonitoringService({
            nowMs: () => 10_000,
            repository,
        });

        expect(() =>
            service.submitCompleteSnapshot(snapshot({ completedAtMs: 310_001, run: 502 }))
        ).toThrow("cannot be more than 300000 milliseconds in the future");
        expect(repositoryEntries).toBe(0);
    });

    test("does not turn an event-pump wakeup failure into a failed commit", async () => {
        const database = await openFreshMigratedDatabase();
        const service = serviceFor(database, {
            wakeEventPump: () => {
                throw new Error("pump unavailable");
            },
        });

        try {
            expect(
                service.submitCompleteSnapshot(
                    snapshot({ completedAtMs: 2000, run: 601 })
                ).status
            ).toBe("accepted");
            expect(allRowCounts(database)).toMatchObject({
                incidents: 1,
                realtimeEvents: 3,
                reports: 1,
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects invalid realtime retention before repository work", () => {
        let repositoryEntries = 0;
        const repository: MonitoringRepository = {
            withImmediateTransaction() {
                repositoryEntries += 1;
                throw new Error("repository should not be entered");
            },
        };

        expect(() =>
            createMonitoringService({ realtimeRetentionMs: 0, repository })
        ).toThrow("positive integer");
        expect(() =>
            createMonitoringService({ realtimeRetentionMs: 1.5, repository })
        ).toThrow("positive integer");
        expect(repositoryEntries).toBe(0);
    });
});
