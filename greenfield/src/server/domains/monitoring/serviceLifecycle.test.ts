import { describe, expect, test } from "bun:test";

import { differenceInMilliseconds, toDate } from "date-fns";
import { asc, eq } from "drizzle-orm";
import * as v from "valibot";

import { monitoringChangePayloadSchema } from "../../../contracts/monitoring.ts";
import { incidentObservations } from "../../database/schema/incidentObservations.ts";
import { incidents } from "../../database/schema/incidents.ts";
import { notifications } from "../../database/schema/notifications.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import {
    allRowCounts,
    oneDayMs,
    openFreshMigratedDatabase,
    problem,
    serviceFor,
    snapshot,
    submitSnapshot,
} from "./testSupport/monitoringService.ts";

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
                await submitSnapshot(service, snapshot({ completedAtMs: 2000, run: 101 }))
            ).toMatchObject({
                createdIncidents: 1,
                observedIncidents: 1,
                realtimeEvents: 3,
                status: "accepted",
            });

            const initialIncident = database.orm.select().from(incidents).get()!;
            const initialNotification = database.orm.select().from(notifications).get()!;
            const manuallyReadAt = toDate(2500);
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
                await submitSnapshot(
                    service,
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
                firstSeenAt: toDate(2000),
                generation: 1,
                id: initialIncident.id,
                lastSeenAt: toDate(3000),
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
                await submitSnapshot(
                    service,
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
                await submitSnapshot(
                    service,
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
                await submitSnapshot(
                    service,
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
                await submitSnapshot(
                    service,
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
                firstSeenAt: toDate(2000),
                generation: 2,
                lastSeenAt: toDate(7000),
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
                expect(differenceInMilliseconds(event.expiresAt, event.occurredAt)).toBe(
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
            await submitSnapshot(
                service,
                snapshot({ completedAtMs: 2000, monitorKey: "stream:a", run: 201 })
            );
            await submitSnapshot(
                service,
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
});
