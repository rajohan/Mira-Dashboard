import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "./useApi";

type QuotaStatus = "not_configured" | "error";

interface QuotaError {
    status: QuotaStatus;
    note?: string;
}

export interface OpenRouterQuota {
    usage: number;
    totalCredits: number;
    remaining: number;
    usageMonthly: number;
    percentUsed: number | null;
}

export interface ElevenLabsQuota {
    used: number;
    total: number;
    remaining: number;
    tier: string;
    percentUsed: number | null;
    resetAt: string | null;
}

export interface ZaiQuota {
    level: string;
    fiveHour: {
        usedPercentage: number;
        resetAt: string;
    };
    weekly: {
        usedPercentage: number;
        resetAt: string;
    };
}

export interface OpenAiQuota {
    account: string | null;
    model: string | null;
    fiveHourLeftPercent: number;
    weeklyLeftPercent: number;
    fiveHourReset: string | null;
    weeklyReset: string | null;
    percentUsed: number;
    resetAt: string | null;
}

export interface QuotasResponse {
    openrouter: OpenRouterQuota | QuotaError;
    elevenlabs: ElevenLabsQuota | QuotaError;
    zai: ZaiQuota | QuotaError;
    openai: OpenAiQuota | QuotaError;
    checkedAt: number;
    cacheAgeMs: number;
}

function fetchQuotas() {
    return apiFetch<QuotasResponse>("/quotas");
}

export function useQuotas(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: ["quotas"],
        queryFn: fetchQuotas,
        refetchInterval: refreshInterval,
        staleTime: 2_000,
    });
}

export function hasQuotaStatus(value: unknown): value is QuotaError {
    return (
        typeof value === "object" &&
        value !== null &&
        "status" in value &&
        (value.status === "not_configured" || value.status === "error")
    );
}
