import { createHash } from "node:crypto";

import type {
    CreateReportInput,
    Report,
    ReportStatus,
    ReportType,
} from "../../../contracts/reports.ts";
import { isPlainRecord } from "../../../contracts/runtime.ts";
import { database, sqlNullable } from "../database/connection.ts";

export interface ListReportsOptions {
    limit?: number;
    status?: ReportStatus;
    type?: ReportType;
}

interface ReportRow {
    id: number;
    type: string;
    status: string;
    title: string;
    body_md: string;
    summary: string;
    source: string | null;
    source_job_id: string | null;
    dedupe_key: string | null;
    metadata_json: string;
    created_at: string;
    updated_at: string;
    occurred_at: string;
}

interface HeartbeatIncident {
    key: string;
    summary: string;
}

const HEARTBEAT_INCIDENT_NOTIFICATION_PREFIX = "report:heartbeat:incident:";
const HEARTBEAT_INCIDENT_KEY_PATTERN =
    /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*){2}$/;

function nowIso(): string {
    return new Date().toISOString();
}

function parseMetadata(value: string): Record<string, unknown> {
    try {
        const parsed: unknown = value ? JSON.parse(value) : {};
        return isPlainRecord(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function toReport(row: ReportRow): Report {
    return {
        bodyMd: row.body_md,
        createdAt: row.created_at,
        dedupeKey: row.dedupe_key ?? undefined,
        id: row.id,
        metadata: parseMetadata(row.metadata_json),
        occurredAt: row.occurred_at,
        source: row.source ?? undefined,
        sourceJobId: row.source_job_id ?? undefined,
        status: row.status as ReportStatus,
        summary: row.summary,
        title: row.title,
        type: row.type as ReportType,
        updatedAt: row.updated_at,
    };
}

function notificationTypeForReport(status: ReportStatus): "error" | "info" | "warning" {
    if (status === "error") return "error";
    if (status === "warning") return "warning";
    return "info";
}

function shouldCreateNotification(report: Report, shouldNotify: boolean): boolean {
    if (!shouldNotify) return false;
    if (report.type === "heartbeat") return report.status !== "ok";
    return true;
}

function notificationTitle(report: Report): string {
    if (report.type === "daily_brief") return "Daily brief ready";
    if (report.type === "daily_summary") return "Daily summary ready";
    if (report.type === "heartbeat") return `Heartbeat ${report.status}`;
    return report.title;
}

function notificationDedupeKey(report: Report): string {
    return report.dedupeKey
        ? `report:${report.dedupeKey}`
        : `report:${report.type}:${report.id}`;
}

function deleteReportNotification(report: Report): void {
    database
        .prepare("DELETE FROM notifications WHERE dedupe_key = ?")
        .run(notificationDedupeKey(report));
}

function heartbeatIncidentKey(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    if (
        normalized.length === 0 ||
        normalized.length > 200 ||
        !HEARTBEAT_INCIDENT_KEY_PATTERN.test(normalized)
    ) {
        return undefined;
    }
    return normalized;
}

function heartbeatIncidents(report: Report): HeartbeatIncident[] | undefined {
    if (report.status === "ok") return [];

    const structuredIncidents = report.metadata.heartbeatIncidents;
    if (!Array.isArray(structuredIncidents)) return undefined;

    const incidents = new Map<string, HeartbeatIncident>();
    for (const value of structuredIncidents) {
        if (!isPlainRecord(value)) return undefined;
        const key = heartbeatIncidentKey(value.key);
        if (!key) return undefined;
        if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
            return undefined;
        }
        incidents.set(key, { key, summary: value.summary.trim() });
    }
    return incidents.size > 0
        ? [...incidents.values()].toSorted((left, right) =>
              left.key.localeCompare(right.key)
          )
        : undefined;
}

function latestHeartbeatReport(
    source: string | undefined,
    sourceJobId: string | undefined
): Report | undefined {
    const row = database
        .prepare(
            `SELECT id, type, status, title, body_md, summary, source, source_job_id, dedupe_key, metadata_json, created_at, updated_at, occurred_at
             FROM reports
             WHERE type = 'heartbeat'
               AND source IS ?
               AND source_job_id IS ?
             ORDER BY occurred_at DESC, id DESC
             LIMIT 1`
        )
        .get(sqlNullable(source), sqlNullable(sourceJobId)) as ReportRow | undefined;
    return row ? toReport(row) : undefined;
}

function heartbeatIncidentNotificationDedupeKey(
    report: Report,
    incidentKey: string
): string {
    const fingerprint = createHash("sha256")
        .update(
            JSON.stringify([
                report.source ?? "reports",
                report.sourceJobId ?? "heartbeat",
                incidentKey,
            ])
        )
        .digest("hex");
    return `${HEARTBEAT_INCIDENT_NOTIFICATION_PREFIX}${fingerprint}`;
}

function resolveHeartbeatIncident(report: Report, incidentKey: string): void {
    database
        .prepare(
            `UPDATE notifications
             SET is_read = 1, updated_at = ?
             WHERE dedupe_key = ?
               AND is_read = 0`
        )
        .run(nowIso(), heartbeatIncidentNotificationDedupeKey(report, incidentKey));
}

function resolveAllHeartbeatIncidents(report: Report): void {
    database
        .prepare(
            `UPDATE notifications
             SET is_read = 1, updated_at = ?
             WHERE source IS ?
               AND json_extract(metadata_json, '$.reportType') = 'heartbeat'
               AND json_extract(metadata_json, '$.sourceJobId') IS ?
               AND dedupe_key LIKE ?
               AND is_read = 0`
        )
        .run(
            nowIso(),
            report.source ?? "reports",
            sqlNullable(report.sourceJobId),
            `${HEARTBEAT_INCIDENT_NOTIFICATION_PREFIX}%`
        );
}

function createReportNotification(
    report: Report,
    heartbeatIncident?: HeartbeatIncident
): void {
    const now = nowIso();
    database
        .prepare(
            `INSERT INTO notifications (
                title, description, type, source, dedupe_key, metadata_json, is_read, created_at, updated_at, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
            ON CONFLICT(dedupe_key) DO UPDATE SET
                title = excluded.title,
                description = excluded.description,
                type = excluded.type,
                source = excluded.source,
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at,
                occurred_at = excluded.occurred_at,
                is_read = 0`
        )
        .run(
            notificationTitle(report),
            heartbeatIncident?.summary || report.summary || report.title,
            notificationTypeForReport(report.status),
            sqlNullable(report.source ?? "reports"),
            heartbeatIncident
                ? heartbeatIncidentNotificationDedupeKey(report, heartbeatIncident.key)
                : notificationDedupeKey(report),
            JSON.stringify({
                heartbeatIncidentKey: heartbeatIncident?.key,
                reportId: report.id,
                reportStatus: report.status,
                reportType: report.type,
                sourceJobId: report.sourceJobId,
            }),
            now,
            now,
            report.occurredAt
        );
}

function createReportInTransaction(input: CreateReportInput): Report {
    const now = nowIso();
    const occurredAt = input.occurredAt ?? now;
    const status = input.status ?? "ok";
    const previousHeartbeat =
        input.type === "heartbeat"
            ? latestHeartbeatReport(input.source, input.sourceJobId)
            : undefined;
    const row = database
        .prepare(
            `INSERT INTO reports (
                type, status, title, body_md, summary, source, source_job_id, dedupe_key, metadata_json, created_at, updated_at, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dedupe_key) DO UPDATE SET
                type = excluded.type,
                status = excluded.status,
                title = excluded.title,
                body_md = excluded.body_md,
                summary = excluded.summary,
                source = excluded.source,
                source_job_id = excluded.source_job_id,
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at,
                occurred_at = excluded.occurred_at
            RETURNING id, type, status, title, body_md, summary, source, source_job_id, dedupe_key, metadata_json, created_at, updated_at, occurred_at`
        )
        .get(
            input.type,
            status,
            input.title,
            input.bodyMd,
            input.summary ?? "",
            sqlNullable(input.source),
            sqlNullable(input.sourceJobId),
            sqlNullable(input.dedupeKey),
            JSON.stringify(input.metadata ?? {}),
            now,
            now,
            occurredAt
        ) as ReportRow | undefined;

    if (!row) {
        throw new Error("Failed to create report");
    }

    const report = toReport(row);
    const shouldNotify = shouldCreateNotification(report, input.notify ?? true);
    if (report.type === "heartbeat") {
        const currentIncidents = heartbeatIncidents(report);
        if (!currentIncidents) {
            throw new Error("Heartbeat report is missing a valid incident snapshot");
        }
        const isLatestSnapshot =
            !previousHeartbeat ||
            Date.parse(report.occurredAt) > Date.parse(previousHeartbeat.occurredAt);
        if (!isLatestSnapshot) return report;

        if (report.status === "ok") {
            resolveAllHeartbeatIncidents(report);
            return report;
        }

        const previousIncidents = previousHeartbeat
            ? (heartbeatIncidents(previousHeartbeat) ?? [])
            : [];
        const currentKeys = new Set(currentIncidents.map((incident) => incident.key));
        for (const incident of previousIncidents) {
            if (!currentKeys.has(incident.key)) {
                resolveHeartbeatIncident(report, incident.key);
            }
        }

        const previousKeys = new Set(previousIncidents.map((incident) => incident.key));
        if (shouldNotify) {
            for (const incident of currentIncidents) {
                if (!previousKeys.has(incident.key)) {
                    createReportNotification(report, incident);
                }
            }
        }
        return report;
    }

    if (shouldNotify) {
        createReportNotification(report);
    } else {
        deleteReportNotification(report);
    }
    return report;
}

export function createReport(input: CreateReportInput): Report {
    return database.transaction(createReportInTransaction)(input);
}

export function listReports(options: ListReportsOptions = {}): Report[] {
    const clauses: string[] = [];
    const bindings: Array<string | number> = [];
    if (options.type) {
        clauses.push("type = ?");
        bindings.push(options.type);
    }
    if (options.status) {
        clauses.push("status = ?");
        bindings.push(options.status);
    }
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 100)));
    bindings.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = database
        .prepare(
            `SELECT id, type, status, title, '' AS body_md, summary, source, source_job_id, dedupe_key, metadata_json, created_at, updated_at, occurred_at
             FROM reports
             ${where}
             ORDER BY occurred_at DESC
             LIMIT ?`
        )
        .all(...bindings) as ReportRow[];
    return rows.map((row) => toReport(row));
}

export function getReport(id: number): Report | undefined {
    const row = database
        .prepare(
            `SELECT id, type, status, title, body_md, summary, source, source_job_id, dedupe_key, metadata_json, created_at, updated_at, occurred_at
             FROM reports
             WHERE id = ?`
        )
        .get(id) as ReportRow | undefined;
    return row ? toReport(row) : undefined;
}

export function deleteReport(id: number): number {
    const transaction = database.transaction((reportId: number) => {
        database
            .prepare(
                `DELETE FROM notifications
                 WHERE json_extract(metadata_json, '$.reportId') = ?`
            )
            .run(reportId);
        return database.prepare("DELETE FROM reports WHERE id = ?").run(reportId).changes;
    });

    return transaction(id) || 0;
}
