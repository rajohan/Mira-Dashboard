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
    limit: number | undefined;
    limitRemaining: number | undefined;
    limitReset: string | undefined;
    usageMonthly: number;
    percentUsed: number | undefined;
}

/** Represents eleven labs quota. */
export interface ElevenLabsQuota {
    used: number;
    total: number;
    remaining: number;
    tier: string;
    percentUsed: number | undefined;
    resetAt: string | undefined;
}

/** Represents open ai quota. */
export interface OpenAiQuota {
    account: string | undefined;
    model: string | undefined;
    fiveHourLeftPercent: number | undefined;
    weeklyLeftPercent: number;
    fiveHourReset: string | undefined;
    weeklyReset: string | undefined;
    percentUsed: number;
    resetAt: string | undefined;
}

/** Represents synthetic quota. */
export interface SyntheticQuota {
    subscription: {
        limit: number;
        requests: number;
        remaining: number;
        renewsAt: string | undefined;
        percentUsed: number | undefined;
    };
    searchHourly: {
        limit: number;
        requests: number;
        remaining: number;
        renewsAt: string | undefined;
        percentUsed: number | undefined;
    };
    weeklyTokenLimit: {
        percentRemaining: number;
        nextRegenAt: string | undefined;
        maxCredits?: string | undefined;
        remainingCredits?: string | undefined;
        nextRegenCredits?: string | undefined;
        nextRegenPercent?: number | undefined;
    };
    rollingFiveHourLimit: {
        remaining: number;
        max: number;
        limited: boolean;
        nextTickAt: string | undefined;
        tickPercent?: number;
        percentUsed: number | undefined;
    };
}

/** Represents the quotas API response. */
export interface QuotasResponse {
    openrouter: OpenRouterQuota | QuotaError;
    elevenlabs: ElevenLabsQuota | QuotaError;
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
    if (!value || typeof value !== "object") {
        return false;
    }

    return (
        "status" in value &&
        (value.status === "not_configured" || value.status === "error")
    );
}
