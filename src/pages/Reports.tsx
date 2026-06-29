import { useLocation } from "@tanstack/react-router";
import { FileText, HeartPulse, Newspaper, ScrollText, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { LoadingState } from "../components/ui/LoadingState";
import type { ReportItem, ReportType } from "../hooks/useReports";
import { useDeleteReport, useReport, useReports } from "../hooks/useReports";
import { cn } from "../utils/cn";
import { formatDate } from "../utils/format";

type ReportFilter = "all" | ReportType;

const reportFilters: Array<{
    icon: typeof FileText;
    label: string;
    value: ReportFilter;
}> = [
    { icon: FileText, label: "All", value: "all" },
    { icon: Newspaper, label: "Briefs", value: "daily_brief" },
    { icon: FileText, label: "Summaries", value: "daily_summary" },
    { icon: HeartPulse, label: "Heartbeat", value: "heartbeat" },
    { icon: ScrollText, label: "Custom", value: "custom" },
];

function typeLabel(type: ReportType): string {
    if (type === "daily_brief") return "Daily brief";
    if (type === "daily_summary") return "Daily summary";
    if (type === "heartbeat") return "Heartbeat";
    return "Custom";
}

function statusVariant(status: ReportItem["status"]) {
    if (status === "error") return "error" as const;
    if (status === "warning") return "warning" as const;
    return "success" as const;
}

function reportIdFromSearch(search: string): number | undefined {
    const value = new URLSearchParams(search).get("reportId");
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function reportTimestamp(report: ReportItem): number {
    const occurredAt = Date.parse(report.occurredAt);
    if (!Number.isNaN(occurredAt)) return occurredAt;
    const createdAt = Date.parse(report.createdAt);
    return Number.isNaN(createdAt) ? 0 : createdAt;
}

interface ReportListProperties {
    reports: ReportItem[];
    selectedId: number | undefined;
    onSelect: (id: number) => void;
}

function ReportList({ reports, selectedId, onSelect }: ReportListProperties) {
    if (reports.length === 0) {
        return (
            <Card
                variant="bordered"
                className="flex min-h-72 items-center justify-center"
            >
                <EmptyState message="No reports yet." />
            </Card>
        );
    }

    return (
        <Card
            variant="bordered"
            className="flex min-w-0 flex-col p-0 xl:max-h-[calc(100vh-10rem)]"
        >
            <div className="border-primary-700 text-primary-200 border-b px-4 py-3 text-sm font-semibold">
                Reports
            </div>
            <div className="min-h-0 flex-1 overflow-visible p-2 xl:overflow-auto">
                {reports.map((report) => {
                    const isSelected = report.id === selectedId;
                    return (
                        <button
                            key={report.id}
                            type="button"
                            onClick={() => onSelect(report.id)}
                            className={cn(
                                "mb-2 w-full min-w-0 rounded-lg border px-3 py-2 text-left transition",
                                isSelected
                                    ? "border-accent-500 bg-accent-500/10"
                                    : "border-primary-700 bg-primary-800/40 hover:border-primary-500"
                            )}
                        >
                            <div className="flex min-w-0 items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="text-primary-100 truncate text-sm font-medium">
                                        {report.title}
                                    </div>
                                    <div className="text-primary-400 mt-1 truncate text-xs">
                                        {report.summary || typeLabel(report.type)}
                                    </div>
                                </div>
                                <Badge
                                    className="shrink-0 whitespace-nowrap"
                                    variant={statusVariant(report.status)}
                                >
                                    {report.status}
                                </Badge>
                            </div>
                            <div className="text-primary-400 mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                                <span>{typeLabel(report.type)}</span>
                                <span>{formatDate(report.occurredAt)}</span>
                            </div>
                        </button>
                    );
                })}
            </div>
        </Card>
    );
}

interface ReportDetailsProperties {
    report: ReportItem | undefined;
    onDelete: (id: number) => void;
    deletePending: boolean;
}

function ReportDetails({ report, onDelete, deletePending }: ReportDetailsProperties) {
    if (!report) {
        return (
            <Card
                variant="bordered"
                className="flex min-h-72 items-center justify-center"
            >
                <EmptyState message="Select a report." />
            </Card>
        );
    }

    return (
        <Card variant="bordered" className="min-w-0">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                        <Badge variant="info">{typeLabel(report.type)}</Badge>
                        <Badge variant={statusVariant(report.status)}>
                            {report.status}
                        </Badge>
                        {report.source ? <Badge>{report.source}</Badge> : undefined}
                    </div>
                    <CardTitle className="break-words">{report.title}</CardTitle>
                    <div className="text-primary-400 mt-1 text-sm">
                        {formatDate(reportTimestamp(report))}
                        {report.sourceJobId ? ` · ${report.sourceJobId}` : ""}
                    </div>
                </div>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(report.id)}
                    disabled={deletePending}
                    aria-label={`Delete ${report.title}`}
                >
                    <Trash2 className="h-4 w-4" />
                    Delete
                </Button>
            </div>

            {report.summary ? (
                <p className="border-primary-700 text-primary-200 bg-primary-900/40 mb-4 rounded-lg border p-3 text-sm">
                    {report.summary}
                </p>
            ) : undefined}

            <div className="prose prose-invert prose-sm max-w-none break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.bodyMd}</ReactMarkdown>
            </div>
        </Card>
    );
}

export function Reports() {
    const location = useLocation();
    const [filter, setFilter] = useState<ReportFilter>("all");
    const linkedReportId = reportIdFromSearch(location.searchStr);
    const [selectedId, setSelectedId] = useState<number | undefined>(linkedReportId);
    const reportsQuery = useReports(
        filter === "all" ? {} : { type: filter as ReportType }
    );
    const selectedReportQuery = useReport(selectedId);
    const deleteReport = useDeleteReport();
    const reports = [...(reportsQuery.data?.items ?? [])].toSorted(
        (a, b) => reportTimestamp(b) - reportTimestamp(a)
    );
    const linkedReport =
        linkedReportId === selectedReportQuery.data?.report?.id
            ? selectedReportQuery.data?.report
            : undefined;
    const reportItems =
        linkedReport && reports.every((report) => report.id !== linkedReport.id)
            ? [linkedReport, ...reports]
            : reports;

    useEffect(() => {
        if (linkedReportId !== undefined) {
            setSelectedId(linkedReportId);
        }
    }, [linkedReportId]);

    useEffect(() => {
        if (
            linkedReportId !== undefined &&
            selectedId === linkedReportId &&
            selectedReportQuery.isLoading
        ) {
            return;
        }
        if (selectedId && reportItems.some((report) => report.id === selectedId)) {
            return;
        }
        setSelectedId(reportItems[0]?.id);
    }, [
        linkedReport,
        linkedReportId,
        reportsQuery.data?.items,
        selectedId,
        selectedReportQuery.isLoading,
    ]);

    const selectedReport =
        selectedReportQuery.data?.report ??
        reportItems.find((report) => report.id === selectedId);

    return (
        <div className="space-y-4 p-4 sm:p-6">
            <div className="flex flex-wrap gap-2">
                {reportFilters.map((item) => (
                    <Button
                        key={item.value}
                        type="button"
                        variant={filter === item.value ? "primary" : "secondary"}
                        size="sm"
                        onClick={() => setFilter(item.value)}
                    >
                        <item.icon className="h-4 w-4" />
                        {item.label}
                    </Button>
                ))}
            </div>

            {reportsQuery.isLoading ? (
                <LoadingState message="Loading reports..." />
            ) : reportsQuery.isError ? (
                <Card variant="bordered">
                    <p className="text-red-300">Failed to load reports.</p>
                </Card>
            ) : (
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
                    <ReportList
                        reports={reportItems}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                    />
                    <ReportDetails
                        report={selectedReport}
                        deletePending={deleteReport.isPending}
                        onDelete={(id) =>
                            deleteReport.mutate(id, {
                                onSuccess: () => {
                                    if (selectedId === id) {
                                        setSelectedId(
                                            reportItems.find((report) => report.id !== id)
                                                ?.id
                                        );
                                    }
                                },
                            })
                        }
                    />
                </div>
            )}
        </div>
    );
}
