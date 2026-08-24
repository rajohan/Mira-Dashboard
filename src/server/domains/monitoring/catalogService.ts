import { addMilliseconds, getTime, max as maximumDate, toDate } from "date-fns";
import { maxTime } from "date-fns/constants";
import { Context, Data, Effect, Layer } from "effect";
import * as v from "valibot";

import {
    type GetIncidentInput,
    type ListIncidentsInput,
    type ListIncidentsResult,
    listIncidentsResultSchema,
} from "../../../contracts/incidents.ts";
import type {
    IncidentRecord,
    NotificationRecord,
    ReportDetail,
} from "../../../contracts/monitoring.ts";
import {
    type BulkNotificationInput,
    type BulkNotificationResult,
    type ListNotificationsInput,
    type ListNotificationsResult,
    type NotificationIdentityInput,
    type UpsertNotificationInput,
    bulkNotificationResultSchema,
    deleteNotificationResultSchema,
    listNotificationsResultSchema,
    notificationPageMaximum,
    type DeleteNotificationResult,
} from "../../../contracts/notifications.ts";
import {
    type DeleteReportInput,
    type DeleteReportResult,
    type GetReportInput,
    type ListReportsInput,
    type ListReportsResult,
    type UpsertReportInput,
    deleteReportResultSchema,
    listReportsResultSchema,
} from "../../../contracts/reports.ts";
import { timestampMillisecondsSchema } from "../../../shared/dateTime.ts";
import {
    parseSchemaWithRangeError,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import {
    isDatabaseRuntimeWriteUnavailableError,
    type DatabaseRuntimeWriteUnavailableError,
} from "../../database/runtime/databaseErrors.ts";
import { defaultRealtimeRetentionMilliseconds } from "../realtime/retention.ts";
import {
    MonitoringCatalogConflictError,
    MonitoringCatalogNotFoundError,
    MonitoringCatalogPreconditionError,
    MonitoringCatalogValidationError,
} from "./catalogErrors.ts";
import {
    toIncidentRecord,
    toIncidentSummary,
    toNotificationRecord,
    toReportDetail,
    toReportSummary,
} from "./catalogRecords.ts";
import {
    appendMonitoringRealtimeEvent,
    monitoringRealtimeTopics,
} from "./realtimeEvents.ts";
import type {
    MonitoringRepository,
    MonitoringUnitOfWork,
    NotificationRecord as NotificationPersistenceRecord,
    ReportRecord as ReportPersistenceRecord,
} from "./repository.ts";
import {
    parseMonitoringJsonObject,
    serializeMonitoringJsonObject,
} from "./serialization.ts";

const catalogClockSchema = timestampMillisecondsSchema(
    "Monitoring catalog clock must return valid Date milliseconds"
);
const catalogRealtimeExpirySchema = timestampMillisecondsSchema(
    "Monitoring catalog realtime expiry must be valid Date milliseconds"
);
const catalogRealtimeRetentionSchema = v.pipe(
    positiveSafeIntegerSchema(
        "Monitoring catalog realtime retention must be a positive integer"
    ),
    v.maxValue(maxTime, "Monitoring catalog realtime retention exceeds the Date range")
);

export type MonitoringCatalogOperationError =
    | DatabaseRuntimeWriteUnavailableError
    | MonitoringCatalogConflictError
    | MonitoringCatalogNotFoundError
    | MonitoringCatalogPreconditionError
    | MonitoringCatalogValidationError;

interface MonitoringCatalogServiceShape {
    readonly clearReadNotifications: (
        input: BulkNotificationInput
    ) => Effect.Effect<BulkNotificationResult, MonitoringCatalogOperationError>;
    readonly deleteNotification: (
        input: NotificationIdentityInput
    ) => Effect.Effect<DeleteNotificationResult, MonitoringCatalogOperationError>;
    readonly deleteReport: (
        input: DeleteReportInput
    ) => Effect.Effect<DeleteReportResult, MonitoringCatalogOperationError>;
    readonly getIncident: (
        input: GetIncidentInput
    ) => Effect.Effect<IncidentRecord, MonitoringCatalogNotFoundError>;
    readonly getReport: (
        input: GetReportInput
    ) => Effect.Effect<ReportDetail, MonitoringCatalogNotFoundError>;
    readonly listIncidents: (
        input: ListIncidentsInput
    ) => Effect.Effect<ListIncidentsResult>;
    readonly listNotifications: (
        input: ListNotificationsInput
    ) => Effect.Effect<ListNotificationsResult>;
    readonly listReports: (input: ListReportsInput) => Effect.Effect<ListReportsResult>;
    readonly markAllNotificationsRead: (
        input: BulkNotificationInput
    ) => Effect.Effect<BulkNotificationResult, MonitoringCatalogOperationError>;
    readonly markNotificationRead: (
        input: NotificationIdentityInput
    ) => Effect.Effect<NotificationRecord, MonitoringCatalogOperationError>;
    readonly upsertNotification: (
        input: UpsertNotificationInput
    ) => Effect.Effect<NotificationRecord, MonitoringCatalogOperationError>;
    readonly upsertReport: (
        input: UpsertReportInput
    ) => Effect.Effect<ReportDetail, MonitoringCatalogOperationError>;
}

/** Effect service for report, incident, and Dashboard-notification catalogs. */
export class MonitoringCatalogService extends Context.Service<
    MonitoringCatalogService,
    MonitoringCatalogServiceShape
>()("mira-dashboard/server/domains/monitoring/MonitoringCatalogService") {}

export interface MonitoringCatalogServiceDependencies {
    readonly nowMs?: () => number;
    readonly realtimeRetentionMs?: number;
    readonly repository: MonitoringRepository;
    readonly wakeEventPump?: () => Promise<void> | void;
}

interface CatalogMutationResult<T> {
    readonly changed: boolean;
    readonly value: T;
}

interface CatalogMutationTiming {
    readonly expiresAt: Date;
    readonly occurredAt: Date;
}

class MonitoringCatalogUnexpectedError extends Data.TaggedError(
    "MonitoringCatalogUnexpectedError"
)<{ readonly cause: unknown }> {}

function isCatalogOperationError(
    error: unknown
): error is MonitoringCatalogOperationError {
    return (
        error instanceof MonitoringCatalogConflictError ||
        error instanceof MonitoringCatalogNotFoundError ||
        error instanceof MonitoringCatalogPreconditionError ||
        error instanceof MonitoringCatalogValidationError ||
        isDatabaseRuntimeWriteUnavailableError(error)
    );
}

function readEffect<T>(
    operation: () => T
): Effect.Effect<T, MonitoringCatalogNotFoundError> {
    return Effect.try({
        catch: (error) =>
            error instanceof MonitoringCatalogNotFoundError
                ? error
                : new MonitoringCatalogUnexpectedError({ cause: error }),
        try: operation,
    }).pipe(
        Effect.catchTag("MonitoringCatalogUnexpectedError", (error) =>
            Effect.die(error.cause)
        )
    );
}

function listEffect<T>(operation: () => T): Effect.Effect<T> {
    return Effect.try({
        catch: (error) => new MonitoringCatalogUnexpectedError({ cause: error }),
        try: operation,
    }).pipe(
        Effect.catchTag("MonitoringCatalogUnexpectedError", (error) =>
            Effect.die(error.cause)
        )
    );
}

function mutationEffect<T>(
    operation: () => Promise<T>
): Effect.Effect<T, MonitoringCatalogOperationError> {
    return Effect.tryPromise({
        catch: (error) =>
            isCatalogOperationError(error)
                ? error
                : new MonitoringCatalogUnexpectedError({ cause: error }),
        try: operation,
    }).pipe(
        Effect.catchTag("MonitoringCatalogUnexpectedError", (error) =>
            Effect.die(error.cause)
        )
    );
}

function notFound(
    resource: "incident" | "notification" | "report",
    id: string
): MonitoringCatalogNotFoundError {
    return new MonitoringCatalogNotFoundError({ id, resource });
}

function conflict(
    resource: "notification" | "report",
    id: string
): MonitoringCatalogConflictError {
    return new MonitoringCatalogConflictError({ id, resource });
}

function reportMatchesInput(
    record: ReportPersistenceRecord,
    input: UpsertReportInput
): boolean {
    return (
        record.bodyMarkdown === input.bodyMarkdown &&
        record.id === input.id &&
        record.kind === input.kind &&
        serializeMonitoringJsonObject(parseMonitoringJsonObject(record.metadataJson)) ===
            serializeMonitoringJsonObject(input.metadata) &&
        getTime(record.occurredAt) === input.occurredAtMs &&
        record.source === input.source &&
        record.sourceJobId === (input.sourceJobId ?? null) &&
        record.status === input.status &&
        record.summary === (input.summary ?? null) &&
        record.title === input.title
    );
}

function notificationMatchesInput(
    record: NotificationPersistenceRecord,
    input: UpsertNotificationInput
): boolean {
    return (
        record.channel === "dashboard" &&
        record.id === input.id &&
        record.incidentGeneration === (input.incidentGeneration ?? null) &&
        record.incidentId === (input.incidentId ?? null) &&
        record.kind === input.kind &&
        record.linkUrl === (input.linkUrl ?? null) &&
        record.message === input.message &&
        getTime(record.occurredAt) === input.occurredAtMs &&
        record.reportId === (input.reportId ?? null) &&
        record.severity === input.severity &&
        record.source === (input.source ?? null) &&
        record.title === input.title
    );
}

function notificationLatestStateAt(record: NotificationPersistenceRecord): Date {
    return record.readAt ?? record.occurredAt;
}

function appendCatalogRealtimeEvent(
    unit: MonitoringUnitOfWork,
    timing: CatalogMutationTiming,
    input: {
        readonly entityId: string;
        readonly entityType: "notification" | "report";
        readonly operation: "created" | "deleted" | "snapshot-required" | "updated";
    }
): void {
    appendMonitoringRealtimeEvent(unit, {
        entityId: input.entityId,
        entityType: input.entityType,
        expiresAt: timing.expiresAt,
        occurredAt: timing.occurredAt,
        operation: input.operation,
        topic:
            input.entityType === "notification"
                ? monitoringRealtimeTopics.notifications
                : monitoringRealtimeTopics.reports,
    });
}

/**
 * Creates catalog operations over validated monitoring persistence.
 * @param dependencies Repository plus replaceable clock, retention, and wakeup boundaries.
 * @returns Effect service with typed expected catalog failures.
 */
export function createMonitoringCatalogService(
    dependencies: MonitoringCatalogServiceDependencies
): MonitoringCatalogService["Service"] {
    const nowMs = dependencies.nowMs ?? Date.now;
    const realtimeRetentionMs = parseSchemaWithRangeError(
        catalogRealtimeRetentionSchema,
        dependencies.realtimeRetentionMs ?? defaultRealtimeRetentionMilliseconds
    );
    const maximumRetainedTimestampMs = maxTime - realtimeRetentionMs;
    const retainableMutationTimestampSchema = v.pipe(
        catalogClockSchema,
        v.maxValue(
            maximumRetainedTimestampMs,
            "Monitoring catalog mutation time leaves no room for realtime retention"
        )
    );
    const readClockMs = (): number =>
        parseSchemaWithRangeError(catalogClockSchema, nowMs());
    parseSchemaWithRangeError(retainableMutationTimestampSchema, readClockMs());
    const now = (): Date => toDate(readClockMs());
    const mutationTiming = (
        referenceDates: readonly Date[] = []
    ): CatalogMutationTiming => {
        const occurredAt = toDate(
            parseSchemaWithRangeError(
                retainableMutationTimestampSchema,
                getTime(maximumDate([now(), ...referenceDates]))
            )
        );
        const expiresAt = addMilliseconds(occurredAt, realtimeRetentionMs);
        parseSchemaWithRangeError(catalogRealtimeExpirySchema, getTime(expiresAt));
        return { expiresAt, occurredAt };
    };
    const producerMutationTiming = (
        resource: "notification" | "report",
        id: string,
        occurredAtMs: number
    ): CatalogMutationTiming => {
        if (occurredAtMs > maximumRetainedTimestampMs) {
            throw new MonitoringCatalogValidationError({
                id,
                maximumOccurredAtMs: maximumRetainedTimestampMs,
                occurredAtMs,
                resource,
            });
        }
        return mutationTiming([toDate(occurredAtMs)]);
    };
    const wakeAfterChange = async (changed: boolean): Promise<void> => {
        if (!changed || dependencies.wakeEventPump === undefined) return;
        try {
            await dependencies.wakeEventPump();
        } catch {
            // SQLite remains authoritative; adaptive polling recovers the wakeup.
        }
    };
    const commitResult = async <T>(
        operation: (unit: MonitoringUnitOfWork) => CatalogMutationResult<T>
    ): Promise<T> => {
        const result = await dependencies.repository.withImmediateTransaction(operation);
        await wakeAfterChange(result.changed);
        return result.value;
    };
    return MonitoringCatalogService.of({
        clearReadNotifications: (input) =>
            mutationEffect(() =>
                commitResult((unit) => {
                    const candidates = unit.listNotificationMutationCandidates(
                        input.filters,
                        "read",
                        notificationPageMaximum + 1
                    );
                    const remaining = candidates.length > notificationPageMaximum;
                    const page = candidates.slice(0, notificationPageMaximum);
                    const timing = mutationTiming(
                        page.map((notification) =>
                            notificationLatestStateAt(notification)
                        )
                    );
                    const deleted = unit.deleteNotifications(
                        page.map((notification) => notification.id)
                    );
                    if (deleted.length !== page.length) {
                        throw new Error(
                            "Monitoring notification deletion changed unexpectedly"
                        );
                    }
                    for (const notification of deleted) {
                        appendCatalogRealtimeEvent(unit, timing, {
                            entityId: notification.id,
                            entityType: "notification",
                            operation: "deleted",
                        });
                    }
                    return {
                        changed: deleted.length > 0,
                        value: v.parse(bulkNotificationResultSchema, {
                            affectedCount: deleted.length,
                            completedAtMs: getTime(timing.occurredAt),
                            remaining,
                        }),
                    };
                })
            ),
        deleteNotification: (input) =>
            mutationEffect(() =>
                commitResult((unit) => {
                    const current = unit.findNotification(input.id);
                    if (current === undefined) {
                        throw notFound("notification", input.id);
                    }
                    const timing = mutationTiming([notificationLatestStateAt(current)]);
                    const deleted = unit.deleteNotification(input.id);
                    if (deleted === undefined) {
                        throw new Error(
                            "Monitoring notification deletion changed unexpectedly"
                        );
                    }
                    appendCatalogRealtimeEvent(unit, timing, {
                        entityId: deleted.id,
                        entityType: "notification",
                        operation: "deleted",
                    });
                    return {
                        changed: true,
                        value: v.parse(deleteNotificationResultSchema, {
                            deletedAtMs: getTime(timing.occurredAt),
                            id: deleted.id,
                        }),
                    };
                })
            ),
        deleteReport: (input) =>
            mutationEffect(() =>
                commitResult((unit) => {
                    const current = unit.findReport(input.id);
                    if (current === undefined) throw notFound("report", input.id);
                    const linkedNotifications = unit.listReportNotifications(
                        input.id,
                        notificationPageMaximum + 1
                    );
                    if (linkedNotifications.length > notificationPageMaximum) {
                        throw new MonitoringCatalogPreconditionError({
                            id: input.id,
                            linkedNotificationCount: linkedNotifications.length,
                            maximumLinkedNotifications: notificationPageMaximum,
                            resource: "report",
                        });
                    }
                    const timing = mutationTiming([
                        current.occurredAt,
                        ...linkedNotifications.map((notification) =>
                            notificationLatestStateAt(notification)
                        ),
                    ]);
                    const deleted = unit.deleteReport(input.id);
                    if (deleted === undefined) {
                        throw new Error(
                            "Monitoring report deletion changed unexpectedly"
                        );
                    }
                    if (linkedNotifications.length > 0) {
                        appendCatalogRealtimeEvent(unit, timing, {
                            entityId: deleted.id,
                            entityType: "notification",
                            operation: "snapshot-required",
                        });
                    }
                    appendCatalogRealtimeEvent(unit, timing, {
                        entityId: deleted.id,
                        entityType: "report",
                        operation: "deleted",
                    });
                    return {
                        changed: true,
                        value: v.parse(deleteReportResultSchema, {
                            deletedAtMs: getTime(timing.occurredAt),
                            id: deleted.id,
                        }),
                    };
                })
            ),
        getIncident: (input) =>
            readEffect(() => {
                const record = dependencies.repository.findIncident(input.id);
                if (record === undefined) throw notFound("incident", input.id);
                return toIncidentRecord(record);
            }),
        getReport: (input) =>
            readEffect(() => {
                const record = dependencies.repository.findReport(input.id);
                if (record === undefined) throw notFound("report", input.id);
                return toReportDetail(record);
            }),
        listIncidents: (input) =>
            listEffect(() => {
                const records = dependencies.repository.listIncidents(input);
                const hasNextPage = records.length > input.limit;
                const page = records
                    .slice(0, input.limit)
                    .map((record) => toIncidentSummary(record));
                const last = page.at(-1);
                return v.parse(listIncidentsResultSchema, {
                    incidents: page,
                    ...(hasNextPage && last !== undefined
                        ? {
                              nextCursor: {
                                  id: last.id,
                                  lastSeenAtMs: last.lastSeenAtMs,
                              },
                          }
                        : {}),
                });
            }),
        listNotifications: (input) =>
            listEffect(() =>
                dependencies.repository.withReadTransaction((reader) => {
                    const records = reader.listNotifications(input);
                    const hasNextPage = records.length > input.limit;
                    const page = records
                        .slice(0, input.limit)
                        .map((record) => toNotificationRecord(record));
                    const last = page.at(-1);
                    return v.parse(listNotificationsResultSchema, {
                        ...(hasNextPage && last !== undefined
                            ? {
                                  nextCursor: {
                                      id: last.id,
                                      occurredAtMs: last.occurredAtMs,
                                  },
                              }
                            : {}),
                        notifications: page,
                        readCount: reader.countReadNotifications(),
                        unreadCount: reader.countUnreadNotifications(),
                    });
                })
            ),
        listReports: (input) =>
            listEffect(() => {
                const records = dependencies.repository.listReports(input);
                const hasNextPage = records.length > input.limit;
                const page = records
                    .slice(0, input.limit)
                    .map((record) => toReportSummary(record));
                const last = page.at(-1);
                return v.parse(listReportsResultSchema, {
                    ...(hasNextPage && last !== undefined
                        ? {
                              nextCursor: {
                                  id: last.id,
                                  occurredAtMs: last.occurredAtMs,
                              },
                          }
                        : {}),
                    reports: page,
                });
            }),
        markAllNotificationsRead: (input) =>
            mutationEffect(() =>
                commitResult((unit) => {
                    const candidates = unit.listNotificationMutationCandidates(
                        input.filters,
                        "unread",
                        notificationPageMaximum + 1
                    );
                    const page = candidates.slice(0, notificationPageMaximum);
                    const timing = mutationTiming(
                        page.map((notification) => notification.occurredAt)
                    );
                    const updated = unit.markNotificationsRead(
                        page.map((notification) => notification.id),
                        timing.occurredAt
                    );
                    if (updated.length !== page.length) {
                        throw new Error(
                            "Monitoring notification update changed unexpectedly"
                        );
                    }
                    for (const notification of updated) {
                        appendCatalogRealtimeEvent(unit, timing, {
                            entityId: notification.id,
                            entityType: "notification",
                            operation: "updated",
                        });
                    }
                    return {
                        changed: updated.length > 0,
                        value: v.parse(bulkNotificationResultSchema, {
                            affectedCount: updated.length,
                            completedAtMs: getTime(timing.occurredAt),
                            remaining: candidates.length > notificationPageMaximum,
                        }),
                    };
                })
            ),
        markNotificationRead: (input) =>
            mutationEffect(() =>
                commitResult((unit) => {
                    const current = unit.findNotification(input.id);
                    if (current === undefined) {
                        throw notFound("notification", input.id);
                    }
                    if (current.readAt !== null) {
                        return {
                            changed: false,
                            value: toNotificationRecord(current),
                        };
                    }
                    const timing = mutationTiming([current.occurredAt]);
                    const updated = unit.markNotificationsRead(
                        [current.id],
                        timing.occurredAt
                    )[0];
                    if (updated === undefined) {
                        throw new Error(
                            "Monitoring notification update changed unexpectedly"
                        );
                    }
                    appendCatalogRealtimeEvent(unit, timing, {
                        entityId: updated.id,
                        entityType: "notification",
                        operation: "updated",
                    });
                    return {
                        changed: true,
                        value: toNotificationRecord(updated),
                    };
                })
            ),
        upsertNotification: (input) =>
            mutationEffect(() =>
                commitResult((unit) => {
                    const existing = unit.findNotification(input.id);
                    if (existing !== undefined) {
                        if (!notificationMatchesInput(existing, input)) {
                            throw conflict("notification", input.id);
                        }
                        return {
                            changed: false,
                            value: toNotificationRecord(existing),
                        };
                    }
                    const timing = producerMutationTiming(
                        "notification",
                        input.id,
                        input.occurredAtMs
                    );
                    if (
                        input.incidentId !== undefined &&
                        input.incidentGeneration !== undefined
                    ) {
                        const incident = unit.findIncident(input.incidentId);
                        if (
                            incident === undefined ||
                            incident.generation !== input.incidentGeneration
                        ) {
                            throw notFound("incident", input.incidentId);
                        }
                        const related = unit.findIncidentNotification(
                            input.incidentId,
                            input.incidentGeneration
                        );
                        if (related !== undefined) {
                            throw conflict("notification", input.id);
                        }
                    }
                    if (
                        input.reportId !== undefined &&
                        unit.findReport(input.reportId) === undefined
                    ) {
                        throw notFound("report", input.reportId);
                    }
                    const inserted = unit.insertNotification({
                        channel: "dashboard",
                        id: input.id,
                        incidentGeneration: input.incidentGeneration ?? null,
                        incidentId: input.incidentId ?? null,
                        kind: input.kind,
                        linkUrl: input.linkUrl ?? null,
                        message: input.message,
                        occurredAt: toDate(input.occurredAtMs),
                        reportId: input.reportId ?? null,
                        severity: input.severity,
                        source: input.source ?? null,
                        title: input.title,
                    });
                    appendCatalogRealtimeEvent(unit, timing, {
                        entityId: inserted.id,
                        entityType: "notification",
                        operation: "created",
                    });
                    return {
                        changed: true,
                        value: toNotificationRecord(inserted),
                    };
                })
            ),
        upsertReport: (input) =>
            mutationEffect(() =>
                commitResult((unit) => {
                    const existing = unit.findReport(input.id);
                    if (existing !== undefined) {
                        if (!reportMatchesInput(existing, input)) {
                            throw conflict("report", input.id);
                        }
                        return { changed: false, value: toReportDetail(existing) };
                    }
                    const timing = producerMutationTiming(
                        "report",
                        input.id,
                        input.occurredAtMs
                    );
                    const inserted = unit.insertReport({
                        bodyMarkdown: input.bodyMarkdown,
                        id: input.id,
                        kind: input.kind,
                        metadataJson: serializeMonitoringJsonObject(input.metadata),
                        occurredAt: toDate(input.occurredAtMs),
                        source: input.source,
                        sourceJobId: input.sourceJobId ?? null,
                        status: input.status,
                        summary: input.summary ?? null,
                        title: input.title,
                    });
                    appendCatalogRealtimeEvent(unit, timing, {
                        entityId: inserted.id,
                        entityType: "report",
                        operation: "created",
                    });
                    return { changed: true, value: toReportDetail(inserted) };
                })
            ),
    });
}

/**
 * Provides the monitoring catalog service as an Effect layer.
 * @param dependencies Repository plus replaceable clock, retention, and wakeup boundaries.
 * @returns Layer containing the catalog service.
 */
export function monitoringCatalogServiceLayer(
    dependencies: MonitoringCatalogServiceDependencies
): Layer.Layer<MonitoringCatalogService> {
    return Layer.succeed(
        MonitoringCatalogService,
        createMonitoringCatalogService(dependencies)
    );
}
