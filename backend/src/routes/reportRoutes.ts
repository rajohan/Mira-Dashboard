import { json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import {
    createReport,
    deleteReport,
    getReport,
    listReports,
    type ReportStatus,
    type ReportType,
} from "../services/reports.ts";

type ParametersRequest<T extends string> = Request & { params: Record<T, string> };

const reportTypes = new Set(["daily_brief", "daily_summary", "heartbeat", "custom"]);
const reportStatuses = new Set(["ok", "warning", "error"]);

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredStringField(
    field: string,
    value: unknown,
    options: { preserveWhitespace?: boolean } = {}
): string | Response {
    if (typeof value !== "string" || !value.trim()) {
        return json({ error: `${field} is required` }, { status: 400 });
    }
    return options.preserveWhitespace ? value : value.trim();
}

function optionalStringField(
    field: string,
    value: unknown
): string | undefined | Response {
    if (value == undefined) {
        return undefined;
    }
    if (typeof value !== "string") {
        return json({ error: `${field} must be a string` }, { status: 400 });
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}

function validId(value: string | undefined): number | undefined {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function reportRouteError(error: unknown, fallback: string): Response {
    return json(
        { error: errorMessage(error, fallback) },
        { status: httpStatusCode(error) }
    );
}

function parseReportType(value: unknown): ReportType | Response {
    if (typeof value !== "string" || !reportTypes.has(value)) {
        return json({ error: "invalid report type" }, { status: 400 });
    }
    return value as ReportType;
}

function parseReportStatus(value: unknown): ReportStatus | Response {
    if (value === "" || value == undefined) {
        return "ok";
    }
    if (typeof value !== "string" || !reportStatuses.has(value)) {
        return json({ error: "invalid report status" }, { status: 400 });
    }
    return value as ReportStatus;
}

export const reportRoutes = {
    "/api/reports": {
        GET: (request: Request) => {
            try {
                const parameters = new URL(request.url).searchParams;
                const rawLimit = parameters.get("limit");
                const limitValue = rawLimit === null ? undefined : Number(rawLimit);
                const typeValue = parameters.get("type");
                const statusValue = parameters.get("status");
                const type =
                    typeValue && reportTypes.has(typeValue)
                        ? (typeValue as ReportType)
                        : undefined;
                const status =
                    statusValue && reportStatuses.has(statusValue)
                        ? (statusValue as ReportStatus)
                        : undefined;
                const limit =
                    limitValue !== undefined && Number.isFinite(limitValue)
                        ? Math.max(1, Math.min(200, Math.floor(limitValue)))
                        : 100;
                return json({ items: listReports({ limit, status, type }) });
            } catch (error) {
                return reportRouteError(error, "Failed to list reports");
            }
        },

        POST: async (request: Request) => {
            let body: Record<string, unknown>;
            try {
                body = await readJson<Record<string, unknown>>(request);
            } catch (error) {
                return reportRouteError(error, "Invalid JSON");
            }
            if (!isJsonObject(body)) {
                return json({ error: "Request body must be an object" }, { status: 400 });
            }

            const type = parseReportType(body.type);
            if (type instanceof Response) return type;
            const status = parseReportStatus(body.status);
            if (status instanceof Response) return status;
            const title = requiredStringField("title", body.title);
            if (title instanceof Response) return title;
            const bodyMd = requiredStringField("bodyMd", body.bodyMd, {
                preserveWhitespace: true,
            });
            if (bodyMd instanceof Response) return bodyMd;
            const summary = optionalStringField("summary", body.summary);
            if (summary instanceof Response) return summary;
            const source = optionalStringField("source", body.source);
            if (source instanceof Response) return source;
            const sourceJobId = optionalStringField("sourceJobId", body.sourceJobId);
            if (sourceJobId instanceof Response) return sourceJobId;
            const dedupeKey = optionalStringField("dedupeKey", body.dedupeKey);
            if (dedupeKey instanceof Response) return dedupeKey;
            const occurredAt = body.occurredAt ?? undefined;
            if (
                occurredAt !== undefined &&
                (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt)))
            ) {
                return json({ error: "invalid occurredAt" }, { status: 400 });
            }
            const normalizedOccurredAt =
                occurredAt === undefined ? undefined : new Date(occurredAt).toISOString();
            if (body.metadata !== undefined && !isJsonObject(body.metadata)) {
                return json({ error: "metadata must be an object" }, { status: 400 });
            }
            if (body.notify !== undefined && typeof body.notify !== "boolean") {
                return json({ error: "notify must be a boolean" }, { status: 400 });
            }

            try {
                const report = createReport({
                    bodyMd,
                    dedupeKey,
                    metadata: body.metadata as Record<string, unknown> | undefined,
                    notify: body.notify,
                    occurredAt: normalizedOccurredAt,
                    source,
                    sourceJobId,
                    status,
                    summary,
                    title,
                    type,
                });
                return json({ isOk: true, report }, { status: 201 });
            } catch (error) {
                return reportRouteError(error, "Failed to create report");
            }
        },
    },

    "/api/reports/:id": {
        GET: (request: ParametersRequest<"id">) => {
            try {
                const id = validId(request.params.id);
                if (id === undefined)
                    return json({ error: "invalid id" }, { status: 400 });
                const report = getReport(id);
                return report
                    ? json({ report })
                    : json({ error: "Report not found" }, { status: 404 });
            } catch (error) {
                return reportRouteError(error, "Failed to load report");
            }
        },
        DELETE: (request: ParametersRequest<"id">) => {
            try {
                const id = validId(request.params.id);
                if (id === undefined)
                    return json({ error: "invalid id" }, { status: 400 });
                return json({ deleted: deleteReport(id), isOk: true });
            } catch (error) {
                return reportRouteError(error, "Failed to delete report");
            }
        },
    },
} as const;
