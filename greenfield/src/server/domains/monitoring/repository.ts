import { and, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

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
export type RealtimeEventInsert = v.InferOutput<typeof realtimeEventInsertSchema>;
export type ReportInsert = v.InferOutput<typeof reportInsertSchema>;
export type ReportRecord = v.InferOutput<typeof reportSelectSchema>;

type TransactionCallback = Parameters<SQLiteBunDatabase["transaction"]>[0];
type MonitoringTransaction = Parameters<TransactionCallback>[0];
type SynchronousResult<T> = T extends Promise<unknown> ? never : T;

export interface MonitoringUnitOfWork {
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
    markIncidentNotificationRead(
        incidentId: string,
        incidentGeneration: number,
        readAt: Date
    ): NotificationRecord | undefined;
    updateIncident(id: string, input: IncidentUpdate): IncidentRecord;
}

export interface MonitoringRepository {
    withImmediateTransaction<T>(
        callback: (unit: MonitoringUnitOfWork) => SynchronousResult<T>
    ): T;
}

function requiredRow<T>(row: T | undefined, operation: string): T {
    if (row === undefined) {
        throw new Error(`Monitoring repository ${operation} returned no row`);
    }
    return row;
}

class DrizzleMonitoringUnitOfWork implements MonitoringUnitOfWork {
    readonly #transaction: MonitoringTransaction;

    constructor(transaction: MonitoringTransaction) {
        this.#transaction = transaction;
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
 * @returns Repository that owns immediate monitoring transactions and SQL.
 */
export function createMonitoringRepository(
    database: SQLiteBunDatabase
): MonitoringRepository {
    // SQLiteBunDatabase inherits a conditional async-driver signature even though the
    // concrete Bun session is synchronous. Preserve the public no-Promise callback type
    // while adapting that upstream declaration at this composition boundary.
    const runTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: MonitoringTransaction) => T,
        config: { behavior: "immediate" }
    ) => T;

    return {
        withImmediateTransaction<T>(
            callback: (unit: MonitoringUnitOfWork) => SynchronousResult<T>
        ): T {
            return runTransaction(
                (transaction): T =>
                    callback(new DrizzleMonitoringUnitOfWork(transaction)) as T,
                { behavior: "immediate" }
            );
        },
    };
}
