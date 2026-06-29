import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDeleteRequired, apiFetchRequired, apiPostRequired } from "./useApi";

export type ReportType = "daily_brief" | "daily_summary" | "heartbeat" | "custom";
export type ReportStatus = "ok" | "warning" | "error";

export interface ReportItem {
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

interface ReportsResponse {
    items: ReportItem[];
}

interface ReportResponse {
    report: ReportItem;
}

interface CreateReportInput {
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

interface ReportsFilters {
    status?: ReportStatus;
    type?: ReportType;
}

export const reportKeys = {
    all: ["reports"] as const,
    detail: (id: number | undefined) => ["reports", "detail", id] as const,
    list: (filters: ReportsFilters = {}) => ["reports", "list", filters] as const,
};

function reportQueryString(filters: ReportsFilters): string {
    const parameters = new URLSearchParams();
    if (filters.type) parameters.set("type", filters.type);
    if (filters.status) parameters.set("status", filters.status);
    const query = parameters.toString();
    return query ? `?${query}` : "";
}

export function useReports(filters: ReportsFilters = {}) {
    return useQuery({
        queryKey: reportKeys.list(filters),
        queryFn: () =>
            apiFetchRequired<ReportsResponse>(`/reports${reportQueryString(filters)}`),
        staleTime: 5000,
    });
}

export function useReport(id: number | undefined) {
    return useQuery({
        enabled: id !== undefined,
        queryKey: reportKeys.detail(id),
        queryFn: () => apiFetchRequired<ReportResponse>(`/reports/${id}`),
        staleTime: 5000,
    });
}

export function useCreateReport() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (payload: CreateReportInput) =>
            apiPostRequired<{ isOk: boolean; report: ReportItem }>("/reports", payload),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: reportKeys.all });
            void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        },
    });
}

export function useDeleteReport() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: number) =>
            apiDeleteRequired<{ deleted: number; isOk: boolean }>(`/reports/${id}`),
        onSuccess: (_data, id) => {
            queryClient.removeQueries({ exact: true, queryKey: reportKeys.detail(id) });
            void queryClient.invalidateQueries({ queryKey: reportKeys.all });
        },
    });
}
