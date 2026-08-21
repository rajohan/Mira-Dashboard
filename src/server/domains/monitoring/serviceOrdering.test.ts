import { describe, expect, test } from "bun:test";

import { incidents } from "../../database/schema/incidents.ts";
import { MonitoringRunConflictError } from "./service.ts";
import {
    allRowCounts,
    openFreshMigratedDatabase,
    problem,
    serviceFor,
    snapshot,
    submitSnapshot,
    submitSnapshotFailure,
} from "./testSupport/monitoringService.ts";

describe("monitoring service", () => {
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
            const accepted = await submitSnapshot(service, first);
            const afterAccepted = allRowCounts(database);
            expect(await submitSnapshot(service, first)).toMatchObject({
                duplicateRunId: true,
                realtimeEvents: 0,
                reportId: accepted.reportId,
                status: "duplicate",
            });
            expect(allRowCounts(database)).toEqual(afterAccepted);
            expect(wakeups).toBe(1);

            const conflict = await submitSnapshotFailure(service, {
                ...first,
                report: { ...first.report, bodyMarkdown: "# Corrected" },
            });
            expect(conflict).toBeInstanceOf(MonitoringRunConflictError);
            expect(conflict).toMatchObject({
                _tag: "MonitoringRunConflictError",
                runId: first.runId,
            });
            expect(allRowCounts(database)).toEqual(afterAccepted);
            expect(wakeups).toBe(1);

            expect(
                await submitSnapshot(
                    service,
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
                await submitSnapshot(
                    service,
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
            await submitSnapshot(service, snapshot({ completedAtMs: 2000, run: 710 }));

            const backupProblem = problem("backup");
            const staleResult = await submitSnapshot(
                service,
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
                await submitSnapshot(
                    service,
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
});
