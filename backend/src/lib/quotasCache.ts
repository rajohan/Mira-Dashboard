import { getCacheEntry, parseJsonField } from "./cacheStore.js";

/** Describes open router quota. */
export interface OpenRouterQuota {
    usage: number;
    totalCredits: number;
    remaining: number;
    usageMonthly: number;
    percentUsed: number | null;
}

/** Describes eleven labs quota. */
export interface ElevenLabsQuota {
    used: number;
    total: number;
    remaining: number;
    tier: string;
    percentUsed: number | null;
    resetAt: string | null;
}

/** Describes zai quota. */
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

/** Describes open ai quota. */
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

/** Describes synthetic quota. */
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

/** Describes quota error. */
export interface QuotaError {
    status: "not_configured" | "error";
    note?: string;
}

/** Describes quotas response. */
export interface QuotasResponse {
    openrouter: OpenRouterQuota | QuotaError;
    elevenlabs: ElevenLabsQuota | QuotaError;
    zai: ZaiQuota | QuotaError;
    synthetic: SyntheticQuota | QuotaError;
    openai: OpenAiQuota | QuotaError;
    checkedAt: number;
    cacheAgeMs: number;
}

/** Handles has quota status. */
export function hasQuotaStatus(value: unknown): value is QuotaError {
    return (
        typeof value === "object" &&
        value !== null &&
        "status" in value &&
        (value.status === "not_configured" || value.status === "error")
    );
}

/** Handles fetch cached quotas. */
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
