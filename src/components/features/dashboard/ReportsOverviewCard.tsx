import { Newspaper } from "lucide-react";

import { type ReportItem, useReports } from "../../../hooks/useReports";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

function reportTimestamp(report: ReportItem): number {
    const occurredAt = Date.parse(report.occurredAt);
    if (!Number.isNaN(occurredAt)) return occurredAt;
    const createdAt = Date.parse(report.createdAt);
    return Number.isNaN(createdAt) ? 0 : createdAt;
}

function statusVariant(status: ReportItem["status"]) {
    if (status === "error") return "error" as const;
    if (status === "warning") return "warning" as const;
    return "success" as const;
}

/** Renders the reports overview card UI. */
export function ReportsOverviewCard() {
    const { data, isError, isLoading } = useReports();
    const reports = data?.items ?? [];
    const latestReport =
        [...reports].toSorted((a, b) => reportTimestamp(b) - reportTimestamp(a))[0] ||
        undefined;
    const warningCount = reports.filter((report) => report.status === "warning").length;
    const errorCount = reports.filter((report) => report.status === "error").length;
    const heartbeatCount = reports.filter((report) => report.type === "heartbeat").length;

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                    Reports
                </h3>
                <Newspaper className="size-4 text-primary-400" />
            </div>

            {isLoading ? (
                <div className="text-sm text-primary-300">Loading reports…</div>
            ) : isError && !data ? (
                <div className="text-sm text-rose-300">Reports unavailable.</div>
            ) : (
                <div className="space-y-2 text-sm text-primary-200">
                    <div className="flex items-center justify-between">
                        <span>Total</span>
                        <span className="font-semibold text-primary-50">
                            {reports.length}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Heartbeat</span>
                        <span className="text-primary-100">{heartbeatCount}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Warnings</span>
                        <span
                            className={
                                warningCount > 0 ? "text-yellow-300" : "text-green-300"
                            }
                        >
                            {warningCount}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Errors</span>
                        <span
                            className={errorCount > 0 ? "text-red-300" : "text-green-300"}
                        >
                            {errorCount}
                        </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <span className="shrink-0">Latest</span>
                        <span className="min-w-0 truncate text-right text-primary-100">
                            {latestReport
                                ? `${formatDate(reportTimestamp(latestReport))} (${latestReport.title})`
                                : "—"}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span>Latest status</span>
                        <Badge
                            variant={
                                latestReport
                                    ? statusVariant(latestReport.status)
                                    : "default"
                            }
                        >
                            {latestReport?.status ?? "none"}
                        </Badge>
                    </div>
                </div>
            )}
        </Card>
    );
}
