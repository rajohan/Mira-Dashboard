import { toDate } from "date-fns";
import {
    and,
    count,
    desc,
    eq,
    inArray,
    isNotNull,
    isNull,
    lt,
    or,
    type SQL,
} from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import {
    incidentPageMaximum,
    type ListIncidentsInput,
} from "../../../contracts/incidents.ts";
import type {
    BulkNotificationInput,
    ListNotificationsInput,
} from "../../../contracts/notifications.ts";
import { notificationPageMaximum } from "../../../contracts/notifications.ts";
import { reportPageMaximum, type ListReportsInput } from "../../../contracts/reports.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { incidentObservations } from "../../database/schema/incidentObservations.ts";
import { incidents } from "../../database/schema/incidents.ts";
import { monitorRuns } from "../../database/schema/monitorRuns.ts";
import { notifications } from "../../database/schema/notifications.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { reports } from "../../database/schema/reports.ts";
import {
    incidentObservationInsertSchema,
    incidentObservationSelectSchema,
} from "../../database/validation/incidentObservations.ts";
import {
    incidentInsertSchema,
    incidentSelectSchema,
    incidentUpdateSchema,
} from "../../database/validation/incidents.ts";
import {
    monitorRunInsertSchema,
    monitorRunSelectSchema,
} from "../../database/validation/monitorRuns.ts";
import {
    notificationInsertSchema,
    notificationSelectSchema,
    notificationUpdateSchema,
} from "../../database/validation/notifications.ts";
import {
    realtimeEventInsertSchema,
    realtimeEventSelectSchema,
} from "../../database/validation/realtimeEvents.ts";
import {
    reportInsertSchema,
    reportSelectSchema,
} from "../../database/validation/reports.ts";

export type IncidentInsert = v.InferOutput<typeof incidentInsertSchema>;
export type IncidentObservationInsert = v.InferOutput<
    typeof incidentObservationInsertSchema
>;
export type IncidentRecord = v.InferOutput<typeof incidentSelectSchema>;
export type IncidentUpdate = v.InferOutput<typeof incidentUpdateSchema>;
export type MonitorRunInsert = v.InferOutput<typeof monitorRunInsertSchema>;
export type MonitorRunRecord = v.InferOutput<typeof monitorRunSelectSchema>;
export type NotificationInsert = v.InferOutput<typeof notificationInsertSchema>;
export type NotificationRecord = v.InferOutput<typeof notificationSelectSchema>;
export type NotificationUpdate = v.InferOutput<typeof notificationUpdateSchema>;
export type RealtimeEventInsert = v.InferOutput<typeof realtimeEventInsertSchema>;
export type ReportInsert = v.InferOutput<typeof reportInsertSchema>;
export type ReportRecord = v.InferOutput<typeof reportSelectSchema>;

type TransactionCallback = Parameters<SQLiteBunDatabase["transaction"]>[0];
type MonitoringTransaction = Parameters<TransactionCallback>[0];
type MonitoringPersistenceDatabase = MonitoringTransaction | SQLiteBunDatabase;
type SynchronousResult<T> = T extends Promise<unknown> ? never : T;

export interface MonitoringReader {
    countReadNotifications(): number;
    countUnreadNotifications(): number;
    findIncident(id: string): IncidentRecord | undefined;
    findIncidentNotification(
        incidentId: string,
        incidentGeneration: number
    ): NotificationRecord | undefined;
    findNotification(id: string): NotificationRecord | undefined;
    findReport(id: string): ReportRecord | undefined;
    listIncidents(input: ListIncidentsInput): IncidentRecord[];
    listNotifications(input: ListNotificationsInput): NotificationRecord[];
    listReportNotifications(reportId: string, limit: number): NotificationRecord[];
    listReports(input: ListReportsInput): ReportRecord[];
}

export interface MonitoringUnitOfWork extends MonitoringReader {
    deleteNotification(id: string): NotificationRecord | undefined;
    deleteNotifications(ids: readonly string[]): NotificationRecord[];
    deleteReport(id: string): ReportRecord | undefined;
    findLatestCompleteRun(monitorKey: string): MonitorRunRecord | undefined;
    findLifecycleIncidents(
        monitorKey: string,
        fingerprints: readonly string[]
    ): IncidentRecord[];
    findRun(runId: string): MonitorRunRecord | undefined;
    insertIncident(input: IncidentInsert): IncidentRecord;
    insertMonitorRun(input: MonitorRunInsert): MonitorRunRecord;
    insertNotification(input: NotificationInsert): NotificationRecord;
    insertObservation(input: IncidentObservationInsert): number;
    insertRealtimeEvent(input: RealtimeEventInsert): number;
    insertReport(input: ReportInsert): ReportRecord;
    listNotificationMutationCandidates(
        filters: BulkNotificationInput["filters"],
        readState: "read" | "unread",
        limit: number
    ): NotificationRecord[];
    markIncidentNotificationRead(
        incidentId: string,
        incidentGeneration: number,
        readAt: Date
    ): NotificationRecord | undefined;
    markNotificationsRead(ids: readonly string[], readAt: Date): NotificationRecord[];
    updateIncident(id: string, input: IncidentUpdate): IncidentRecord;
}

export interface MonitoringRepository extends MonitoringReader {
    withImmediateTransaction<T>(
        callback: (unit: MonitoringUnitOfWork) => SynchronousResult<T>
    ): Promise<T>;
    withReadTransaction<T>(
        callback: (reader: MonitoringReader) => SynchronousResult<T>
    ): T;
}

function requiredRow<T>(row: T | undefined, operation: string): T {
    if (row === undefined) {
        throw new Error(`Monitoring repository ${operation} returned no row`);
    }
    return row;
}

function assertPageLimit(limit: number, maximum: number, operation: string): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
        throw new RangeError(`Monitoring repository ${operation} limit is invalid`);
    }
}

function reportCursorBoundary(input: ListReportsInput): SQL | undefined {
    if (input.cursor === undefined) return undefined;
    const occurredAt = toDate(input.cursor.occurredAtMs);
    return or(
        lt(reports.occurredAt, occurredAt),
        and(eq(reports.occurredAt, occurredAt), lt(reports.id, input.cursor.id))
    );
}

function reportFilterConditions(input: ListReportsInput): SQL[] {
    const filters = input.filters;
    if (filters === undefined) return [];
    return [
        ...(filters.kinds === undefined
            ? []
            : [inArray(reports.kind, [...filters.kinds])]),
        ...(filters.sourceJobIds === undefined
            ? []
            : [inArray(reports.sourceJobId, [...filters.sourceJobIds])]),
        ...(filters.sources === undefined
            ? []
            : [inArray(reports.source, [...filters.sources])]),
        ...(filters.statuses === undefined
            ? []
            : [inArray(reports.status, [...filters.statuses])]),
    ];
}

function incidentCursorBoundary(input: ListIncidentsInput): SQL | undefined {
    if (input.cursor === undefined) return undefined;
    const lastSeenAt = toDate(input.cursor.lastSeenAtMs);
    return or(
        lt(incidents.lastSeenAt, lastSeenAt),
        and(eq(incidents.lastSeenAt, lastSeenAt), lt(incidents.id, input.cursor.id))
    );
}

function incidentFilterConditions(input: ListIncidentsInput): SQL[] {
    const filters = input.filters;
    if (filters === undefined) return [];
    return [
        ...(filters.kinds === undefined
            ? []
            : [inArray(incidents.kind, [...filters.kinds])]),
        ...(filters.monitorKeys === undefined
            ? []
            : [inArray(incidents.monitorKey, [...filters.monitorKeys])]),
        ...(filters.severities === undefined
            ? []
            : [inArray(incidents.severity, [...filters.severities])]),
        ...(filters.states === undefined
            ? []
            : [inArray(incidents.state, [...filters.states])]),
    ];
}

function notificationCursorBoundary(input: ListNotificationsInput): SQL | undefined {
    if (input.cursor === undefined) return undefined;
    const occurredAt = toDate(input.cursor.occurredAtMs);
    return or(
        lt(notifications.occurredAt, occurredAt),
        and(
            eq(notifications.occurredAt, occurredAt),
            lt(notifications.id, input.cursor.id)
        )
    );
}

function notificationFilterConditions(
    filters: ListNotificationsInput["filters"] | BulkNotificationInput["filters"],
    readState?: "read" | "unread"
): SQL[] {
    if (filters === undefined) {
        return readState === undefined
            ? []
            : [
                  readState === "read"
                      ? isNotNull(notifications.readAt)
                      : isNull(notifications.readAt),
              ];
    }
    const requestedReadState =
        readState ??
        ("readState" in filters && filters.readState !== "all"
            ? filters.readState
            : undefined);
    return [
        ...(filters.incidentId === undefined
            ? []
            : [eq(notifications.incidentId, filters.incidentId)]),
        ...(filters.kinds === undefined
            ? []
            : [inArray(notifications.kind, [...filters.kinds])]),
        ...(filters.severities === undefined
            ? []
            : [inArray(notifications.severity, [...filters.severities])]),
        ...(filters.sources === undefined
            ? []
            : [inArray(notifications.source, [...filters.sources])]),
        ...(requestedReadState === undefined
            ? []
            : [
                  requestedReadState === "read"
                      ? isNotNull(notifications.readAt)
                      : isNull(notifications.readAt),
              ]),
    ];
}

class DrizzleMonitoringReader implements MonitoringReader {
    protected readonly database: MonitoringPersistenceDatabase;

    public constructor(database: MonitoringPersistenceDatabase) {
        this.database = database;
    }

    public countReadNotifications(): number {
        const row = this.database
            .select({ value: count() })
            .from(notifications)
            .where(isNotNull(notifications.readAt))
            .get();
        const value = requiredRow(row, "read notification count").value;
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error("Monitoring repository read count is invalid");
        }
        return value;
    }

    public countUnreadNotifications(): number {
        const row = this.database
            .select({ value: count() })
            .from(notifications)
            .where(isNull(notifications.readAt))
            .get();
        const value = requiredRow(row, "unread notification count").value;
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error("Monitoring repository unread count is invalid");
        }
        return value;
    }

    public findIncident(id: string): IncidentRecord | undefined {
        const row = this.database
            .select()
            .from(incidents)
            .where(eq(incidents.id, id))
            .get();
        return row === undefined ? undefined : v.parse(incidentSelectSchema, row);
    }

    public findIncidentNotification(
        incidentId: string,
        incidentGeneration: number
    ): NotificationRecord | undefined {
        const row = this.database
            .select()
            .from(notifications)
            .where(
                and(
                    eq(notifications.incidentId, incidentId),
                    eq(notifications.incidentGeneration, incidentGeneration)
                )
            )
            .get();
        return row === undefined ? undefined : v.parse(notificationSelectSchema, row);
    }

    public findNotification(id: string): NotificationRecord | undefined {
        const row = this.database
            .select()
            .from(notifications)
            .where(eq(notifications.id, id))
            .get();
        return row === undefined ? undefined : v.parse(notificationSelectSchema, row);
    }

    public findReport(id: string): ReportRecord | undefined {
        const row = this.database.select().from(reports).where(eq(reports.id, id)).get();
        return row === undefined ? undefined : v.parse(reportSelectSchema, row);
    }

    public listIncidents(input: ListIncidentsInput): IncidentRecord[] {
        assertPageLimit(input.limit, incidentPageMaximum, "incident page");
        return this.database
            .select()
            .from(incidents)
            .where(and(incidentCursorBoundary(input), ...incidentFilterConditions(input)))
            .orderBy(desc(incidents.lastSeenAt), desc(incidents.id))
            .limit(input.limit + 1)
            .all()
            .map((row) => v.parse(incidentSelectSchema, row));
    }

    public listNotifications(input: ListNotificationsInput): NotificationRecord[] {
        assertPageLimit(input.limit, notificationPageMaximum, "notification page");
        return this.database
            .select()
            .from(notifications)
            .where(
                and(
                    notificationCursorBoundary(input),
                    ...notificationFilterConditions(input.filters)
                )
            )
            .orderBy(desc(notifications.occurredAt), desc(notifications.id))
            .limit(input.limit + 1)
            .all()
            .map((row) => v.parse(notificationSelectSchema, row));
    }

    public listReportNotifications(
        reportId: string,
        limit: number
    ): NotificationRecord[] {
        assertPageLimit(limit, notificationPageMaximum + 1, "report notification page");
        return this.database
            .select()
            .from(notifications)
            .where(eq(notifications.reportId, reportId))
            .orderBy(desc(notifications.occurredAt), desc(notifications.id))
            .limit(limit)
            .all()
            .map((row) => v.parse(notificationSelectSchema, row));
    }

    public listReports(input: ListReportsInput): ReportRecord[] {
        assertPageLimit(input.limit, reportPageMaximum, "report page");
        return this.database
            .select()
            .from(reports)
            .where(and(reportCursorBoundary(input), ...reportFilterConditions(input)))
            .orderBy(desc(reports.occurredAt), desc(reports.id))
            .limit(input.limit + 1)
            .all()
            .map((row) => v.parse(reportSelectSchema, row));
    }
}

class DrizzleMonitoringUnitOfWork
    extends DrizzleMonitoringReader
    implements MonitoringUnitOfWork
{
    readonly #transaction: MonitoringTransaction;

    constructor(transaction: MonitoringTransaction) {
        super(transaction);
        this.#transaction = transaction;
    }

    deleteNotification(id: string): NotificationRecord | undefined {
        const row = this.#transaction
            .delete(notifications)
            .where(eq(notifications.id, id))
            .returning()
            .get();
        return row === undefined ? undefined : v.parse(notificationSelectSchema, row);
    }

    deleteNotifications(ids: readonly string[]): NotificationRecord[] {
        if (ids.length === 0) return [];
        assertPageLimit(ids.length, notificationPageMaximum, "notification delete");
        return this.#transaction
            .delete(notifications)
            .where(inArray(notifications.id, [...ids]))
            .returning()
            .all()
            .map((row) => v.parse(notificationSelectSchema, row));
    }

    deleteReport(id: string): ReportRecord | undefined {
        const row = this.#transaction
            .delete(reports)
            .where(eq(reports.id, id))
            .returning()
            .get();
        return row === undefined ? undefined : v.parse(reportSelectSchema, row);
    }

    findLatestCompleteRun(monitorKey: string): MonitorRunRecord | undefined {
        const row = this.#transaction
            .select()
            .from(monitorRuns)
            .where(
                and(
                    eq(monitorRuns.monitorKey, monitorKey),
                    eq(monitorRuns.completeSnapshot, true),
                    eq(monitorRuns.state, "succeeded"),
                    isNotNull(monitorRuns.completedAt)
                )
            )
            .orderBy(desc(monitorRuns.completedAt), desc(monitorRuns.id))
            .limit(1)
            .get();
        return row === undefined ? undefined : v.parse(monitorRunSelectSchema, row);
    }

    findLifecycleIncidents(
        monitorKey: string,
        fingerprints: readonly string[]
    ): IncidentRecord[] {
        const lifecycleFilter =
            fingerprints.length === 0
                ? eq(incidents.state, "active")
                : or(
                      eq(incidents.state, "active"),
                      inArray(incidents.fingerprint, [...fingerprints])
                  );
        const rows = this.#transaction
            .select()
            .from(incidents)
            .where(and(eq(incidents.monitorKey, monitorKey), lifecycleFilter))
            .all();
        return rows.map((row) => v.parse(incidentSelectSchema, row));
    }

    findRun(runId: string): MonitorRunRecord | undefined {
        const row = this.#transaction
            .select()
            .from(monitorRuns)
            .where(eq(monitorRuns.id, runId))
            .get();
        return row === undefined ? undefined : v.parse(monitorRunSelectSchema, row);
    }

    insertIncident(input: IncidentInsert): IncidentRecord {
        const row = this.#transaction
            .insert(incidents)
            .values(v.parse(incidentInsertSchema, input))
            .returning()
            .get();
        return v.parse(incidentSelectSchema, requiredRow(row, "incident insert"));
    }

    insertMonitorRun(input: MonitorRunInsert): MonitorRunRecord {
        const row = this.#transaction
            .insert(monitorRuns)
            .values(v.parse(monitorRunInsertSchema, input))
            .returning()
            .get();
        return v.parse(monitorRunSelectSchema, requiredRow(row, "monitor run insert"));
    }

    insertNotification(input: NotificationInsert): NotificationRecord {
        const row = this.#transaction
            .insert(notifications)
            .values(v.parse(notificationInsertSchema, input))
            .returning()
            .get();
        return v.parse(notificationSelectSchema, requiredRow(row, "notification insert"));
    }

    insertObservation(input: IncidentObservationInsert): number {
        const row = this.#transaction
            .insert(incidentObservations)
            .values(v.parse(incidentObservationInsertSchema, input))
            .returning()
            .get();
        return v.parse(
            incidentObservationSelectSchema,
            requiredRow(row, "incident observation insert")
        ).id;
    }

    insertRealtimeEvent(input: RealtimeEventInsert): number {
        const row = this.#transaction
            .insert(realtimeEvents)
            .values(v.parse(realtimeEventInsertSchema, input))
            .returning()
            .get();
        return v.parse(
            realtimeEventSelectSchema,
            requiredRow(row, "realtime event insert")
        ).id;
    }

    insertReport(input: ReportInsert): ReportRecord {
        const row = this.#transaction
            .insert(reports)
            .values(v.parse(reportInsertSchema, input))
            .returning()
            .get();
        return v.parse(reportSelectSchema, requiredRow(row, "report insert"));
    }

    listNotificationMutationCandidates(
        filters: BulkNotificationInput["filters"],
        readState: "read" | "unread",
        limit: number
    ): NotificationRecord[] {
        assertPageLimit(limit, notificationPageMaximum + 1, "notification mutation page");
        return this.#transaction
            .select()
            .from(notifications)
            .where(and(...notificationFilterConditions(filters, readState)))
            .orderBy(desc(notifications.occurredAt), desc(notifications.id))
            .limit(limit)
            .all()
            .map((row) => v.parse(notificationSelectSchema, row));
    }

    markIncidentNotificationRead(
        incidentId: string,
        incidentGeneration: number,
        readAt: Date
    ): NotificationRecord | undefined {
        const update = v.parse(notificationUpdateSchema, { readAt });
        const row = this.#transaction
            .update(notifications)
            .set(update)
            .where(
                and(
                    eq(notifications.incidentId, incidentId),
                    eq(notifications.incidentGeneration, incidentGeneration),
                    isNull(notifications.readAt)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : v.parse(notificationSelectSchema, row);
    }

    markNotificationsRead(ids: readonly string[], readAt: Date): NotificationRecord[] {
        if (ids.length === 0) return [];
        assertPageLimit(ids.length, notificationPageMaximum, "notification update");
        const update = v.parse(notificationUpdateSchema, { readAt });
        return this.#transaction
            .update(notifications)
            .set(update)
            .where(and(inArray(notifications.id, [...ids]), isNull(notifications.readAt)))
            .returning()
            .all()
            .map((row) => v.parse(notificationSelectSchema, row));
    }

    updateIncident(id: string, input: IncidentUpdate): IncidentRecord {
        const row = this.#transaction
            .update(incidents)
            .set(v.parse(incidentUpdateSchema, input))
            .where(eq(incidents.id, id))
            .returning()
            .get();
        return v.parse(incidentSelectSchema, requiredRow(row, "incident update"));
    }
}

/**
 * Creates the SQLite-backed monitoring repository at the composition boundary.
 * @param database Typed Drizzle client backed by one Bun SQLite connection.
 * @param writeAdmission Process-owned bounded immediate-write admission.
 * @returns Repository that owns admitted async monitoring writes and SQL.
 */
export function createMonitoringRepository(
    database: SQLiteBunDatabase,
    writeAdmission: ImmediateDatabaseWriteAdmission
): MonitoringRepository {
    // SQLiteBunDatabase inherits a conditional async-driver signature even though the
    // concrete Bun session is synchronous. Preserve the public no-Promise callback type
    // while adapting that upstream declaration at this composition boundary.
    const runTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: MonitoringTransaction) => T,
        config: { behavior: "deferred" | "immediate" }
    ) => T;
    const withReadTransaction = <T>(
        callback: (reader: MonitoringReader) => SynchronousResult<T>
    ): T =>
        runTransaction(
            (transaction) => callback(new DrizzleMonitoringReader(transaction)),
            { behavior: "deferred" }
        );

    return Object.freeze({
        countReadNotifications: () =>
            withReadTransaction((reader) => reader.countReadNotifications()),
        countUnreadNotifications: () =>
            withReadTransaction((reader) => reader.countUnreadNotifications()),
        findIncident: (id: string) =>
            withReadTransaction((reader) => reader.findIncident(id)),
        findIncidentNotification: (incidentId: string, incidentGeneration: number) =>
            withReadTransaction((reader) =>
                reader.findIncidentNotification(incidentId, incidentGeneration)
            ),
        findNotification: (id: string) =>
            withReadTransaction((reader) => reader.findNotification(id)),
        findReport: (id: string) =>
            withReadTransaction((reader) => reader.findReport(id)),
        listIncidents: (input: ListIncidentsInput) =>
            withReadTransaction((reader) => reader.listIncidents(input)),
        listNotifications: (input: ListNotificationsInput) =>
            withReadTransaction((reader) => reader.listNotifications(input)),
        listReportNotifications: (reportId: string, limit: number) =>
            withReadTransaction((reader) =>
                reader.listReportNotifications(reportId, limit)
            ),
        listReports: (input: ListReportsInput) =>
            withReadTransaction((reader) => reader.listReports(input)),
        withImmediateTransaction<T>(
            callback: (unit: MonitoringUnitOfWork) => SynchronousResult<T>
        ): Promise<T> {
            return writeAdmission.run((markTransactionStarted) =>
                runTransaction(
                    (transaction): T => {
                        markTransactionStarted();
                        return callback(new DrizzleMonitoringUnitOfWork(transaction));
                    },
                    { behavior: "immediate" }
                )
            );
        },
        withReadTransaction,
    });
}
