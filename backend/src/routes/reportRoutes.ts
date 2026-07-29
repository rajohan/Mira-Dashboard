import type {
    CreateReportResponse,
    DeleteReportResponse,
    ReportResponse,
    ReportsResponse,
    ReportStatus,
    ReportType,
} from "../../../contracts/reports.ts";
import { parseCreateReportInput } from "../../../contracts/reports.ts";
import { json } from "../http.ts";
import {
    type ParametersRequest,
    readApiJson,
    routeErrorResponse,
    routeFailureResponse,
} from "../routeSupport.ts";
import {
    createReport,
    deleteReport,
    getReport,
    listReports,
} from "../services/reports.ts";

const reportTypes = new Set(["daily_brief", "daily_summary", "heartbeat", "custom"]);
const reportStatuses = new Set(["ok", "warning", "error"]);

function validId(value: string | undefined): number | undefined {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
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
                return json({
                    items: listReports({ limit, status, type }),
                } satisfies ReportsResponse);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "reports_list_failed",
                    context: "reports.list",
                    message: "Failed to list reports",
                });
            }
        },

        POST: async (request: Request) => {
            try {
                const input = await readApiJson(request, parseCreateReportInput);
                const report = createReport(input);
                return json({ isOk: true, report } satisfies CreateReportResponse, {
                    status: 201,
                });
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "report_create_failed",
                    context: "reports.create",
                    message: "Failed to create report",
                });
            }
        },
    },

    "/api/reports/:id": {
        GET: (request: ParametersRequest<"id">) => {
            try {
                const id = validId(request.params.id);
                if (id === undefined)
                    return routeFailureResponse({
                        context: "report",
                        message: "invalid id",
                        status: 400,
                    });
                const report = getReport(id);
                return report
                    ? json({ report } satisfies ReportResponse)
                    : routeFailureResponse({
                          context: "report",
                          message: "Report not found",
                          status: 404,
                      });
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "report_lookup_failed",
                    context: "reports.get",
                    message: "Failed to load report",
                });
            }
        },
        DELETE: (request: ParametersRequest<"id">) => {
            try {
                const id = validId(request.params.id);
                if (id === undefined)
                    return routeFailureResponse({
                        context: "report",
                        message: "invalid id",
                        status: 400,
                    });
                return json({
                    deleted: deleteReport(id),
                    isOk: true,
                } satisfies DeleteReportResponse);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "report_delete_failed",
                    context: "reports.delete",
                    message: "Failed to delete report",
                });
            }
        },
    },
} as const;
