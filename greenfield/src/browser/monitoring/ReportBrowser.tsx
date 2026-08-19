import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { FileText, Filter, RotateCcw, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { ReportDetail, ReportSummary } from "../../contracts/monitoring.ts";
import type { ListReportsInput } from "../../contracts/reports.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import {
    classifyDashboardBrowserFailure,
    dashboardBrowserFailureMessage,
} from "../api/trpcError.ts";
import { cn } from "../lib/classNames.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { ExpandableCard } from "../ui/ExpandableCard.tsx";
import { Form } from "../ui/Form.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Select } from "../ui/Select.tsx";
import { Text } from "../ui/Text.tsx";
import { useDeleteReportMutation } from "./monitoringMutations.ts";
import { reportKindLabel, reportStatusVariant } from "./monitoringPresentation.ts";
import {
    reportDetailQueryOptions,
    reportListQueryOptions,
    uniqueMonitoringRows,
} from "./monitoringQueries.ts";
import { parseReportsRouteSearch } from "./monitoringRouteSearch.ts";
import { MonitoringSelectionList } from "./MonitoringSelectionList.tsx";

const reportStatusOptions = Object.freeze([
    { label: "All statuses", value: "all" },
    { label: "OK", value: "ok" },
    { label: "Warning", value: "warning" },
    { label: "Error", value: "error" },
] as const);

type ReportStatusFilter = (typeof reportStatusOptions)[number]["value"];

function reportDeletionFailureMessage(error: unknown): string {
    switch (classifyDashboardBrowserFailure(error)) {
        case "not-found": {
            return "This report no longer exists. Review the automatically updated list and choose another report.";
        }
        case "conflict": {
            return "This report has too many linked notifications to delete safely. Clear the linked notifications first and try again.";
        }
        default: {
            return dashboardBrowserFailureMessage(error);
        }
    }
}

interface ReportListItemProps {
    readonly onSelect: (id: string) => void;
    readonly report: ReportSummary;
    readonly selected: boolean;
}

function ReportListItem({ onSelect, report, selected }: ReportListItemProps) {
    return (
        <Button
            aria-current={selected ? "true" : undefined}
            className={cn(
                "border-primary-700 bg-primary-900/45 hover:border-primary-500 w-full rounded-lg border px-3 py-2 text-left transition",
                selected && "border-accent-500 bg-accent-500/10"
            )}
            onClick={() => onSelect(report.id)}
            type="button"
            variant="unstyled"
        >
            <span className="flex min-w-0 items-start justify-between gap-2">
                <span className="min-w-0">
                    <span className="text-primary-100 block truncate text-sm font-medium">
                        {report.title}
                    </span>
                    <span className="text-primary-400 mt-1 block truncate text-xs capitalize">
                        {report.summary ?? reportKindLabel(report.kind)}
                    </span>
                </span>
                <Badge variant={reportStatusVariant(report.status)}>
                    {report.status}
                </Badge>
            </span>
            <time
                className="text-primary-400 mt-2 block text-xs"
                dateTime={new Date(report.occurredAtMs).toISOString()}
            >
                {formatDashboardDateTime(report.occurredAtMs)}
            </time>
        </Button>
    );
}

interface ReportDetailPanelProps {
    readonly id: string;
    readonly onDeleted: () => void;
}

function ReportDetailPanel({ id, onDeleted }: ReportDetailPanelProps) {
    const client = useDashboardTrpcClient();
    const report = useQuery(reportDetailQueryOptions(client, id));
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const deletion = useDeleteReportMutation(onDeleted);
    let errorMessage: string | undefined;
    if (deletion.error !== null) {
        errorMessage = reportDeletionFailureMessage(deletion.error);
    } else if (report.error !== null) {
        errorMessage = dashboardBrowserFailureMessage(report.error);
    }

    if (report.isPending && report.data === undefined) {
        return <PageState label="Loading report…" status="loading" />;
    }
    if (report.data === undefined) {
        return (
            <PageState
                message={dashboardBrowserFailureMessage(report.error)}
                onRetry={() => void report.refetch()}
                retryBusy={report.isFetching}
                status="error"
                title="Report unavailable"
            />
        );
    }

    const detail: ReportDetail = report.data;
    return (
        <Card aria-labelledby="report-detail-heading" className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={reportStatusVariant(detail.status)}>
                            {detail.status}
                        </Badge>
                        <Badge>{reportKindLabel(detail.kind)}</Badge>
                    </div>
                    <Heading
                        className="mt-3 wrap-break-word"
                        id="report-detail-heading"
                        level={2}
                    >
                        {detail.title}
                    </Heading>
                    <Text className="mt-2" tone="muted">
                        {detail.source}
                        {detail.sourceJobId === undefined
                            ? ""
                            : ` · ${detail.sourceJobId}`}{" "}
                        · {formatDashboardDateTime(detail.occurredAtMs)}
                    </Text>
                </div>
                <Button
                    onClick={() => {
                        deletion.reset();
                        setConfirmingDelete(true);
                    }}
                    size="sm"
                    variant="danger"
                >
                    <Icon icon={Trash2} size="sm" tone="inherit" />
                    Delete
                </Button>
            </div>
            <Alert className="mt-4" message={errorMessage} />
            {detail.summary !== undefined && (
                <Text className="border-primary-700 mt-5 border-b pb-5">
                    {detail.summary}
                </Text>
            )}
            <Markdown className="mt-6" source={detail.bodyMarkdown} />
            {Object.keys(detail.metadata).length > 0 && (
                <ExpandableCard className="mt-6" compact title="Report metadata">
                    <pre className="bg-primary-950 text-primary-300 max-h-80 overflow-auto rounded-lg p-3 text-xs">
                        {JSON.stringify(detail.metadata, undefined, 2)}
                    </pre>
                </ExpandableCard>
            )}
            <ConfirmModal
                busy={deletion.isPending}
                confirmLabel="Delete report"
                danger
                description={`Delete “${detail.title}”? Linked notifications for this report will also be deleted.`}
                onCancel={() => setConfirmingDelete(false)}
                onConfirm={() =>
                    deletion.mutate(
                        { id: detail.id },
                        { onError: () => setConfirmingDelete(false) }
                    )
                }
                open={confirmingDelete}
                title="Delete report"
            />
        </Card>
    );
}

/** @returns Filtered, paginated report navigation and one exact Markdown document. */
export function ReportBrowser() {
    const client = useDashboardTrpcClient();
    const navigate = useNavigate({ from: "/reports" });
    const search = parseReportsRouteSearch(useSearch({ from: "/reports" }) as unknown);
    const [kindDraft, setKindDraft] = useState("");
    const [sourceDraft, setSourceDraft] = useState("");
    const [kind, setKind] = useState("");
    const [source, setSource] = useState("");
    const [statusDraft, setStatusDraft] = useState<ReportStatusFilter>("all");
    const [status, setStatus] = useState<ReportStatusFilter>("all");
    const filters: ListReportsInput["filters"] =
        kind === "" && source === "" && status === "all"
            ? undefined
            : {
                  ...(kind === "" ? {} : { kinds: [kind] }),
                  ...(source === "" ? {} : { sources: [source] }),
                  ...(status === "all" ? {} : { statuses: [status] }),
              };
    const query = useInfiniteQuery(reportListQueryOptions(client, filters));
    const reports = uniqueMonitoringRows(
        query.data?.pages.flatMap((page) => page.reports) ?? []
    );
    const selectedId = search.reportId;
    const selectReport = (reportId: string | undefined) => {
        void navigate({
            replace: true,
            search: reportId === undefined ? {} : { reportId },
        });
    };
    const applyFilters = () => {
        setKind(kindDraft.trim());
        setSource(sourceDraft.trim());
        setStatus(statusDraft);
    };
    const resetFilters = () => {
        setKindDraft("");
        setSourceDraft("");
        setKind("");
        setSource("");
        setStatusDraft("all");
        setStatus("all");
    };
    let catalogContent: ReactNode;
    if (query.isPending && query.data === undefined) {
        catalogContent = (
            <div className="p-5">
                <PageState label="Loading reports…" status="loading" />
            </div>
        );
    } else if (query.data === undefined) {
        catalogContent = (
            <div className="p-5">
                <PageState
                    message={dashboardBrowserFailureMessage(query.error)}
                    onRetry={() => void query.refetch()}
                    retryBusy={query.isFetching}
                    status="error"
                    title="Reports unavailable"
                />
            </div>
        );
    } else if (reports.length === 0) {
        catalogContent = (
            <div className="p-5">
                <PageState
                    description="New monitoring reports will appear here."
                    icon={FileText}
                    status="empty"
                    title="No reports"
                />
            </div>
        );
    } else {
        catalogContent = (
            <MonitoringSelectionList
                getKey={(report) => report.id}
                items={reports}
                label="Reports"
                renderItem={(report) => (
                    <ReportListItem
                        onSelect={selectReport}
                        report={report}
                        selected={report.id === selectedId}
                    />
                )}
            />
        );
    }

    return (
        <div>
            <Form
                aria-label="Report filters"
                className="border-primary-700 bg-primary-900/35 grid gap-3 rounded-xl border p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_12rem_auto] md:items-end"
                onSubmit={applyFilters}
            >
                <FormField label="Report type">
                    <Input
                        className="mt-2"
                        maxLength={100}
                        onChange={(event) => setKindDraft(event.currentTarget.value)}
                        placeholder="heartbeat"
                        value={kindDraft}
                    />
                </FormField>
                <FormField label="Source">
                    <Input
                        className="mt-2"
                        maxLength={200}
                        onChange={(event) => setSourceDraft(event.currentTarget.value)}
                        placeholder="openclaw"
                        value={sourceDraft}
                    />
                </FormField>
                <FormField label="Status">
                    <Select
                        className="mt-2"
                        onChange={setStatusDraft}
                        options={reportStatusOptions}
                        value={statusDraft}
                    />
                </FormField>
                <div className="flex min-h-10 items-center gap-2">
                    <Button size="sm" type="submit">
                        <Icon icon={Filter} size="sm" tone="inherit" />
                        Apply
                    </Button>
                    <Button onClick={resetFilters} size="sm" variant="secondary">
                        <Icon icon={RotateCcw} size="sm" tone="inherit" />
                        Reset
                    </Button>
                </div>
            </Form>
            {query.error !== null && query.data !== undefined && (
                <Alert
                    className="mt-4"
                    message={dashboardBrowserFailureMessage(query.error)}
                />
            )}
            <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
                <Card className="min-w-0 p-0">
                    <div className="border-primary-700 border-b px-4 py-3">
                        <div className="flex items-center gap-2">
                            <Icon icon={FileText} tone="accent" />
                            <Heading level={2} size="subsection">
                                Reports
                            </Heading>
                        </div>
                    </div>
                    {catalogContent}
                    {query.hasNextPage && (
                        <div className="border-primary-700 border-t p-3">
                            <Button
                                busy={query.isFetchingNextPage}
                                busyLabel="Loading…"
                                fullWidth
                                onClick={() => void query.fetchNextPage()}
                                size="sm"
                                variant="secondary"
                            >
                                Load older reports
                            </Button>
                        </div>
                    )}
                </Card>
                {selectedId === undefined ? (
                    <PageState
                        description="Choose a report from the list to read it."
                        icon={FileText}
                        status="empty"
                        title="No report selected"
                    />
                ) : (
                    <ReportDetailPanel
                        id={selectedId}
                        key={selectedId}
                        onDeleted={() => selectReport(undefined)}
                    />
                )}
            </div>
        </div>
    );
}
