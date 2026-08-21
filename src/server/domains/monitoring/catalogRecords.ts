import { getTime } from "date-fns";
import * as v from "valibot";

import {
    incidentRecordSchema,
    incidentSummarySchema,
    notificationRecordSchema,
    reportDetailSchema,
    reportSummarySchema,
    type IncidentRecord,
    type IncidentSummary,
    type NotificationRecord,
    type ReportDetail,
    type ReportSummary,
} from "../../../contracts/monitoring.ts";
import type {
    IncidentRecord as IncidentPersistenceRecord,
    NotificationRecord as NotificationPersistenceRecord,
    ReportRecord as ReportPersistenceRecord,
} from "./repository.ts";
import { parseMonitoringJsonObject } from "./serialization.ts";

/**
 * Converts one validated persistence row to its public report summary.
 * @param record Validated persistence row.
 * @returns Public report summary.
 */
export function toReportSummary(record: ReportPersistenceRecord): ReportSummary {
    return v.parse(reportSummarySchema, {
        id: record.id,
        kind: record.kind,
        occurredAtMs: getTime(record.occurredAt),
        source: record.source,
        ...(record.sourceJobId === null ? {} : { sourceJobId: record.sourceJobId }),
        status: record.status,
        ...(record.summary === null ? {} : { summary: record.summary }),
        title: record.title,
    });
}

/**
 * Converts one validated persistence row to its complete public report.
 * @param record Validated persistence row.
 * @returns Complete public report.
 */
export function toReportDetail(record: ReportPersistenceRecord): ReportDetail {
    return v.parse(reportDetailSchema, {
        ...toReportSummary(record),
        bodyMarkdown: record.bodyMarkdown,
        metadata: parseMonitoringJsonObject(record.metadataJson),
    });
}

/**
 * Converts one validated lifecycle row to its public incident variant.
 * @param record Validated persistence row.
 * @returns Public incident record.
 */
export function toIncidentRecord(record: IncidentPersistenceRecord): IncidentRecord {
    return v.parse(incidentRecordSchema, {
        details: parseMonitoringJsonObject(record.detailsJson),
        fingerprint: record.fingerprint,
        firstSeenAtMs: getTime(record.firstSeenAt),
        generation: record.generation,
        id: record.id,
        kind: record.kind,
        lastSeenAtMs: getTime(record.lastSeenAt),
        monitorKey: record.monitorKey,
        occurrenceCount: record.occurrenceCount,
        ...(record.resolvedAt === null
            ? {}
            : { resolvedAtMs: getTime(record.resolvedAt) }),
        severity: record.severity,
        state: record.state,
        title: record.title,
    });
}

/**
 * Converts one validated lifecycle row to its bounded public list summary.
 * @param record Validated persistence row.
 * @returns Public incident summary without the details document.
 */
export function toIncidentSummary(record: IncidentPersistenceRecord): IncidentSummary {
    return v.parse(incidentSummarySchema, {
        fingerprint: record.fingerprint,
        firstSeenAtMs: getTime(record.firstSeenAt),
        generation: record.generation,
        id: record.id,
        kind: record.kind,
        lastSeenAtMs: getTime(record.lastSeenAt),
        monitorKey: record.monitorKey,
        occurrenceCount: record.occurrenceCount,
        ...(record.resolvedAt === null
            ? {}
            : { resolvedAtMs: getTime(record.resolvedAt) }),
        severity: record.severity,
        state: record.state,
        title: record.title,
    });
}

/**
 * Converts one validated Dashboard notification row to its public record.
 * @param record Validated persistence row.
 * @returns Public notification record.
 */
export function toNotificationRecord(
    record: NotificationPersistenceRecord
): NotificationRecord {
    return v.parse(notificationRecordSchema, {
        id: record.id,
        ...(record.incidentGeneration === null
            ? {}
            : { incidentGeneration: record.incidentGeneration }),
        ...(record.incidentId === null ? {} : { incidentId: record.incidentId }),
        kind: record.kind,
        ...(record.linkUrl === null ? {} : { linkUrl: record.linkUrl }),
        message: record.message,
        occurredAtMs: getTime(record.occurredAt),
        ...(record.readAt === null ? {} : { readAtMs: getTime(record.readAt) }),
        ...(record.reportId === null ? {} : { reportId: record.reportId }),
        severity: record.severity,
        ...(record.source === null ? {} : { source: record.source }),
        title: record.title,
    });
}
