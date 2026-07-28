import {
    assertContractKeys,
    contractEnum,
    contractFiniteNumber,
    contractPositiveInteger,
    contractRecord,
    contractString,
    invalidContract,
    optionalContractBoolean,
    optionalContractString,
} from "./runtime";

export type ReportType = "daily_brief" | "daily_summary" | "heartbeat" | "custom";
export type ReportStatus = "ok" | "warning" | "error";

export interface Report {
    bodyMd: string;
    createdAt: string;
    dedupeKey?: string;
    id: number;
    metadata: Record<string, unknown>;
    occurredAt: string;
    source?: string;
    sourceJobId?: string;
    status: ReportStatus;
    summary: string;
    title: string;
    type: ReportType;
    updatedAt: string;
}

export interface CreateReportInput {
    bodyMd: string;
    dedupeKey?: string;
    metadata?: Record<string, unknown>;
    notify?: boolean;
    occurredAt?: string;
    source?: string;
    sourceJobId?: string;
    status?: ReportStatus;
    summary?: string;
    title: string;
    type: ReportType;
}

export interface ReportsFilters {
    status?: ReportStatus;
    type?: ReportType;
}

export interface ReportsResponse {
    items: Report[];
}

export interface ReportResponse {
    report: Report;
}

export interface CreateReportResponse extends ReportResponse {
    isOk: true;
}

export interface DeleteReportResponse {
    deleted: number;
    isOk: true;
}

const REPORT_TYPES = ["daily_brief", "daily_summary", "heartbeat", "custom"] as const;
const REPORT_STATUSES = ["ok", "warning", "error"] as const;

function optionalTrimmedString(value: unknown, path: string): string | undefined {
    if (value === undefined) return undefined;
    const parsed = contractString(value, path, {
        allowEmpty: true,
        trim: true,
    });
    return parsed || undefined;
}

/** Parses report creation for both automation and browser callers. */
export function parseCreateReportInput(value: unknown): CreateReportInput {
    const input = contractRecord(value);
    assertContractKeys(
        input,
        [
            "bodyMd",
            "dedupeKey",
            "metadata",
            "notify",
            "occurredAt",
            "source",
            "sourceJobId",
            "status",
            "summary",
            "title",
            "type",
        ],
        "body"
    );
    const metadata =
        input.metadata === undefined
            ? undefined
            : contractRecord(input.metadata, "body.metadata");
    const notify = optionalContractBoolean(input.notify, "body.notify");
    const occurredAt = optionalContractString(input.occurredAt, "body.occurredAt");
    if (occurredAt !== undefined && Number.isNaN(Date.parse(occurredAt))) {
        return invalidContract("body.occurredAt", "must be a valid timestamp");
    }
    const status =
        input.status === undefined || input.status === ""
            ? "ok"
            : contractEnum(input.status, REPORT_STATUSES, "body.status");
    const optionalStrings = {
        dedupeKey: optionalTrimmedString(input.dedupeKey, "body.dedupeKey"),
        source: optionalTrimmedString(input.source, "body.source"),
        sourceJobId: optionalTrimmedString(input.sourceJobId, "body.sourceJobId"),
        summary: optionalTrimmedString(input.summary, "body.summary"),
    };
    return {
        bodyMd: contractString(input.bodyMd, "body.bodyMd", { trim: false }),
        status,
        title: contractString(input.title, "body.title"),
        type: contractEnum(input.type, REPORT_TYPES, "body.type"),
        ...(optionalStrings.dedupeKey !== undefined && {
            dedupeKey: optionalStrings.dedupeKey,
        }),
        ...(metadata !== undefined && { metadata }),
        ...(notify !== undefined && { notify }),
        ...(occurredAt !== undefined && {
            occurredAt: new Date(occurredAt).toISOString(),
        }),
        ...(optionalStrings.source !== undefined && {
            source: optionalStrings.source,
        }),
        ...(optionalStrings.sourceJobId !== undefined && {
            sourceJobId: optionalStrings.sourceJobId,
        }),
        ...(optionalStrings.summary !== undefined && {
            summary: optionalStrings.summary,
        }),
    };
}

export function parseReportResponseValue(value: unknown, path = "response"): Report {
    const input = contractRecord(value, path);
    const metadata = contractRecord(input.metadata, `${path}.metadata`);
    const optionalStrings = {
        dedupeKey: optionalContractString(input.dedupeKey, `${path}.dedupeKey`, {
            allowEmpty: true,
            trim: false,
        }),
        source: optionalContractString(input.source, `${path}.source`, {
            allowEmpty: true,
            trim: false,
        }),
        sourceJobId: optionalContractString(input.sourceJobId, `${path}.sourceJobId`, {
            allowEmpty: true,
            trim: false,
        }),
    };
    return {
        bodyMd: contractString(input.bodyMd, `${path}.bodyMd`, {
            allowEmpty: true,
            trim: false,
        }),
        createdAt: contractString(input.createdAt, `${path}.createdAt`, {
            trim: false,
        }),
        id: contractPositiveInteger(input.id, `${path}.id`),
        metadata,
        occurredAt: contractString(input.occurredAt, `${path}.occurredAt`, {
            trim: false,
        }),
        status: contractEnum(input.status, REPORT_STATUSES, `${path}.status`),
        summary: contractString(input.summary, `${path}.summary`, {
            allowEmpty: true,
            trim: false,
        }),
        title: contractString(input.title, `${path}.title`, {
            allowEmpty: true,
            trim: false,
        }),
        type: contractEnum(input.type, REPORT_TYPES, `${path}.type`),
        updatedAt: contractString(input.updatedAt, `${path}.updatedAt`, {
            trim: false,
        }),
        ...(optionalStrings.dedupeKey !== undefined && {
            dedupeKey: optionalStrings.dedupeKey,
        }),
        ...(optionalStrings.source !== undefined && {
            source: optionalStrings.source,
        }),
        ...(optionalStrings.sourceJobId !== undefined && {
            sourceJobId: optionalStrings.sourceJobId,
        }),
    };
}

export function parseReportsResponse(value: unknown): ReportsResponse {
    const input = contractRecord(value, "response");
    if (!Array.isArray(input.items)) {
        return invalidContract("response.items", "must be an array");
    }
    return {
        items: input.items.map((report, index) =>
            parseReportResponseValue(report, `response.items[${index}]`)
        ),
    };
}

export function parseReportResponse(value: unknown): ReportResponse {
    const input = contractRecord(value, "response");
    return {
        report: parseReportResponseValue(input.report, "response.report"),
    };
}

export function parseCreateReportResponse(value: unknown): CreateReportResponse {
    const input = contractRecord(value, "response");
    return {
        isOk:
            input.isOk === true ? true : invalidContract("response.isOk", "must be true"),
        report: parseReportResponseValue(input.report, "response.report"),
    };
}

export function parseDeleteReportResponse(value: unknown): DeleteReportResponse {
    const input = contractRecord(value, "response");
    const deleted = contractFiniteNumber(input.deleted, "response.deleted");
    if (!Number.isSafeInteger(deleted) || deleted < 0) {
        return invalidContract("response.deleted", "must be a non-negative integer");
    }
    return {
        deleted,
        isOk:
            input.isOk === true ? true : invalidContract("response.isOk", "must be true"),
    };
}
