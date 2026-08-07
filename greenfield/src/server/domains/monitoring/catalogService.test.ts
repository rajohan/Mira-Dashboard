import { afterEach, describe, expect, test } from "bun:test";

import { toDate } from "date-fns";
import { maxTime } from "date-fns/constants";
import { Effect } from "effect";

import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    MonitoringCatalogConflictError,
    MonitoringCatalogNotFoundError,
    MonitoringCatalogPreconditionError,
    MonitoringCatalogValidationError,
} from "./catalogErrors.ts";
import { createMonitoringCatalogService } from "./catalogService.ts";
import { createMonitoringRepository } from "./repository.ts";
import {
    oneDayMs,
    problem,
    serviceFor,
    snapshot,
    submitSnapshot,
    uuid,
} from "./testSupport/monitoringService.ts";

const catalogNowMs = 10_000;
type FreshMigratedDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

describe("monitoring catalog service", () => {
    let database: FreshMigratedDatabase | undefined;

    afterEach(() => {
        database?.sqlite.close(true);
        database = undefined;
    });

    async function openCatalog(
        overrides: {
            nowMs?: () => number;
            realtimeRetentionMs?: number;
            wakeEventPump?: () => void;
        } = {}
    ) {
        database = await openFreshMigratedDatabase();
        const repository = createMonitoringRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const service = createMonitoringCatalogService({
            nowMs: overrides.nowMs ?? (() => catalogNowMs),
            realtimeRetentionMs: overrides.realtimeRetentionMs ?? oneDayMs,
            repository,
            wakeEventPump: overrides.wakeEventPump,
        });
        return { database, repository, service };
    }

    test("rejects incompatible clock and realtime retention during construction", async () => {
        const failure = await captureFailure(() =>
            openCatalog({ nowMs: () => 1, realtimeRetentionMs: maxTime })
        );
        expect(failure).toBeInstanceOf(RangeError);
        expect((failure as RangeError).message).toContain(
            "Monitoring catalog mutation time leaves no room for realtime retention"
        );
    });

    test("lists and loads stable report, incident, and notification catalogs", async () => {
        const fixture = await openCatalog();
        const ingestion = serviceFor(fixture.database);
        await submitSnapshot(ingestion, snapshot({ completedAtMs: 1000, run: 1 }));
        await submitSnapshot(
            ingestion,
            snapshot({
                completedAtMs: 2000,
                problems: [problem("backup"), problem("filesystem")],
                run: 2,
            })
        );

        const firstReports = await Effect.runPromise(
            fixture.service.listReports({ limit: 1 })
        );
        expect(firstReports.reports).toHaveLength(1);
        expect(firstReports.nextCursor).toEqual({
            id: firstReports.reports[0]!.id,
            occurredAtMs: firstReports.reports[0]!.occurredAtMs,
        });
        const secondReports = await Effect.runPromise(
            fixture.service.listReports({
                cursor: firstReports.nextCursor,
                limit: 1,
            })
        );
        expect(secondReports.reports).toHaveLength(1);
        expect(secondReports.nextCursor).toBeUndefined();
        expect(secondReports.reports[0]!.occurredAtMs).toBeLessThan(
            firstReports.reports[0]!.occurredAtMs
        );

        const report = await Effect.runPromise(
            fixture.service.getReport({ id: firstReports.reports[0]!.id })
        );
        expect(report).toMatchObject({
            bodyMarkdown: "# Health at 2000",
            metadata: { complete: true },
        });

        const incidents = await Effect.runPromise(
            fixture.service.listIncidents({
                filters: { severities: ["error"] },
                limit: 10,
            })
        );
        expect(incidents.incidents).toHaveLength(1);
        expect(incidents.incidents[0]).toMatchObject({
            occurrenceCount: 1,
            severity: "error",
            state: "active",
        });
        const incidentDetail = await Effect.runPromise(
            fixture.service.getIncident({ id: incidents.incidents[0]!.id })
        );
        expect(incidentDetail).toMatchObject(incidents.incidents[0]!);
        expect(incidentDetail.details).toEqual({ hours: 26 });

        const notifications = await Effect.runPromise(
            fixture.service.listNotifications({
                filters: { readState: "unread" },
                limit: 10,
            })
        );
        expect(notifications.notifications).toHaveLength(2);
        expect(notifications.unreadCount).toBe(2);

        const missing = await Effect.runPromise(
            Effect.flip(fixture.service.getReport({ id: uuid(999_999) }))
        );
        expect(missing).toBeInstanceOf(MonitoringCatalogNotFoundError);
        expect(missing).toMatchObject({
            id: uuid(999_999),
            resource: "report",
        });
    });

    test("accepts exact producer replays and rejects immutable identity conflicts", async () => {
        let wakes = 0;
        const fixture = await openCatalog({
            wakeEventPump: () => {
                wakes += 1;
            },
        });
        const reportInput = {
            bodyMarkdown: "# Delivery",
            id: uuid(500),
            kind: "daily-summary",
            metadata: { nested: { a: 1, z: 2 } },
            occurredAtMs: 5000,
            source: "openclaw",
            sourceJobId: "daily-summary",
            status: "ok",
            title: "Daily summary",
        } as const;
        const createdReport = await Effect.runPromise(
            fixture.service.upsertReport(reportInput)
        );
        expect(createdReport.metadata).toEqual(reportInput.metadata);
        expect(
            await Effect.runPromise(
                fixture.service.upsertReport({
                    ...reportInput,
                    metadata: { nested: { z: 2, a: 1 } },
                })
            )
        ).toEqual(createdReport);
        const reportConflict = await Effect.runPromise(
            Effect.flip(
                fixture.service.upsertReport({
                    ...reportInput,
                    title: "Changed title",
                })
            )
        );
        expect(reportConflict).toBeInstanceOf(MonitoringCatalogConflictError);

        const notificationInput = {
            id: uuid(501),
            kind: "release",
            message: "Release available",
            occurredAtMs: 5100,
            severity: "info",
            title: "Dashboard update",
        } as const;
        const createdNotification = await Effect.runPromise(
            fixture.service.upsertNotification(notificationInput)
        );
        expect(
            await Effect.runPromise(fixture.service.upsertNotification(notificationInput))
        ).toEqual(createdNotification);
        const notificationConflict = await Effect.runPromise(
            Effect.flip(
                fixture.service.upsertNotification({
                    ...notificationInput,
                    severity: "warning",
                })
            )
        );
        expect(notificationConflict).toBeInstanceOf(MonitoringCatalogConflictError);

        expect(wakes).toBe(2);
        expect(
            fixture.database.sqlite
                .query<{ count: number }, []>(
                    "SELECT count(*) AS count FROM realtime_events"
                )
                .get()!.count
        ).toBe(2);
    });

    test("rejects producer timestamps outside realtime retention atomically", async () => {
        let wakes = 0;
        const fixture = await openCatalog({
            wakeEventPump: () => {
                wakes += 1;
            },
        });
        const reportId = uuid(600);
        const reportFailure = await Effect.runPromise(
            Effect.flip(
                fixture.service.upsertReport({
                    bodyMarkdown: "# Outside retention",
                    id: reportId,
                    kind: "health",
                    metadata: {},
                    occurredAtMs: maxTime,
                    source: "dashboard",
                    status: "ok",
                    title: "Outside retention",
                })
            )
        );
        expect(reportFailure).toBeInstanceOf(MonitoringCatalogValidationError);
        expect(reportFailure).toMatchObject({
            id: reportId,
            maximumOccurredAtMs: maxTime - oneDayMs,
            occurredAtMs: maxTime,
            resource: "report",
        });

        const notificationId = uuid(601);
        const notificationFailure = await Effect.runPromise(
            Effect.flip(
                fixture.service.upsertNotification({
                    id: notificationId,
                    kind: "health",
                    message: "Outside retention",
                    occurredAtMs: maxTime,
                    severity: "warning",
                    title: "Outside retention",
                })
            )
        );
        expect(notificationFailure).toBeInstanceOf(MonitoringCatalogValidationError);
        expect(notificationFailure).toMatchObject({
            id: notificationId,
            maximumOccurredAtMs: maxTime - oneDayMs,
            occurredAtMs: maxTime,
            resource: "notification",
        });

        expect(fixture.repository.findReport(reportId)).toBeUndefined();
        expect(fixture.repository.findNotification(notificationId)).toBeUndefined();
        expect(wakes).toBe(0);
        expect(
            fixture.database.sqlite
                .query<{ count: number }, []>(
                    "SELECT count(*) AS count FROM realtime_events"
                )
                .get()!.count
        ).toBe(0);
    });

    test("bounds bulk notification acknowledgement and deletion", async () => {
        let wakes = 0;
        const fixture = await openCatalog({
            wakeEventPump: () => {
                wakes += 1;
            },
        });
        await fixture.repository.withImmediateTransaction((unit) => {
            for (let index = 0; index < 101; index += 1) {
                unit.insertNotification({
                    channel: "dashboard",
                    id: uuid(1000 + index),
                    incidentGeneration: null,
                    incidentId: null,
                    kind: "bulk-test",
                    linkUrl: null,
                    message: `Notification ${index}`,
                    occurredAt: toDate(20_000 + index),
                    reportId: null,
                    severity: "info",
                    source: null,
                    title: "Bulk notification",
                });
            }
        });

        const firstMark = await Effect.runPromise(
            fixture.service.markAllNotificationsRead({ filters: {} })
        );
        expect(firstMark).toEqual({
            affectedCount: 100,
            completedAtMs: 20_100,
            remaining: true,
        });
        const secondMark = await Effect.runPromise(
            fixture.service.markAllNotificationsRead({ filters: {} })
        );
        expect(secondMark).toEqual({
            affectedCount: 1,
            completedAtMs: 20_000,
            remaining: false,
        });

        const alreadyRead = await Effect.runPromise(
            fixture.service.markNotificationRead({ id: uuid(1000) })
        );
        expect(alreadyRead.readAtMs).toBe(20_000);

        const firstClear = await Effect.runPromise(
            fixture.service.clearReadNotifications({ filters: {} })
        );
        expect(firstClear).toMatchObject({
            affectedCount: 100,
            remaining: true,
        });
        const secondClear = await Effect.runPromise(
            fixture.service.clearReadNotifications({ filters: {} })
        );
        expect(secondClear).toMatchObject({
            affectedCount: 1,
            remaining: false,
        });

        const listed = await Effect.runPromise(
            fixture.service.listNotifications({ limit: 10 })
        );
        expect(listed).toEqual({
            notifications: [],
            readCount: 0,
            unreadCount: 0,
        });
        expect(wakes).toBe(4);
        expect(
            fixture.database.sqlite
                .query<{ count: number }, []>(
                    "SELECT count(*) AS count FROM realtime_events"
                )
                .get()!.count
        ).toBe(202);
    });

    test("deletes reports without deleting immutable monitor-run history", async () => {
        const fixture = await openCatalog();
        const ingestion = serviceFor(fixture.database);
        const submission = await submitSnapshot(
            ingestion,
            snapshot({ completedAtMs: 1000, run: 1 })
        );
        expect(submission.reportId).not.toBeNull();

        const deleted = await Effect.runPromise(
            fixture.service.deleteReport({ id: submission.reportId! })
        );
        expect(deleted).toEqual({
            deletedAtMs: catalogNowMs,
            id: submission.reportId,
        });
        expect(
            fixture.database.sqlite
                .query<{ reportId: string | null }, []>(
                    "SELECT report_id AS reportId FROM monitor_runs"
                )
                .get()
        ).toEqual({ reportId: null });
        expect(
            await Effect.runPromise(
                Effect.flip(fixture.service.getReport({ id: submission.reportId! }))
            )
        ).toBeInstanceOf(MonitoringCatalogNotFoundError);
    });

    test("does not backdate report events or deletion when the clock regresses", async () => {
        const fixture = await openCatalog({ nowMs: () => 1000 });
        const reportInput = {
            bodyMarkdown: "# Clock-safe report",
            id: uuid(2000),
            kind: "health",
            metadata: {},
            occurredAtMs: 5000,
            source: "dashboard",
            status: "ok",
            title: "Clock-safe report",
        } as const;

        await Effect.runPromise(fixture.service.upsertReport(reportInput));
        const deleted = await Effect.runPromise(
            fixture.service.deleteReport({ id: reportInput.id })
        );
        expect(deleted.deletedAtMs).toBe(reportInput.occurredAtMs);

        const eventTimes = fixture.database.sqlite
            .query<{ occurredAtMs: number }, []>(
                "SELECT occurred_at AS occurredAtMs FROM realtime_events ORDER BY id"
            )
            .all()
            .map((row) => row.occurredAtMs);
        expect(eventTimes).toEqual([5000, 5000]);
    });

    test("does not backdate notification or linked-report deletion after reads", async () => {
        let nowMs = 10_000;
        const fixture = await openCatalog({ nowMs: () => nowMs });
        const reportId = uuid(2500);
        await Effect.runPromise(
            fixture.service.upsertReport({
                bodyMarkdown: "# Read-linked deletion",
                id: reportId,
                kind: "health",
                metadata: {},
                occurredAtMs: 5000,
                source: "dashboard",
                status: "ok",
                title: "Read-linked deletion",
            })
        );
        const notificationIds = {
            bulk: uuid(2502),
            linked: uuid(2503),
            single: uuid(2501),
        } as const;
        for (const [source, id, occurredAtMs] of [
            ["single", notificationIds.single, 7000],
            ["bulk", notificationIds.bulk, 8000],
            ["linked", notificationIds.linked, 6000],
        ] as const) {
            await Effect.runPromise(
                fixture.service.upsertNotification({
                    id,
                    kind: "clock-regression",
                    message: `${source} notification`,
                    occurredAtMs,
                    ...(source === "linked" ? { reportId } : {}),
                    severity: "info",
                    source,
                    title: "Clock regression",
                })
            );
        }
        expect(
            await Effect.runPromise(
                fixture.service.markAllNotificationsRead({ filters: {} })
            )
        ).toMatchObject({ affectedCount: 3, completedAtMs: 10_000 });

        nowMs = 1000;
        expect(
            await Effect.runPromise(
                fixture.service.deleteNotification({ id: notificationIds.single })
            )
        ).toMatchObject({ deletedAtMs: 10_000 });
        expect(
            await Effect.runPromise(
                fixture.service.clearReadNotifications({
                    filters: { sources: ["bulk"] },
                })
            )
        ).toMatchObject({ affectedCount: 1, completedAtMs: 10_000 });
        expect(
            await Effect.runPromise(fixture.service.deleteReport({ id: reportId }))
        ).toMatchObject({ deletedAtMs: 10_000 });

        const deletionEventTimes = fixture.database.sqlite
            .query<{ occurredAtMs: number }, []>(
                "SELECT occurred_at AS occurredAtMs FROM realtime_events ORDER BY id DESC LIMIT 4"
            )
            .all()
            .map((row) => row.occurredAtMs);
        expect(deletionEventTimes).toEqual([10_000, 10_000, 10_000, 10_000]);
    });

    test("rejects report deletion before an unbounded notification cascade", async () => {
        const fixture = await openCatalog();
        const reportInput = {
            bodyMarkdown: "# Bounded deletion",
            id: uuid(3000),
            kind: "health",
            metadata: {},
            occurredAtMs: 5000,
            source: "dashboard",
            status: "ok",
            title: "Bounded deletion",
        } as const;
        await Effect.runPromise(fixture.service.upsertReport(reportInput));
        await fixture.repository.withImmediateTransaction((unit) => {
            for (let index = 0; index < 101; index += 1) {
                unit.insertNotification({
                    channel: "dashboard",
                    id: uuid(4000 + index),
                    incidentGeneration: null,
                    incidentId: null,
                    kind: "report-link",
                    linkUrl: null,
                    message: `Notification ${index}`,
                    occurredAt: toDate(6000 + index),
                    reportId: reportInput.id,
                    severity: "info",
                    source: "dashboard",
                    title: "Linked notification",
                });
            }
        });
        const eventCountBefore = fixture.database.sqlite
            .query<{ count: number }, []>("SELECT count(*) AS count FROM realtime_events")
            .get()!.count;

        const failure = await Effect.runPromise(
            Effect.flip(fixture.service.deleteReport({ id: reportInput.id }))
        );
        expect(failure).toBeInstanceOf(MonitoringCatalogPreconditionError);
        expect(failure).toMatchObject({
            id: reportInput.id,
            linkedNotificationCount: 101,
            maximumLinkedNotifications: 100,
            resource: "report",
        });
        expect(fixture.repository.findReport(reportInput.id)).toBeDefined();
        expect(
            fixture.database.sqlite
                .query<{ count: number }, []>(
                    "SELECT count(*) AS count FROM realtime_events"
                )
                .get()!.count
        ).toBe(eventCountBefore);
    });
});
