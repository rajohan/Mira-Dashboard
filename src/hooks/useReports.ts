import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { CreateReportInput, ReportsFilters } from "../../contracts/reports";
import {
    parseCreateReportResponse,
    parseDeleteReportResponse,
    parseReportResponse,
    parseReportsResponse,
} from "../../contracts/reports";
import { refreshPolicy } from "../lib/refreshPolicy";
import { apiDeleteParsed, apiFetchParsed, apiPostParsed } from "./useApi";

const REPORTS_REFRESH_INTERVAL_MS = refreshPolicy.background;

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
            apiFetchParsed(`/reports${reportQueryString(filters)}`, parseReportsResponse),
        refetchInterval: REPORTS_REFRESH_INTERVAL_MS,
        staleTime: 5000,
    });
}

export function useReport(id: number | undefined) {
    return useQuery({
        enabled: id !== undefined,
        queryKey: reportKeys.detail(id),
        queryFn: () => apiFetchParsed(`/reports/${id}`, parseReportResponse),
        refetchInterval: REPORTS_REFRESH_INTERVAL_MS,
        staleTime: 5000,
    });
}

export function useCreateReport() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (payload: CreateReportInput) =>
            apiPostParsed("/reports", parseCreateReportResponse, payload),
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
            apiDeleteParsed(`/reports/${id}`, parseDeleteReportResponse),
        onSuccess: (_data, id) => {
            queryClient.removeQueries({ exact: true, queryKey: reportKeys.detail(id) });
            void queryClient.invalidateQueries({ queryKey: reportKeys.all });
        },
    });
}
