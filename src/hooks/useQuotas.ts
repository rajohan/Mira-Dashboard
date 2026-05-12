import { useCacheEntry } from "./useCache";

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

export interface SyntheticQuota {
    subscription: {
        limit: number;
        requests: number;
        remaining: number;
        renewsAt: string | null;
        percentUsed: number | null;
    };
    searchHourly: {
        limit: number;
        requests: number;
        remaining: number;
        renewsAt: string | null;
        percentUsed: number | null;
    };
    weeklyTokenLimit: {
        percentRemaining: number;
        nextRegenAt: string | null;
    };
    rollingFiveHourLimit: {
        remaining: number;
        max: number;
        limited: boolean;
        nextTickAt: string | null;
        percentUsed: number | null;
    };
}

export interface QuotasResponse {
    openrouter: OpenRouterQuota | QuotaError;
    elevenlabs: ElevenLabsQuota | QuotaError;
    zai: ZaiQuota | QuotaError;
    synthetic: SyntheticQuota | QuotaError;
    openai: OpenAiQuota | QuotaError;
    checkedAt: number;
    cacheAgeMs: number;
}

export function useQuotas(refreshInterval: number | false = false) {
    const query = useCacheEntry<QuotasResponse>("quotas.summary", refreshInterval);

    return {
        ...query,
        data: query.data?.data,
    };
}

export function hasQuotaStatus(value: unknown): value is QuotaError {
    return (
        typeof value === "object" &&
        value !== null &&
        "status" in value &&
        (value.status === "not_configured" || value.status === "error")
    );
}
