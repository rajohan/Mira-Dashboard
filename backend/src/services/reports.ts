import { database, sqlNullable } from "../database.ts";

export type ReportType = "daily_brief" | "daily_summary" | "heartbeat" | "custom";
export type ReportStatus = "ok" | "warning" | "error";

export interface ReportRecord {
    id: number;
    type: ReportType;
    status: ReportStatus;
    title: string;
    bodyMd: string;
    summary: string;
    source: string | undefined;
    sourceJobId: string | undefined;
    dedupeKey: string | undefined;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    occurredAt: string;
}

export interface CreateReportInput {
    type: ReportType;
    status?: ReportStatus;
    title: string;
    bodyMd: string;
    summary?: string;
    source?: string;
    sourceJobId?: string;
    dedupeKey?: string;
    metadata?: Record<string, unknown>;
    occurredAt?: string;
    notify?: boolean;
}

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

function nowIso(): string {
    return new Date().toISOString();
}

function parseMetadata(value: string): Record<string, unknown> {
    try {
        const parsed = value ? JSON.parse(value) : {};
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function toReportRecord(row: ReportRow): ReportRecord {
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

function shouldCreateNotification(report: ReportRecord, shouldNotify: boolean): boolean {
    if (!shouldNotify) return false;
    if (report.type === "heartbeat") return report.status !== "ok";
    return true;
}

function notificationTitle(report: ReportRecord): string {
    if (report.type === "daily_brief") return "Daily brief ready";
    if (report.type === "daily_summary") return "Daily summary ready";
    if (report.type === "heartbeat") return `Heartbeat ${report.status}`;
    return report.title;
}

function notificationDedupeKey(report: ReportRecord): string {
    if (report.type === "heartbeat") {
        return report.dedupeKey
            ? `report:heartbeat:${report.dedupeKey}`
            : `report:heartbeat:${report.id}`;
    }
    return report.dedupeKey
        ? `report:${report.dedupeKey}`
        : `report:${report.type}:${report.id}`;
}

function deleteReportNotification(report: ReportRecord): void {
    database
        .prepare("DELETE FROM notifications WHERE dedupe_key = ?")
        .run(notificationDedupeKey(report));
}

function createReportNotification(report: ReportRecord): void {
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
            report.summary || report.title,
            notificationTypeForReport(report.status),
            sqlNullable(report.source ?? "reports"),
            notificationDedupeKey(report),
            JSON.stringify({
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

export function createReport(input: CreateReportInput): ReportRecord {
    const now = nowIso();
    const occurredAt = input.occurredAt ?? now;
    const status = input.status ?? "ok";
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

    const report = toReportRecord(row);
    if (shouldCreateNotification(report, input.notify ?? true)) {
        createReportNotification(report);
    } else if (report.type === "heartbeat" && report.status === "ok") {
        deleteReportNotification(report);
    }
    return report;
}

export function listReports(options: ListReportsOptions = {}): ReportRecord[] {
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
    return rows.map((row) => toReportRecord(row));
}

export function getReport(id: number): ReportRecord | undefined {
    const row = database
        .prepare(
            `SELECT id, type, status, title, body_md, summary, source, source_job_id, dedupe_key, metadata_json, created_at, updated_at, occurred_at
             FROM reports
             WHERE id = ?`
        )
        .get(id) as ReportRow | undefined;
    return row ? toReportRecord(row) : undefined;
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
