import { describe, expect, test } from "bun:test";

import { getTime, hoursToMilliseconds, toDate } from "date-fns";
import { Cause, Effect, Exit } from "effect";

import { incidents } from "../../database/schema/incidents.ts";
import { notifications } from "../../database/schema/notifications.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { createMonitoringRepository, type MonitoringRepository } from "./repository.ts";
import {
    createMonitoringService,
    MonitoringService,
    MonitoringSnapshotValidationError,
    monitoringServiceLayer,
} from "./service.ts";
import {
    allRowCounts,
    openFreshMigratedDatabase,
    problem,
    serviceFor,
    snapshot,
    submitSnapshot,
    submitSnapshotFailure,
    uuid,
} from "./testSupport/monitoringService.ts";

describe("monitoring service", () => {
    test("rolls back every domain and outbox write when a late insert fails", async () => {
        const database = await openFreshMigratedDatabase();
        const service = serviceFor(database);

        try {
            await submitSnapshot(service, snapshot({ completedAtMs: 2000, run: 401 }));
            const before = allRowCounts(database);
            const existingNotificationId = database.orm
                .select({ id: notifications.id })
                .from(notifications)
                .get()!.id;
            // IDs are consumed as report, incident, then notification; the existing
            // notification ID therefore forces a late insert failure.
            const generatedIds = [uuid(50_000), uuid(50_001), existingNotificationId];
            const failingService = serviceFor(database, {
                generateId: () => generatedIds.shift()!,
            });

            const failingSnapshot = snapshot({
                completedAtMs: 3000,
                problems: [problem("backup")],
                run: 402,
            });
            const submission = submitSnapshot(failingService, failingSnapshot);
            expect(submission).rejects.toThrow();
            expect(allRowCounts(database)).toEqual(before);
            expect(database.orm.select().from(incidents).get()).toMatchObject({
                occurrenceCount: 1,
                state: "active",
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects malformed snapshots before entering the repository", async () => {
        let repositoryEntries = 0;
        const repository: MonitoringRepository = {
            withImmediateTransaction() {
                repositoryEntries += 1;
                throw new Error("repository should not be entered");
            },
        };
        const service = createMonitoringService({ repository });

        const failure = await submitSnapshotFailure(service, {
            ...snapshot({ completedAtMs: 2000, run: 501 }),
            problems: [problem("filesystem"), problem("filesystem")],
        });
        expect(failure).toBeInstanceOf(MonitoringSnapshotValidationError);
        expect(failure._tag).toBe("MonitoringSnapshotValidationError");
        expect(failure.message).toContain("duplicate problem identities");
        expect(repositoryEntries).toBe(0);
    });

    test("rejects a future watermark before entering the repository", async () => {
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

        const failure = await submitSnapshotFailure(
            service,
            snapshot({ completedAtMs: 310_001, run: 502 })
        );
        expect(failure).toBeInstanceOf(MonitoringSnapshotValidationError);
        expect(failure.message).toContain(
            "cannot be more than 300000 milliseconds in the future"
        );
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
            const result = await submitSnapshot(
                service,
                snapshot({ completedAtMs: 2000, run: 601 })
            );
            expect(result.status).toBe("accepted");
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

    test("rejects a realtime expiry outside the Date range before repository work", async () => {
        let repositoryEntries = 0;
        const repository: MonitoringRepository = {
            withImmediateTransaction() {
                repositoryEntries += 1;
                throw new Error("repository should not be entered");
            },
        };
        const service = createMonitoringService({
            nowMs: () => getTime(toDate(8_640_000_000_000_000)),
            realtimeRetentionMs: 1,
            repository,
        });

        const exit = await Effect.runPromiseExit(
            service.submitCompleteSnapshot(snapshot({ completedAtMs: 2000, run: 602 }))
        );

        expect(Exit.isFailure(exit)).toBeTrue();
        if (Exit.isFailure(exit)) {
            const die = exit.cause.reasons.find(Cause.isDieReason);
            expect(die?.defect).toBeInstanceOf(RangeError);
            expect(String(die?.defect)).toContain(
                "Monitoring realtime expiry must be valid Date milliseconds"
            );
        }
        expect(repositoryEntries).toBe(0);
    });

    test("keeps unknown repository failures in the defect channel", async () => {
        const repositoryFailure = new Error("repository unavailable");
        const repository: MonitoringRepository = {
            withImmediateTransaction() {
                throw repositoryFailure;
            },
        };
        const service = createMonitoringService({
            nowMs: () => 10_000,
            repository,
        });

        const exit = await Effect.runPromiseExit(
            service.submitCompleteSnapshot(snapshot({ completedAtMs: 2000, run: 701 }))
        );

        expect(Exit.isFailure(exit)).toBeTrue();
        if (Exit.isFailure(exit)) {
            expect(Cause.hasDies(exit.cause)).toBeTrue();
            const die = exit.cause.reasons.find(Cause.isDieReason);
            expect(die?.defect).toBe(repositoryFailure);
        }
    });

    test("provides the monitoring application boundary through its Effect layer", async () => {
        const database = await openFreshMigratedDatabase();
        const layer = monitoringServiceLayer({
            generateId: () => uuid(70_000),
            nowMs: () => 10_000,
            realtimeRetentionMs: hoursToMilliseconds(24),
            repository: createMonitoringRepository(
                database.orm,
                testImmediateDatabaseWriteAdmission
            ),
        });

        try {
            const program = Effect.gen(function* () {
                const service = yield* MonitoringService;
                return yield* service.submitCompleteSnapshot(
                    snapshot({ completedAtMs: 2000, run: 702 })
                );
            });
            const result = await Effect.runPromise(Effect.provide(program, layer));

            expect(result.status).toBe("accepted");
            expect(allRowCounts(database)).toMatchObject({
                incidents: 1,
                monitorRuns: 1,
                reports: 1,
            });
        } finally {
            database.sqlite.close(true);
        }
    });
});
