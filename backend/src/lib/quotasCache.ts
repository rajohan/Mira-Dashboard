import { getCacheEntry, parseJsonField } from "./cacheStore.js";

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

export interface QuotaError {
    status: "not_configured" | "error";
    note?: string;
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

export function hasQuotaStatus(value: unknown): value is QuotaError {
    return (
        typeof value === "object" &&
        value !== null &&
        "status" in value &&
        (value.status === "not_configured" || value.status === "error")
    );
}

export async function fetchCachedQuotas(): Promise<QuotasResponse> {
    const row = await getCacheEntry("quotas.summary");
    if (!row || row.status !== "fresh") {
        throw new Error("Quota cache entry not found or not fresh");
    }

    const data = parseJsonField<QuotasResponse>(row.data);
    if (!data) {
        throw new Error("Quota cache payload is invalid");
    }

    return {
        ...data,
        cacheAgeMs: Math.max(Date.now() - data.checkedAt, 0),
    };
}
