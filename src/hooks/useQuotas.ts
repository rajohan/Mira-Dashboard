import { useCacheEntry } from "./useCache";

/** Defines quota status. */
type QuotaStatus = "not_configured" | "error";

/** Represents quota error. */
interface QuotaError {
    status: QuotaStatus;
    note?: string;
}

/** Represents open router quota. */
export interface OpenRouterQuota {
    usage: number;
    totalCredits: number;
    remaining: number;
    usageMonthly: number;
    percentUsed: number | null;
}

/** Represents eleven labs quota. */
export interface ElevenLabsQuota {
    used: number;
    total: number;
    remaining: number;
    tier: string;
    percentUsed: number | null;
    resetAt: string | null;
}

/** Represents zai quota. */
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

/** Represents open ai quota. */
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

/** Represents synthetic quota. */
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

/** Represents the quotas API response. */
export interface QuotasResponse {
    openrouter: OpenRouterQuota | QuotaError;
    elevenlabs: ElevenLabsQuota | QuotaError;
    zai: ZaiQuota | QuotaError;
    synthetic: SyntheticQuota | QuotaError;
    openai: OpenAiQuota | QuotaError;
    checkedAt: number;
    cacheAgeMs: number;
}

/** Provides quotas. */
export function useQuotas(refreshInterval: number | false = false) {
    const query = useCacheEntry<QuotasResponse>("quotas.summary", refreshInterval);

    return {
        ...query,
        data: query.data?.data,
    };
}

/** Returns whether quota status is present. */
export function hasQuotaStatus(value: unknown): value is QuotaError {
    return (
        typeof value === "object" &&
        value !== null &&
        "status" in value &&
        (value.status === "not_configured" || value.status === "error")
    );
}
